import "server-only";
import { z } from "zod";
import { domainExcludable } from "@/lib/collector/triage";
import { PREFECTURE_LIST } from "@/lib/geo";
import { appendSourceUrl } from "@/lib/server/collector/run";
import { excludeCandidates, USER_EXCLUDED, type ExcludeSnapshot } from "@/lib/server/collector/review-actions";
import { checkChainAliases } from "@/lib/chain-alias";
import { normalizeAlias } from "@/lib/masters";
import type { Db } from "@/lib/server/lottery-service";

/**
 * 候補を除外理由つきで除外する（Stage 7H）。理由は6種類。
 *   region=地域・店舗 / untrusted=信頼性なし / area_chain=エリア外系列 / duplicate=重複 / other_game=別ゲーム / other=その他（学習しない）
 * 候補は物理削除せず（status=excluded / duplicate）、除外の履歴（collection_exclusion_log）を必ず残す。
 * 将来の自動収集に使うルールは、利用者がここで明示的に確定したものだけ作り、履歴とは別に管理する（collection_rules / 既存の collection_exclusions）。
 * 根拠が足りない指定（マスター未登録の系列で系列ルールなど）は、広い除外にならないよう拒否する。
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- 新しい表は生成型に無い場合がある
const any = (db: Db) => db as any;
const uuid = z.uuid();
const text = (n: number) => z.string().trim().max(n);

export const excludeInputSchema = z.discriminatedUnion("reason", [
  z.object({
    reason: z.literal("region"),
    chainId: uuid.nullable().optional(),
    chainName: text(120).default(""),
    storeId: uuid.nullable().optional(),
    storeName: text(120).default(""),
    prefecture: text(20).default(""),
    city: text(40).default(""),
    note: text(500).default(""),
  }),
  // 信頼性なし: 系列（key=系列ID。未特定なら chainName から系列マスター・別名と照合。未登録なら registerChain で仮登録）／情報元（Xアカウント・サイト）
  z.object({ reason: z.literal("untrusted"), target: z.enum(["chain", "x_account", "domain"]), key: text(300).default(""), label: text(120).default(""), note: text(500).default(""), chainName: text(120).optional(), registerChain: z.boolean().optional() }),
  z.object({ reason: z.literal("area_chain"), chainId: uuid, chainName: text(120).default(""), note: text(500).default("") }),
  // 重複: 統合先（登録済みの抽選か、確認待ちの候補）。matchReason=画面で示した判定の理由（履歴に残す）。registerChainAlias=重複の原因が系列名の表記揺れのとき、利用者が確定した別名の登録
  z.object({ reason: z.literal("duplicate"), target: z.object({ kind: z.enum(["lottery", "candidate"]), id: uuid }), matchReason: text(200).optional(), registerChainAlias: z.object({ chainId: uuid, alias: text(80) }).optional() }),
  z.object({ reason: z.literal("other_game"), keywords: z.array(text(40)).min(1).max(10), note: text(500).default("") }),
  z.object({ reason: z.literal("other") }),
]);
export type ExcludeInput = z.input<typeof excludeInputSchema>;

export interface RuleRef {
  table: "collection_rules" | "collection_exclusions";
  id: string;
  /** この操作で新しく作った（取り消しで無効にしてよい）。既存のルールを再利用しただけなら false */
  created: boolean;
}
export type ExcludeOutcome = { ok: true; prev: ExcludeSnapshot[]; rule: RuleRef | null; reason: string; note?: string } | { ok: false; error: string };

const fail = (error: string): { ok: false; error: string } => ({ ok: false, error });
const STORE_DIFFERS = "店舗が異なる抽選は、店舗ごとに独立した別の抽選のため、重複として統合できません";

export async function excludeWithReason(db: Db, householdId: string, candidateId: string, actor: string | null, raw: ExcludeInput): Promise<ExcludeOutcome> {
  const parsed = excludeInputSchema.safeParse(raw);
  if (!parsed.success || !uuid.safeParse(candidateId).success || (actor !== null && !uuid.safeParse(actor).success)) return fail("入力内容を確認してください");
  const input = parsed.data;
  const { data: cand } = await db.from("collection_candidates").select("id,status,source_url,dedupe_key,title,draft").eq("id", candidateId).maybeSingle();
  if (!cand) return fail("候補が見つかりません");
  if (cand.status === "auto_registered") return fail("登録済みの候補は除外できません");

  // ---- 1) ルールの検証と作成（候補の除外より前に検証だけ行う。作成は除外の後）
  type Plan = { kind: "none" } | { kind: "rule"; row: Record<string, unknown>; dedupe: { col: string; val: string }[] } | { kind: "source"; row: Record<string, unknown>; createChain?: string };
  let plan: Plan = { kind: "none" };
  let dupLottery: string | null = null;
  let dupCandidate: string | null = null;
  const candStoreId = ((cand.draft as { input?: { store?: { id?: string | null } } } | null)?.input?.store?.id ?? null) as string | null;
  // 系列名の別名登録（重複の原因が表記揺れのとき。利用者が確定したものだけ。他の系列の名称・別名と衝突する場合は登録しない）
  let aliasToAdd: { chainId: string; alias: string } | null = null;
  if (input.reason === "duplicate" && input.registerChainAlias) {
    const { chainId, alias } = input.registerChainAlias;
    const [{ data: chains }, { data: als }] = await Promise.all([db.from("chains").select("id,name"), any(db).from("chain_aliases").select("chain_id,alias")]);
    const own = (chains ?? []).find((c) => c.id === chainId);
    if (!own) return fail("別名を登録する系列が見つかりません");
    const mine = ((als ?? []) as { chain_id: string; alias: string }[]).filter((a) => a.chain_id === chainId).map((a) => a.alias);
    const checked = checkChainAliases(chainId, own.name, [...mine, alias], chains ?? [], ((als ?? []) as { chain_id: string; alias: string }[]).map((a) => ({ chainId: a.chain_id, alias: a.alias })));
    if (checked.problems.length > 0) return fail(checked.problems[0].message);
    if (checked.values.some((v) => normalizeAlias(v) === normalizeAlias(alias)) && !mine.some((m) => normalizeAlias(m) === normalizeAlias(alias))) aliasToAdd = { chainId, alias };
  }

  if (input.reason === "region") {
    if (!input.storeId && !input.storeName) return fail("店舗名を入力してください");
    if (input.prefecture && !(PREFECTURE_LIST as readonly string[]).includes(input.prefecture)) return fail("都道府県が正しくありません");
    plan = { kind: "rule", row: { kind: "region_store", label: [input.chainName, input.storeName].filter(Boolean).join(" ").slice(0, 120), chain_id: input.chainId ?? null, store_id: input.storeId ?? null, chain_name: input.chainName, store_name: input.storeName, prefecture: input.prefecture, city: input.city, note: input.note }, dedupe: input.storeId ? [{ col: "store_id", val: input.storeId }] : [{ col: "store_name", val: input.storeName }] };
  } else if (input.reason === "area_chain") {
    plan = { kind: "rule", row: { kind: "area_chain", label: input.chainName.slice(0, 120), chain_id: input.chainId, chain_name: input.chainName, note: input.note }, dedupe: [{ col: "chain_id", val: input.chainId }] };
  } else if (input.reason === "other_game") {
    const kws = [...new Set(input.keywords.map((k) => k.trim()).filter((k) => k.length >= 2))].slice(0, 10);
    if (kws.length === 0) return fail("除外するキーワードを2文字以上で入力してください");
    plan = { kind: "rule", row: { kind: "other_game", label: kws.join("・").slice(0, 120), keywords: kws, note: input.note }, dedupe: [] };
  } else if (input.reason === "untrusted") {
    let chainKey = input.key;
    let createChain: string | undefined;
    if (input.target === "chain") {
      // 系列ID → 系列名・別名の順に、系列マスターと照合する（本文に系列名があるだけの別の系列は対象にしない。確定は利用者）
      const { data: chains } = await db.from("chains").select("id,name");
      if (uuid.safeParse(chainKey).success) {
        if (!(chains ?? []).some((c) => c.id === chainKey)) return fail("系列が見つかりません");
      } else {
        const name = (input.chainName ?? input.label).trim();
        if (!name) return fail("除外する系列を特定できません。情報源（Xアカウント・サイト）で除外してください");
        const { data: als } = await any(db).from("chain_aliases").select("chain_id,alias");
        const key = normalizeAlias(name);
        const hit = (chains ?? []).find((c) => normalizeAlias(c.name) === key)?.id ?? ((als ?? []) as { chain_id: string; alias: string }[]).find((a) => normalizeAlias(a.alias) === key)?.chain_id;
        if (hit) chainKey = hit;
        else if (input.registerChain) createChain = name;
        else return fail("この系列は系列マスターに未登録です。系列マスターに登録して除外するか、情報源（Xアカウント・サイト）で除外してください");
      }
    }
    if (input.target === "x_account" && !/^[A-Za-z0-9_]{1,15}$/.test(input.key.replace(/^@/, ""))) return fail("Xアカウント名が正しくありません");
    if (input.target === "domain" && !domainExcludable(input.key.toLowerCase())) return fail("X・まとめサイト・短縮URL・共通の応募サービス全体は除外できません");
    const key = input.target === "x_account" ? input.key.replace(/^@/, "") : input.target === "domain" ? input.key.toLowerCase() : chainKey;
    plan = { kind: "source", createChain, row: { household_id: householdId, scope: input.target, key, label: (input.label || input.chainName || "").slice(0, 120), chain_id: input.target === "chain" && !createChain ? key : null, reason_code: "untrusted_shop", reason_note: input.note, created_by_profile_id: actor } };
  } else if (input.reason === "duplicate") {
    if (input.target.kind === "lottery") {
      const { data: l } = await db.from("lotteries").select("id,store_id").eq("id", input.target.id).maybeSingle();
      if (!l) return fail("重複先の抽選が見つかりません");
      // 店舗が異なる抽選は、店舗ごとに独立した応募が必要な別の抽選として扱う（誤統合しない）
      if (candStoreId && l.store_id && candStoreId !== l.store_id) return fail(STORE_DIFFERS);
      dupLottery = l.id;
    } else {
      if (input.target.id === candidateId) return fail("同じ候補は重複先にできません");
      const { data: t } = await db.from("collection_candidates").select("id,draft").eq("id", input.target.id).maybeSingle();
      if (!t) return fail("重複先の候補が見つかりません");
      const tStore = ((t.draft as { input?: { store?: { id?: string | null } } } | null)?.input?.store?.id ?? null) as string | null;
      if (candStoreId && tStore && candStoreId !== tStore) return fail(STORE_DIFFERS);
      dupCandidate = t.id;
    }
  }

  // ---- 2) 候補の除外（重複は status=duplicate）。取り消し用に直前の状態を返す
  let prev: ExcludeSnapshot[] = [];
  const label = { region: "地域・店舗", untrusted: "信頼性なし", area_chain: "エリア外系列", duplicate: "重複", other_game: "別ゲーム", other: "その他" }[input.reason];
  if (input.reason === "duplicate") {
    const snap = await db.from("collection_candidates").select("id,status,job_state,triage,triage_reason,manual_state,reasons,resolved_at,completed_at,next_run_at,lottery_id").eq("id", candidateId).maybeSingle();
    if (!snap.data) return fail("候補が見つかりません");
    prev = [{ id: candidateId, prev: { status: snap.data.status, job_state: snap.data.job_state, triage: snap.data.triage, triage_reason: snap.data.triage_reason ?? "", manual_state: snap.data.manual_state, reasons: snap.data.reasons, resolved_at: snap.data.resolved_at, completed_at: snap.data.completed_at, next_run_at: snap.data.next_run_at, lottery_id: snap.data.lottery_id } }];
    const now = new Date().toISOString();
    // 重複元の情報源URL・投稿IDは削除せず、統合先に参照情報として残す（別々の抽選を誤統合しないよう、統合先は利用者が選んだものだけ）
    if (dupLottery && cand.source_url) await appendSourceUrl(db, dupLottery, cand.source_url);
    if (dupCandidate) {
      const { data: t } = await db.from("collection_candidates").select("draft").eq("id", dupCandidate).maybeSingle();
      const d = (t?.draft as Record<string, unknown> | null) ?? {};
      const seen = Array.isArray(d.alsoSeen) ? (d.alsoSeen as unknown[]) : [];
      await db.from("collection_candidates").update({ draft: { ...d, alsoSeen: [...seen, { candidateId, url: cand.source_url, dedupeKey: cand.dedupe_key, at: now }].slice(-20) } as never }).eq("id", dupCandidate);
    }
    const { error } = await db.from("collection_candidates").update({ status: "duplicate", job_state: "completed", lottery_id: dupLottery, reasons: [USER_EXCLUDED, "除外理由: 重複"], resolved_at: now, completed_at: now, lease_until: null, locked_by: null }).eq("id", candidateId).neq("status", "auto_registered");
    if (error) return fail("除外できませんでした");
  } else {
    const r = await excludeCandidates(db, [candidateId]);
    if (!r.ok || r.excluded === 0) return fail("除外できませんでした（登録済みの候補は除外できません）");
    prev = r.prev;
    await db.from("collection_candidates").update({ reasons: [USER_EXCLUDED, `除外理由: ${label}`] }).eq("id", candidateId);
  }

  // ---- 3) ルールの作成（同じ内容の有効なルールがあれば再利用）。失敗したら候補を元に戻す
  let rule: RuleRef | null = null;
  try {
    if (plan.kind === "rule") {
      let q = any(db).from("collection_rules").select("id").eq("household_id", householdId).eq("kind", plan.row.kind as string).eq("active", true);
      for (const d of plan.dedupe) q = q.eq(d.col, d.val);
      const existing = plan.dedupe.length > 0 ? (await q.limit(1).maybeSingle()).data : null;
      if (existing) rule = { table: "collection_rules", id: existing.id, created: false };
      else {
        const { data, error } = await any(db).from("collection_rules").insert({ household_id: householdId, source_candidate_id: candidateId, created_by_profile_id: actor, ...plan.row }).select("id").single();
        if (error) throw error;
        rule = { table: "collection_rules", id: data.id, created: true };
      }
    } else if (plan.kind === "source") {
      if (plan.createChain) {
        // 系列マスターに仮登録してから、その系列を除外する（名称の照合は上で済み。未登録のときだけ）
        const made = await db.from("chains").insert({ household_id: householdId, name: plan.createChain, is_provisional: true, updated_by_profile_id: actor }).select("id").single();
        if (made.error || !made.data) throw made.error ?? new Error("chain");
        plan.row.key = made.data.id;
        plan.row.chain_id = made.data.id;
      }
      const { data, error } = await any(db).from("collection_exclusions").insert(plan.row).select("id").single();
      if (error && error.code === "23505") {
        const ex = await any(db).from("collection_exclusions").select("id").eq("household_id", householdId).eq("scope", plan.row.scope as string).eq("key", plan.row.key as string).eq("active", true).maybeSingle();
        if (!ex.data) throw error;
        rule = { table: "collection_exclusions", id: ex.data.id, created: false };
      } else if (error) throw error;
      else rule = { table: "collection_exclusions", id: data.id, created: true };
    }
  } catch {
    await restoreCandidate(db, prev);
    return fail("除外ルールを保存できなかったため、除外を取り消しました");
  }

  // 系列の別名（重複の原因が表記揺れのとき）。失敗しても除外は有効（別名だけ登録できなかった旨を返す）
  let aliasNote: string | null = null;
  if (aliasToAdd) {
    const { error: aErr } = await any(db).from("chain_aliases").insert({ household_id: householdId, chain_id: aliasToAdd.chainId, alias: aliasToAdd.alias, normalized_alias: normalizeAlias(aliasToAdd.alias), updated_by_profile_id: actor });
    if (aErr && aErr.code !== "23505") aliasNote = "重複として処理しましたが、系列の別名は登録できませんでした";
  }

  // ---- 4) 履歴（追記のみ）
  const detail: Record<string, unknown> = { ...(input as Record<string, unknown>), title: cand.title, sourceUrl: cand.source_url };
  const { error: logErr } = await any(db).from("collection_exclusion_log").insert({ household_id: householdId, candidate_id: candidateId, reason_code: input.reason, detail, rule_table: rule?.table ?? null, rule_id: rule?.id ?? null, duplicate_lottery_id: dupLottery, duplicate_candidate_id: dupCandidate, created_by_profile_id: actor });
  if (logErr) {
    // 履歴を残せないまま、広い除外を有効にしない
    if (rule?.created) await deactivateRule(db, rule);
    await restoreCandidate(db, prev);
    return fail("除外の履歴を保存できなかったため、除外を取り消しました");
  }
  return { ok: true, prev, rule, reason: input.reason, ...(aliasNote ? { note: aliasNote } : {}) };
}

async function restoreCandidate(db: Db, prev: ExcludeSnapshot[]): Promise<void> {
  const allowed = ["status", "job_state", "triage", "triage_reason", "manual_state", "reasons", "resolved_at", "completed_at", "next_run_at", "lottery_id"];
  for (const it of prev) await db.from("collection_candidates").update(Object.fromEntries(Object.entries(it.prev).filter(([k]) => allowed.includes(k))) as never).eq("id", it.id);
}

/** 除外の取り消し時、この操作で作ったルールを無効にする（既存のルールを再利用しただけの場合は触れない） */
export async function deactivateRule(db: Db, rule: RuleRef): Promise<void> {
  if (!rule.created) return;
  const patch = { active: false, released_at: new Date().toISOString() };
  await any(db).from(rule.table).update(rule.table === "collection_rules" ? { ...patch, updated_at: patch.released_at } : patch).eq("id", rule.id);
}
