import "server-only";
import type { AgentLLM, AgentUsage } from "@/lib/agent/core";
import { isPlausiblePeer, pairKey } from "@/lib/agent/lottery-grouping/compare";
import { auditGroup, type GroupAudit, type ProposalAudit } from "@/lib/agent/lottery-grouping/audit";
import { parseGroupingProposal } from "@/lib/agent/lottery-grouping/proposal";
import { evaluateGrouping, type GroupingOutcome } from "@/lib/agent/lottery-grouping/run";
import type { GGroup, GLottery, GroupOrigin, GWorld, Tier } from "@/lib/agent/lottery-grouping/types";
import { verifyProposal } from "@/lib/agent/lottery-grouping/verify";
import { dbToFlex } from "@/lib/lottery-input";
import type { PageFetcher } from "@/lib/agent/store-location/tools";
import { mapDbError, resolveProposal, type Db } from "@/lib/server/lottery-service";
import { loadSourceSnapshotTexts, saveSourceSnapshots, snapshotsOfFetched } from "@/lib/server/agent/source-snapshots";

/**
 * 抽選グループのAI判定の読み書き（Stage 8F）。認証済み(RLS適用)のクライアント、または自動収集の service_role のクライアントを受け取る。
 *  - 判定の入力（事実）は、世帯のデータから読み取る（AIの出力ではない）。
 *  - 保存するのは専用の表（lottery_group_proposals）への提案と、グループ化の実行（DB関数 resolve_lottery_group_proposal_*）だけ。
 *    **店舗ごとの抽選・応募・当選・購入・通知・期限・店舗マスターは更新しない**（このファイルに lotteries / applications / stores への update は無い）。
 *  - AI の出力は SQL にもコードにもならない。ここで受け取るのは、検証層（verifyProposal）を通した構造化データだけ。
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- 新しい表・関数は生成型に無い
const any = (db: Db) => db as any;

const LOTTERY_COLS =
  "id,chain_id,store_id,store_mode,campaign_id,apply_start_precision,apply_start_date,apply_start_at,apply_deadline_precision,apply_deadline_date,apply_deadline_at,result_precision,result_date,result_at,apply_method,receive_method,lottery_kind,requirement_tags,requirement_logic,conditions_text,source_urls,bulk_group_id,archived_at,created_at";
const MAX_PEERS = 400;
const MAX_EVIDENCE_LOTTERIES = 60;

interface Row {
  id: string; chain_id: string; store_id: string | null; store_mode: string | null; campaign_id: string | null;
  apply_start_precision: string; apply_start_date: string | null; apply_start_at: string | null;
  apply_deadline_precision: string; apply_deadline_date: string | null; apply_deadline_at: string | null;
  result_precision: string; result_date: string | null; result_at: string | null;
  apply_method: string; receive_method: string; lottery_kind: string | null; requirement_tags: string[] | null; requirement_logic: string | null;
  conditions_text: string | null; source_urls: string[] | null; bulk_group_id: string | null; archived_at: string | null; created_at: string;
}

/** `.in()` の長い一覧を分割して問い合わせる（URLが長くなりすぎないように） */
async function inChunks<T>(ids: string[], run: (chunk: string[]) => Promise<T[]>): Promise<T[]> {
  const out: T[] = [];
  for (let i = 0; i < ids.length; i += 100) out.push(...(await run(ids.slice(i, i + 100))));
  return out;
}

/** 情報源の文章: 収集時に保存した候補の下書き（X投稿・引用元・AIの要約・項目別の根拠）から取り出す。外部由来のデータ */
function textsOfDraft(draft: unknown): string[] {
  if (!draft || typeof draft !== "object") return [];
  const d = draft as { xpost?: { text?: unknown; quoted?: { text?: unknown } }; summary?: unknown; evidence?: Record<string, { quote?: unknown }> };
  const out: string[] = [];
  const push = (v: unknown) => {
    if (typeof v === "string" && v.trim()) out.push(v.trim().slice(0, 2000));
  };
  push(d.xpost?.text);
  push(d.xpost?.quoted?.text);
  push(d.summary);
  for (const v of Object.values(d.evidence ?? {})) push(v?.quote);
  return out;
}

export async function loadGroupingWorld(db: Db, householdId: string, lotteryId: string): Promise<GWorld | null> {
  const a = any(db);
  const { data: s } = await a.from("lotteries").select(LOTTERY_COLS).eq("id", lotteryId).eq("household_id", householdId).maybeSingle();
  if (!s) return null;
  const subjectRow = s as Row;
  const { data: others } = await a.from("lotteries").select(LOTTERY_COLS).eq("household_id", householdId).eq("chain_id", subjectRow.chain_id).is("archived_at", null).neq("id", lotteryId).order("created_at", { ascending: false }).limit(MAX_PEERS);
  const rows: Row[] = [subjectRow, ...((others ?? []) as Row[])];
  const ids = rows.map((r) => r.id);

  const [items, storeRows, appRows] = await Promise.all([
    inChunks(ids, async (c) => (await a.from("lottery_items").select("lottery_id,product_id,quantity,unit").in("lottery_id", c)).data ?? []),
    inChunks([...new Set(rows.map((r) => r.store_id).filter((x): x is string => !!x))], async (c) => (await a.from("stores").select("id,name").in("id", c)).data ?? []),
    inChunks(ids, async (c) => (await a.from("applications").select("lottery_id").in("lottery_id", c)).data ?? []),
  ]);
  const itemsBy = new Map<string, GLottery["items"]>();
  for (const i of items as { lottery_id: string; product_id: string; quantity: number; unit: string }[]) itemsBy.set(i.lottery_id, [...(itemsBy.get(i.lottery_id) ?? []), { productId: i.product_id, quantity: i.quantity, unit: i.unit }]);
  const storeName = new Map((storeRows as { id: string; name: string }[]).map((x) => [x.id, x.name]));
  const applied = new Set((appRows as { lottery_id: string }[]).map((x) => x.lottery_id));
  const toG = (r: Row): GLottery => ({
    id: r.id, chainId: r.chain_id, storeId: r.store_id, storeName: r.store_id ? storeName.get(r.store_id) ?? "" : "",
    storeMode: (["fixed", "select_on_apply", "none"].includes(r.store_mode ?? "") ? r.store_mode : "fixed") as GLottery["storeMode"],
    items: itemsBy.get(r.id) ?? [], campaignId: r.campaign_id,
    applyStart: dbToFlex(r.apply_start_precision, r.apply_start_date, r.apply_start_at),
    applyDeadline: dbToFlex(r.apply_deadline_precision, r.apply_deadline_date, r.apply_deadline_at),
    resultDate: dbToFlex(r.result_precision, r.result_date, r.result_at),
    applyMethod: r.apply_method, receiveMethod: r.receive_method, kind: r.lottery_kind && r.lottery_kind !== "normal" ? r.lottery_kind : null,
    requirementTags: r.requirement_tags ?? [], requirementLogic: r.requirement_logic, conditionsText: r.conditions_text ?? "", sourceUrls: r.source_urls ?? [],
    groupId: r.bulk_group_id, archived: !!r.archived_at, hasApplication: applied.has(r.id), createdAt: r.created_at,
  });
  const subject = toG(subjectRow);
  const lotteries = rows.slice(1).map(toG);

  // 情報源の文章・商品名・グループ・過去の判断（手動で分けた組・提案の記録）
  const evidenceIds = [subject.id, ...lotteries.filter((l) => isPlausiblePeer(subject, l)).map((l) => l.id)].slice(0, MAX_EVIDENCE_LOTTERIES);
  const productIds = [...new Set([...itemsBy.values()].flat().map((i) => i.productId))];
  const [cands, prods, groupRows, events, proposals] = await Promise.all([
    inChunks(evidenceIds, async (c) => (await a.from("collection_candidates").select("lottery_id,draft").in("lottery_id", c)).data ?? []),
    inChunks(productIds, async (c) => (await a.from("products").select("id,official_name").in("id", c)).data ?? []),
    a.from("lottery_bulk_groups").select("id,chain_id,title,origin").eq("household_id", householdId).is("dissolved_at", null).eq("chain_id", subject.chainId).limit(2000),
    inChunks(evidenceIds, async (c) => (await a.from("lottery_group_events").select("lottery_id,detail").eq("action", "removed").eq("origin", "manual").in("lottery_id", c)).data ?? []),
    a.from("lottery_group_proposals").select("proposal_key,status,subject_lottery_id,lottery_ids").eq("household_id", householdId).or(`subject_lottery_id.eq.${lotteryId},lottery_ids.cs.{${lotteryId}}`).limit(500),
  ]);
  const evidence = new Map<string, string[]>();
  for (const c of cands as { lottery_id: string; draft: unknown }[]) evidence.set(c.lottery_id, [...(evidence.get(c.lottery_id) ?? []), ...textsOfDraft(c.draft)].slice(0, 6));
  // 保存済みの情報源（手動登録・AIが取得したページなど。マイグレーション100。表が無ければ空）。収集時の下書きと合わせる（同じ文章は1つ）
  const snaps = await loadSourceSnapshotTexts(db, evidenceIds);
  for (const [id, texts] of snaps) evidence.set(id, [...new Set([...(evidence.get(id) ?? []), ...texts])].slice(0, 8));
  const productNames = new Map((prods as { id: string; official_name: string }[]).map((p) => [p.id, p.official_name]));
  const live = [subject, ...lotteries].filter((l) => !l.archived);
  const members = new Map<string, string[]>();
  for (const l of live) if (l.groupId) members.set(l.groupId, [...(members.get(l.groupId) ?? []), l.id]);
  const groups: GGroup[] = ((groupRows.data ?? []) as { id: string; chain_id: string | null; title: string; origin: string }[]).map((g) => ({
    id: g.id, chainId: g.chain_id, title: g.title,
    origin: (["bulk_registration", "manual", "save_and_duplicate", "duplicate", "ai"].includes(g.origin) ? g.origin : "manual") as GroupOrigin,
    memberIds: members.get(g.id) ?? [],
  }));

  // 手動で分けた組: 利用者が外した／グループ全体を解除したときに記録された「そのとき同じグループにいた抽選」。および却下・実行後に解除された提案の組
  const candidateIds = new Set(ids);
  const separated = new Set<string>();
  for (const e of events as { lottery_id: string; detail: { reason?: string; wasWith?: unknown } | null }[]) {
    if (e.detail?.reason === "group_too_small" || !Array.isArray(e.detail?.wasWith)) continue;
    for (const w of e.detail!.wasWith as string[]) if (candidateIds.has(w) && w !== e.lottery_id) separated.add(pairKey(e.lottery_id, w));
  }
  const { data: dead } = await a.from("lottery_group_proposals").select("subject_lottery_id,lottery_ids").eq("household_id", householdId).in("status", ["rejected", "reverted"]).in("kind", ["new_group", "add_to_group"]).overlaps("lottery_ids", evidenceIds).limit(500);
  for (const p of (dead ?? []) as { subject_lottery_id: string; lottery_ids: string[] }[]) {
    const all = [...new Set([...p.lottery_ids, p.subject_lottery_id])].filter((x) => candidateIds.has(x));
    for (let i = 0; i < all.length; i++) for (let j = i + 1; j < all.length; j++) separated.add(pairKey(all[i], all[j]));
  }
  const knownKeys = new Map<string, string>(((proposals.data ?? []) as { proposal_key: string; status: string }[]).map((p) => [p.proposal_key, p.status]));
  return { subject, lotteries, groups, evidence, separated, knownKeys, productNames };
}

// ---------------------------------------------------------------- 実行
export interface GroupingRunOptions {
  llm: AgentLLM;
  /** 自動グループ化を許可するか（開発環境の設定。検証層が auto と判定した提案だけが実行される） */
  allowAuto: boolean;
  /** 自動収集（service_role）から呼ぶか。true のとき、グループ化は service_role 専用の入口（*_as）で、世帯のメンバーとして実行する */
  asService: boolean;
  actor: string | null;
  followUps?: number;
  /** 登録された情報源URLの本文を取得する部品（開発環境の調査用）。渡すとAIが fetch_source_page で根拠を集められる。取得したページは情報源として保存される */
  fetcher?: PageFetcher;
}
export type GroupingStatus = "applied" | "pending" | "dismissed" | "skipped" | "superseded" | "error";
export interface GroupingResult {
  status: GroupingStatus;
  proposalId: string | null;
  groupId: string | null;
  tier: Tier | null;
  kind: string | null;
  ranAgent: boolean;
  skipReason: string | null;
  message: string;
  usage: AgentUsage | null;
  outcome: GroupingOutcome | null;
}

const empty = (status: GroupingStatus, message: string, extra: Partial<GroupingResult> = {}): GroupingResult => ({ status, proposalId: null, groupId: null, tier: null, kind: null, ranAgent: false, skipReason: null, message, usage: null, outcome: null, ...extra });

/** 1件の抽選について、グループ化の判断をする。保存・（自動なら）実行まで行う。例外を投げない */
export async function runLotteryGrouping(db: Db, householdId: string, lotteryId: string, opts: GroupingRunOptions): Promise<GroupingResult> {
  try {
    const world = await loadGroupingWorld(db, householdId, lotteryId);
    if (!world) return empty("skipped", "抽選が見つかりません");
    if (world.subject.archived) return empty("skipped", "除外・取り下げ済みの抽選は判定しない");
    const outcome = await evaluateGrouping(world, { llm: opts.llm, allowAuto: opts.allowAuto, followUps: opts.followUps, fetcher: opts.fetcher });
    // AIが取得したページは、情報源として保存する（追跡できるように。次回の判定の入力にもなる。重複・表が無い場合は何もしない）
    const fetchedAll = [...(world.fetched?.values() ?? [])].flat();
    if (fetchedAll.length > 0) await saveSourceSnapshots(db, householdId, snapshotsOfFetched(fetchedAll));
    const d = outcome.decision;
    if (!outcome.ranAgent && outcome.skipped === "no_candidates") return empty("skipped", "比較する抽選が無い（単独）", { tier: d.tier, kind: d.kind, outcome });
    if (d.skipReason) return empty("skipped", d.skipReason, { tier: d.tier, kind: d.kind, ranAgent: outcome.ranAgent, skipReason: d.skipReason, usage: outcome.usage, outcome });

    // 提案の保存（同じ組は一意キーで1件だけ。同時実行・再収集でも二重に作らない）
    const a = any(db);
    const status = d.tier === "auto" || d.tier === "suggest" ? "pending" : "dismissed";
    const row = {
      household_id: householdId, proposal_key: d.key, kind: d.kind, status, tier: d.tier, subject_lottery_id: lotteryId, lottery_ids: d.lotteryIds, target_group_id: d.targetGroupId,
      confidence: d.confidence, rationale: d.rationale, common: d.common, mismatches: d.mismatches, missing: d.missing,
      evidence: { strongSignals: d.strongSignals, downgrades: d.downgrades, basis: d.basis, followUps: outcome.followUps, ai: outcome.ranAgent, sources: fetchedAll.map((f) => ({ lotteryId: f.lotteryId, url: f.url, fetchedAt: f.fetchedAt, hash: f.hash, identifiers: f.identifiers.map((i) => `${i.kind}:${i.value}`) })), startHash: outcome.startHash },
      agent_claim: outcome.claim ?? {}, engine: outcome.engine, usage: outcome.usage ?? {},
    };
    const ins = await a.from("lottery_group_proposals").insert(row).select("id").maybeSingle();
    if (ins.error) {
      if (ins.error.code === "23505") return empty("skipped", "同じ組はすでに記録されている（同時実行・再収集）", { tier: d.tier, kind: d.kind, ranAgent: outcome.ranAgent, skipReason: "duplicate_key", usage: outcome.usage, outcome });
      return empty("error", mapDbError(ins.error), { outcome });
    }
    const proposalId = (ins.data as { id: string }).id;
    // 単独・保留の判断が、取得したページで根拠の状態が変わった後のキーで記録されるため、取得前の状態のキーでも記録する（取得を保存できない環境で、毎回再調査しないように）
    if ((d.tier === "single" || d.tier === "hold") && outcome.startHash && outcome.startHash !== d.key.split(":").at(-1)) {
      await a.from("lottery_group_proposals").insert({ ...row, proposal_key: `${d.tier}:${lotteryId}:${outcome.startHash}` });
    }
    const base = { proposalId, tier: d.tier, kind: d.kind, ranAgent: outcome.ranAgent, usage: outcome.usage, outcome };
    if (d.tier === "single" || d.tier === "hold") return empty("dismissed", d.rationale, base);
    if (d.tier === "suggest" || !opts.allowAuto) return empty("pending", "利用者の承認待ちの候補として保存した", base);

    // 自動: 検証層が auto と判定した提案だけを、DBの関数（1トランザクション・冪等）で実行する
    const r = await resolveProposal(db, proposalId, "auto_apply", null, opts.actor, opts.asService ? householdId : null);
    if (!r.ok) return empty("error", r.error, base);
    if (r.value.status === "applied" || r.value.status === "approved") return empty("applied", "自動でグループ化した", { ...base, groupId: r.value.groupId });
    return empty("superseded", `実行直前に状況が変わったため、実行しなかった（${r.value.reason ?? r.value.status}）`, base);
  } catch (e) {
    return empty("error", `グループ判定に失敗しました: ${(e as Error).message?.slice(0, 120) ?? "不明なエラー"}`);
  }
}

// ---------------------------------------------------------------- 既存の抽選の一括判定（開発用）
export interface ScanSummary { evaluated: number; aiRuns: number; applied: number; pending: number; dismissed: number; skipped: number; errors: number; stoppedBy: "done" | "max_ai_runs" | "max_evaluations" }
/** グループに入っていない有効な抽選を新しい順に判定する。AIの実行回数・判定件数に上限（既定: AI 30回・判定 100件） */
export async function scanLotteryGrouping(db: Db, householdId: string, opts: GroupingRunOptions & { maxAiRuns?: number; maxEvaluations?: number; chainId?: string }): Promise<ScanSummary> {
  const a = any(db);
  let q = a.from("lotteries").select("id").eq("household_id", householdId).is("archived_at", null).is("bulk_group_id", null).order("created_at", { ascending: false }).limit(300);
  if (opts.chainId) q = q.eq("chain_id", opts.chainId);
  const { data } = await q;
  const sum: ScanSummary = { evaluated: 0, aiRuns: 0, applied: 0, pending: 0, dismissed: 0, skipped: 0, errors: 0, stoppedBy: "done" };
  const maxAi = opts.maxAiRuns ?? 30;
  const maxEval = opts.maxEvaluations ?? 100;
  for (const { id } of (data ?? []) as { id: string }[]) {
    if (sum.evaluated >= maxEval) { sum.stoppedBy = "max_evaluations"; break; }
    if (sum.aiRuns >= maxAi) { sum.stoppedBy = "max_ai_runs"; break; }
    // すでにこの実行中のグループ化で所属した抽選は、判定しない
    const cur = await a.from("lotteries").select("bulk_group_id,archived_at").eq("id", id).maybeSingle();
    if (cur.data?.bulk_group_id || cur.data?.archived_at) continue;
    const r = await runLotteryGrouping(db, householdId, id, opts);
    sum.evaluated++;
    if (r.ranAgent) sum.aiRuns++;
    if (r.status === "applied") sum.applied++;
    else if (r.status === "pending") sum.pending++;
    else if (r.status === "dismissed") sum.dismissed++;
    else if (r.status === "error") sum.errors++;
    else sum.skipped++;
  }
  return sum;
}

// ---------------------------------------------------------------- 既存グループ・候補の再評価（8F-5。読み取りのみ）
/**
 * 旧定義で作られた既存グループと承認待ちの候補を、新しい定義で再評価する（固定ロジック・AIなし・費用なし）。
 * **何も変更しない**（グループの解除・候補の却下・店舗の抽選・応募・当選の更新はしない）。結果を利用者が確認して操作する。
 */
export async function auditGroupingState(db: Db, householdId: string, opts: { maxGroups?: number; maxProposals?: number } = {}): Promise<{ groups: GroupAudit[]; proposals: ProposalAudit[] }> {
  const a = any(db);
  const groups: GroupAudit[] = [];
  const { data: gRows } = await a.from("lottery_bulk_groups").select("id").eq("household_id", householdId).is("dissolved_at", null).order("created_at", { ascending: false }).limit(opts.maxGroups ?? 100);
  for (const g of (gRows ?? []) as { id: string }[]) {
    const { data: m } = await a.from("lotteries").select("id").eq("household_id", householdId).eq("bulk_group_id", g.id).is("archived_at", null).limit(1).maybeSingle();
    if (!m) continue;
    const world = await loadGroupingWorld(db, householdId, (m as { id: string }).id);
    const group = world?.groups.find((x) => x.id === g.id);
    if (!world || !group) continue;
    groups.push(auditGroup(group, new Map([world.subject, ...world.lotteries].map((l) => [l.id, l]))));
  }
  const proposals: ProposalAudit[] = [];
  const { data: pRows } = await a.from("lottery_group_proposals").select("id,tier,subject_lottery_id,agent_claim").eq("household_id", householdId).eq("status", "pending").in("kind", ["new_group", "add_to_group"]).order("created_at", { ascending: false }).limit(opts.maxProposals ?? 100);
  for (const p of (pRows ?? []) as { id: string; tier: string; subject_lottery_id: string; agent_claim: unknown }[]) {
    const claim = parseGroupingProposal(p.agent_claim);
    if (!claim) continue;
    const world = await loadGroupingWorld(db, householdId, p.subject_lottery_id);
    if (!world) continue;
    const d = verifyProposal(world, claim, { allowAuto: false });
    proposals.push({ proposalId: p.id, oldTier: p.tier, newTier: d.tier, changed: d.tier !== p.tier, reason: d.rationale.slice(0, 200) });
  }
  return { groups, proposals };
}
