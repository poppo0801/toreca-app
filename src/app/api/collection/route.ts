import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { getExtractor } from "@/lib/ai/provider";
import { lotteryInputSchema } from "@/lib/lottery-input";
import { isXHost } from "@/lib/server/x-source";
import { applyCandidateUpdate, ensureCollectionDefaults, registerCandidate, runCollection } from "@/lib/server/collector/run";
import { createXClient } from "@/lib/server/collector/x-client";
import { saveCollectionSettings } from "@/lib/server/collector/settings";
import { createClient as createServiceClient } from "@supabase/supabase-js";
import { archiveReasonOf, isReevaluable } from "@/lib/collector/archive";
import { runReevaluation } from "@/lib/server/collector/reevaluate";
import type { Db } from "@/lib/server/lottery-service";
import { excludeCandidates, requeueCandidates, undoExclude } from "@/lib/server/collector/review-actions";
import { deactivateRule, excludeWithReason } from "@/lib/server/collector/exclusion-reasons";
import { ADMIN_ONLY_MESSAGE, isAdminProfile } from "@/lib/server/collector/admin-guard";
import { rebuildQueued } from "@/lib/collector/queued";
import { learnAliases, planAliasLearning, type LearnInput } from "@/lib/server/collector/learn";
import { checkUrl } from "@/lib/server/safe-fetch";
import { isSupabaseMode } from "@/lib/supabase/env";
import { createClient } from "@/lib/supabase/server";
import { PREFECTURE_LIST } from "@/lib/geo";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/** 一括再評価の実行中の世帯（二重実行の防止） */
const reevalBusy = new Set<string>();

const json = (body: Record<string, unknown>, status = 200) => NextResponse.json(body, { status, headers: { "Cache-Control": "no-store" } });

const uuid = z.uuid();

const sourceInput = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("web"), name: z.string().trim().min(1).max(80), url: z.string().trim().max(500), enabled: z.boolean().default(true), intervalHours: z.number().int().min(1).max(168).default(24) }),
  z.object({ kind: z.literal("x"), name: z.string().trim().min(1).max(80), username: z.string().trim().max(60), enabled: z.boolean().default(true), intervalHours: z.number().int().min(1).max(168).default(24) }),
]);

const settingsInput = z.object({
  prefectures: z.array(z.string()).max(47),
  includeOnline: z.boolean(),
  maxDistanceKm: z.number().int().min(1).max(3000).nullable(),
  applyMethods: z.array(z.enum(["web", "app", "livepocket", "store", "x", "line", "other"])),
  receiveMethods: z.array(z.enum(["store", "shipping", "either", "unknown"])),
  reqInclude: z.array(z.string().max(40)).max(40),
  reqExclude: z.array(z.string().max(40)).max(40),
  productMode: z.enum(["all", "include", "exclude"]),
  productIds: z.array(uuid).max(200),
  statusMode: z.enum(["open", "open_or_before"]),
  trackUpcoming: z.boolean().default(true),
  autoRegister: z.boolean(),
  scheduleEnabled: z.boolean(),
  scheduleHourJst: z.number().int().min(0).max(23),
  /** 2回目の実行時刻（日本時間）。null=1日1回 */
  scheduleHour2Jst: z.number().int().min(0).max(23).nullable().default(null),
  xEnabled: z.boolean(),
  xMonthlyBudgetJpy: z.number().int().min(0).max(1_000_000),
  xMaxPostsPerRun: z.number().int().min(1).max(100),
  maxAiPerRun: z.number().int().min(1).max(50),
  workerEnabled: z.boolean(),
  workerBatch: z.number().int().min(1).max(20),
  recheckHours: z.number().int().min(1).max(168),
});

const body = z.discriminatedUnion("action", [
  z.object({ action: z.literal("run"), actor: z.uuid().nullable().optional(), sourceId: uuid.optional() }),
  z.object({ action: z.literal("register"), id: uuid, actor: z.uuid().nullable().optional(), input: z.unknown().optional() }),
  z.object({ action: z.literal("registerReady"), actor: z.uuid().nullable().optional() }),
  z.object({ action: z.literal("applyUpdate"), id: uuid }),
  z.object({ action: z.literal("bulkRegister"), ids: z.array(uuid).min(1).max(50), actor: z.uuid().nullable().optional() }),
  z.object({ action: z.literal("bulkExclude"), ids: z.array(uuid).min(1).max(100) }),
  z.object({ action: z.literal("bulkReanalyze"), ids: z.array(uuid).min(1).max(50) }),
  // 除外の取り消し（直前の状態へ戻す。復元できるのは、利用者が除外した候補だけ）
  z.object({ action: z.literal("undoExclude"), items: z.array(z.object({ id: uuid, prev: z.record(z.string(), z.unknown()) })).min(1).max(100) }),
  z.object({ action: z.literal("reanalyze"), id: uuid }),
  z.object({ action: z.literal("markRegistered"), id: uuid, lotteryId: uuid }),
  z.object({ action: z.literal("resume") }),
  z.object({ action: z.literal("setAiBudget"), budgetJpy: z.number().int().min(0).max(1_000_000), rate: z.number().min(50).max(500), actor: z.uuid().nullable().optional() }),
  // 本日(日本時間)だけの日次上限の一時変更。null で解除。翌日は通常の設定に戻る
  z.object({ action: z.literal("exclude"), id: uuid }),
  // 除外理由つきの除外（Stage 7H）。入力の検証・ルールの作成・履歴の記録は excludeWithReason
  z.object({ action: z.literal("excludeReason"), id: uuid, actor: z.uuid().nullable().optional(), input: z.unknown() }),
  z.object({ action: z.literal("undoReason"), actor: z.uuid().nullable().optional(), items: z.array(z.object({ id: uuid, prev: z.record(z.string(), z.unknown()) })).min(1).max(100), rule: z.object({ table: z.enum(["collection_rules", "collection_exclusions"]), id: uuid, created: z.boolean() }).nullable().optional() }),
  z.object({ action: z.literal("restore"), id: uuid }),
  z.object({ action: z.literal("addSource"), source: sourceInput }),
  z.object({ action: z.literal("updateSource"), id: uuid, source: sourceInput }),
  z.object({ action: z.literal("toggleSource"), id: uuid, enabled: z.boolean() }),
  // 公式Xアカウントと系列・店舗の対応づけ（利用者が明示的に登録したものだけを使う。まとめアカウントは登録しない）
  z.object({ action: z.literal("linkXAccount"), username: z.string().trim().transform((s) => s.replace(/^@/, "").toLowerCase()).pipe(z.string().regex(/^[a-z0-9_]{1,15}$/)), role: z.enum(["official_store", "official_chain"]), chainId: uuid.nullable().optional(), storeId: uuid.nullable().optional(), note: z.string().max(200).optional(), actor: z.uuid().nullable().optional() }),
  z.object({ action: z.literal("unlinkXAccount"), id: uuid }),
  z.object({ action: z.literal("deleteSource"), id: uuid }),
  z.object({ action: z.literal("saveSettings"), settings: settingsInput }),
  // 一括再評価（Stage 6G）: plan=対象の確認（DBは変更しない）/ run=指定した候補だけ最新のロジックで再評価（AI・X APIは使わない）/ unarchive=アーカイブ済みを確認待ちへ戻して再評価できるようにする
  z.object({ action: z.literal("reevalPlan") }),
  z.object({ action: z.literal("reevalRun"), ids: z.array(uuid).min(1).max(20) }),
  z.object({ action: z.literal("unarchive"), ids: z.array(uuid).min(1).max(100) }),
]);

/** 収集元の入力を検証して保存用の行にする。Webは公開のhttps URLだけ(内部ネットワーク・資格情報つきURLは拒否) */
async function toSourceRow(s: z.infer<typeof sourceInput>): Promise<{ ok: true; row: Record<string, unknown> } | { ok: false; message: string }> {
  if (s.kind === "x") {
    const u = s.username.replace(/^https?:\/\/(www\.)?(x|twitter)\.com\//i, "").replace(/^@/, "").replace(/[/?#].*$/, "");
    if (!/^[A-Za-z0-9_]{1,15}$/.test(u)) return { ok: false, message: "Xのアカウント名は、英数字とアンダースコアの15文字以内で入力してください（例: pokecachan）" };
    return { ok: true, row: { kind: "x", name: s.name, x_username: u, url: null, adapter: "x", enabled: s.enabled, interval_hours: s.intervalHours } };
  }
  if (isXHost(s.url)) return { ok: false, message: "XのアカウントはWebサイトではなく「Xアカウント」として追加してください" };
  // 形式の検査(https・標準ポート・資格情報なし・内部アドレスの直接指定の拒否)。接続先のIPは取得の直前にも毎回検査される(SSRF対策)
  const check = checkUrl(s.url);
  if (!check.ok || check.url.protocol !== "https:") return { ok: false, message: check.ok ? "https:// で始まるURLを入力してください" : check.message };
  const normalized = check.url.toString();
  let adapter: "pokeso" | "torecabiyori" | "generic" = "generic";
  const h = new URL(check.url).hostname.replace(/^www\./, "");
  if (h === "pokeso.jp") adapter = "pokeso";
  else if (h === "torecabiyori.com") adapter = "torecabiyori";
  return { ok: true, row: { kind: "web", name: s.name, url: normalized, x_username: null, adapter, enabled: s.enabled, interval_hours: s.intervalHours } };
}

export async function POST(request: NextRequest) {
  if (!isSupabaseMode) return json({ ok: false, error: "自動収集はログイン後（Supabaseモード）でのみ使えます" }, 503);
  const db = await createClient();
  const { data: auth } = await db.auth.getUser();
  if (!auth.user) return json({ ok: false, error: "ログインが必要です" }, 401);
  const hh = await db.from("households").select("id").maybeSingle();
  const householdId = hh.data?.id;
  if (!householdId) return json({ ok: false, error: "世帯が見つかりません" }, 403);

  const parsed = body.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return json({ ok: false, error: "リクエストが不正です" }, 400);
  const b = parsed.data;
  await ensureCollectionDefaults(db, householdId);

  switch (b.action) {
    case "run": {
      const out = await runCollection({ db, householdId, trigger: "manual", now: new Date(), actor: b.actor ?? null, canRegister: true, extractor: getExtractor(), xClient: createXClient(), onlySourceIds: b.sourceId ? [b.sourceId] : undefined });
      return out.ok ? json({ ...out }) : json({ ok: false, error: out.message, code: out.code }, out.code === "already_running" ? 409 : 500);
    }
    case "register": {
      let override;
      if (b.input !== undefined) {
        const p = lotteryInputSchema.safeParse(b.input);
        if (!p.success) return json({ ok: false, error: p.error.issues[0]?.message ?? "入力内容を確認してください" }, 422);
        override = p.data;
      }
      const r = await registerCandidate(db, householdId, b.actor ?? null, b.id, override);
      return r.ok ? json({ ok: true, lotteryId: r.lotteryId }) : json({ ok: false, error: r.message }, 422);
    }
    case "registerReady": {
      // 条件に合い、情報が十分な候補(登録可能)をまとめて登録する。1件ずつ登録し、失敗した件数を返す
      const { data } = await db.from("collection_candidates").select("id,draft").eq("household_id", householdId).eq("status", "pending").limit(100);
      let ok = 0;
      let failed = 0;
      for (const c of data ?? []) {
        const d = c.draft as { ready?: boolean; verdict?: string } | null;
        if (!d?.ready || d.verdict !== "match") continue;
        const r = await registerCandidate(db, householdId, b.actor ?? null, c.id);
        if (r.ok) ok++;
        else failed++;
      }
      return json({ ok: true, registered: ok, failed });
    }
    case "applyUpdate": {
      const r = await applyCandidateUpdate(db, b.id);
      return r.ok ? json({ ok: true, applied: r.applied }) : json({ ok: false, error: r.message }, 422);
    }
    case "bulkRegister": {
      // 選んだ確認待ちの候補をまとめて登録する（1件ずつ登録し、失敗した件数を返す。要チェックにせず、応募記録は作らない）
      let ok = 0;
      const failed: string[] = [];
      for (const id of b.ids) {
        const r = await registerCandidate(db, householdId, b.actor ?? null, id);
        if (r.ok) ok++;
        else failed.push(r.message);
      }
      return json({ ok: true, registered: ok, failed: failed.length, firstError: failed[0] ?? null });
    }
    case "bulkExclude": {
      const r = await excludeCandidates(db, b.ids);
      return r.ok ? json({ ok: true, excluded: r.excluded, failed: r.failed, prev: r.prev }) : json({ ok: false, error: "更新に失敗しました" }, 500);
    }
    case "bulkReanalyze": {
      const r = await requeueCandidates(db, b.ids);
      return json({ ok: r.requeued > 0 || r.failed === 0, ...r });
    }
    case "reanalyze": {
      // 再解析: 取得済みの内容は削除せず、同じ候補をキューに戻す（AIの利用上限・予算の範囲で、ワーカーが解析する）
      const { data: c } = await db.from("collection_candidates").select("id,draft,status,source_url,dedupe_key,title").eq("id", b.id).maybeSingle();
      if (!c || c.status === "auto_registered" || !c.source_url) return json({ ok: false, error: "再解析できる候補ではありません" }, 422);
      const prior = (c.draft as object | null) ?? {};
      // 一覧のカード・店舗/商品・ヒント・文脈は引き継ぐ（取得制限のページは一覧の情報が唯一の手掛かり）
      const queued = rebuildQueued(prior, { kind: c.dedupe_key.startsWith("x:") ? "x_oembed" : "web_page", url: c.source_url, sourceName: "再解析", reason: "manual_reanalyze", changed: true, fallbackTitle: c.title });
      const { error } = await db.from("collection_candidates").update({ job_state: "pending", status: "pending", attempts: 0, next_run_at: null, reasons: ["再解析待ち"], draft: { ...prior, queued } as never, lease_until: null, locked_by: null }).eq("id", b.id);
      return error ? json({ ok: false, error: "更新に失敗しました" }, 500) : json({ ok: true });
    }
    case "markRegistered": {
      // 画面で内容を直して登録した抽選を、候補に紐付ける
      // 利用者が直した名称とマスターの対応を別名として記録する（以後の照合で再利用。自動登録の件数には数えない）
      const { data: cand } = await db.from("collection_candidates").select("draft").eq("id", b.id).maybeSingle();
      const [lot, its] = await Promise.all([
        db.from("lotteries").select("chain_id,store_id").eq("id", b.lotteryId).maybeSingle(),
        db.from("lottery_items").select("product_id").eq("lottery_id", b.lotteryId),
      ]);
      const draftInput = (cand?.draft as { input?: LearnInput["draft"] } | null)?.input;
      if (draftInput && lot.data) {
        const [ch, st, pr] = await Promise.all([
          db.from("chains").select("id,name").eq("id", lot.data.chain_id).maybeSingle(),
          db.from("stores").select("id,name").eq("id", lot.data.store_id).maybeSingle(),
          db.from("products").select("id,official_name").in("id", (its.data ?? []).map((x) => x.product_id)),
        ]);
        const plans = planAliasLearning({
          draft: draftInput,
          final: { chain: { id: ch.data?.id, name: ch.data?.name }, store: { id: st.data?.id, name: st.data?.name }, products: (pr.data ?? []).map((x) => ({ id: x.id, name: x.official_name })) },
        });
        await learnAliases(db, householdId, plans);
      }
      await db.from("collection_candidates").update({ status: "auto_registered", job_state: "completed", lottery_id: b.lotteryId, reasons: ["内容を確認・修正して登録しました"], resolved_at: new Date().toISOString(), completed_at: new Date().toISOString() }).eq("id", b.id);
      return json({ ok: true });
    }
    case "setAiBudget": {
      // アプリ内の停止条件（月額予算と円換算レート）の変更のみ。外部サービス（Anthropic）の契約・課金上限は変更しない
      const { error } = await db.rpc("save_ai_budget", { p_budget: b.budgetJpy, p_rate: b.rate, p_actor: (b.actor ?? null) as string });
      return error ? json({ ok: false, error: "保存に失敗しました" }, 500) : json({ ok: true });
    }
    case "resume": {
      // 自動停止（連続失敗など）の解除
      const { error } = await db.from("collection_settings").update({ paused_until: null, paused_reason: null, consecutive_failures: 0 }).eq("household_id", householdId);
      return error ? json({ ok: false, error: "更新に失敗しました" }, 500) : json({ ok: true });
    }
    case "exclude": {
      const r = await excludeCandidates(db, [b.id]);
      if (!r.ok) return json({ ok: false, error: "更新に失敗しました" }, 500);
      if (r.excluded === 0) return json({ ok: false, error: "除外できませんでした（登録済みの候補は除外できません）" }, 422);
      return json({ ok: true, excluded: 1, prev: r.prev });
    }
    case "excludeReason": {
      // 除外ルールの作成など、抽選候補の管理操作は管理者のプロフィールのみ（Stage 7J）
      if (!(await isAdminProfile(db as never, b.actor))) return json({ ok: false, error: ADMIN_ONLY_MESSAGE }, 403);
      const r = await excludeWithReason(db as never, householdId, b.id, b.actor ?? null, b.input as never);
      return r.ok ? json({ ok: true, prev: r.prev, rule: r.rule, reason: r.reason }) : json({ ok: false, error: r.error }, 422);
    }
    case "undoReason": {
      if (!(await isAdminProfile(db as never, b.actor))) return json({ ok: false, error: ADMIN_ONLY_MESSAGE }, 403);
      const r = await undoExclude(db, b.items as never);
      if (r.restored > 0 && b.rule) await deactivateRule(db as never, b.rule);
      return r.restored > 0 || r.failed === 0 ? json({ ok: true, ...r }) : json({ ok: false, error: "元に戻せませんでした" }, 422);
    }
    case "undoExclude": {
      const r = await undoExclude(db, b.items as never);
      return r.restored > 0 || r.failed === 0 ? json({ ok: true, ...r }) : json({ ok: false, error: "元に戻せませんでした" }, 422);
    }
    case "restore": {
      // 除外を取り消す: 解析済みの内容があれば確認待ちに、無ければ（一覧の表示だけで除外したもの）解析待ちに戻す。解析前の絞り込みは通さず、解析する
      const { data: c } = await db.from("collection_candidates").select("id,draft,status,source_url,dedupe_key,title").eq("id", b.id).maybeSingle();
      if (!c || c.status === "auto_registered") return json({ ok: false, error: "対象の候補がありません" }, 422);
      const analyzed = Boolean((c.draft as { input?: unknown } | null)?.input);
      const patch = analyzed
        ? { status: "pending", job_state: "review", reasons: ["除外を取り消しました"], resolved_at: null }
        : c.source_url
          ? {
              status: "pending",
              job_state: "pending",
              attempts: 0,
              next_run_at: null,
              reasons: ["除外を取り消しました（解析待ち）"],
              resolved_at: null,
              draft: { queued: { kind: c.dedupe_key.startsWith("x:") ? "x_oembed" : "web_page", url: c.source_url, title: c.title, context: "", sourceName: "復元", attempts: 0, changed: true } },
            }
          : null;
      if (!patch) return json({ ok: false, error: "解析できる情報がありません" }, 422);
      const { error } = await db.from("collection_candidates").update(patch as never).eq("id", b.id);
      return error ? json({ ok: false, error: "更新に失敗しました" }, 500) : json({ ok: true });
    }
    case "addSource":
    case "updateSource": {
      const r = await toSourceRow(b.source);
      if (!r.ok) return json({ ok: false, error: r.message }, 422);
      const q = b.action === "addSource" ? db.from("collection_sources").insert({ household_id: householdId, ...r.row } as never) : db.from("collection_sources").update({ ...r.row, status: "never", error_message: null, x_user_id: null, x_since_id: null, updated_at: new Date().toISOString() } as never).eq("id", b.id);
      const { error } = await q;
      if (error) return json({ ok: false, error: error.code === "23505" ? "同じ収集元が既に登録されています" : "保存に失敗しました" }, error.code === "23505" ? 409 : 500);
      return json({ ok: true });
    }
    case "linkXAccount": {
      // まとめアカウント（収集元に登録したXアカウント）は紹介元であり、実施店舗の公式アカウントではない
      const { data: agg } = await db.from("collection_sources").select("id").eq("household_id", householdId).eq("kind", "x").ilike("x_username", b.username).limit(1);
      if ((agg ?? []).length > 0) return json({ ok: false, error: "収集元のまとめアカウントは、店舗・系列の公式アカウントとして登録できません" }, 422);
      const row = { household_id: householdId, username: b.username, role: b.role, chain_id: b.role === "official_chain" ? (b.chainId ?? null) : null, store_id: b.role === "official_store" ? (b.storeId ?? null) : null, note: b.note ?? "", created_by_profile_id: b.actor ?? null };
      const { error } = await db.from("x_account_links").upsert(row as never, { onConflict: "household_id,username" });
      return error ? json({ ok: false, error: error.code === "23514" ? "店舗または系列を指定してください" : "保存に失敗しました" }, error.code === "23514" ? 422 : 500) : json({ ok: true });
    }
    case "unlinkXAccount": {
      const { error } = await db.from("x_account_links").delete().eq("id", b.id);
      return error ? json({ ok: false, error: "削除に失敗しました" }, 500) : json({ ok: true });
    }
    case "toggleSource": {
      const { error } = await db.from("collection_sources").update({ enabled: b.enabled, updated_at: new Date().toISOString() }).eq("id", b.id);
      return error ? json({ ok: false, error: "更新に失敗しました" }, 500) : json({ ok: true });
    }
    case "deleteSource": {
      // 収集済みの候補・登録済みの抽選は残す(候補の収集元の参照だけ外す)
      await db.from("collection_candidates").update({ source_id: null }).eq("source_id", b.id);
      const { error } = await db.from("collection_sources").delete().eq("id", b.id);
      return error ? json({ ok: false, error: "削除に失敗しました" }, 500) : json({ ok: true });
    }
    case "reevalPlan":
    case "reevalRun": {
      const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
      const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
      if (!url || !key) return json({ ok: false, error: "サーバーの設定が不足しています" }, 500);
      // 世帯の所属は上で確認済み。登録・更新の書き込みはサービス権限で行う（定期実行と同じ経路）
      const svc = createServiceClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } }) as unknown as Db;
      const deps = { db: svc, householdId, trigger: "manual" as const, now: new Date(), actor: null, canRegister: false, serviceRegister: true, extractor: getExtractor(), xClient: createXClient() };
      // 二重実行の防止（同じサーバー上で再評価が実行中なら受け付けない。再評価は候補ごとに冪等で、中断しても残りから再開できる）
      if (reevalBusy.has(householdId)) return json({ ok: false, error: "再評価を実行中です。完了してからもう一度お試しください" }, 409);
      reevalBusy.add(householdId);
      let out;
      try {
        out = await runReevaluation(deps, b.action === "reevalPlan" ? { execute: false, aiMax: 0 } : { execute: true, aiMax: 0, ids: b.ids });
      } finally {
        reevalBusy.delete(householdId);
      }
      if (!out.ok) return json({ ok: false, error: out.message }, 500);
      return json({ ok: true, execute: out.execute, before: out.before, after: out.after, counts: out.counts, byClass: out.byClass, rows: out.rows.map((r) => ({ id: r.id, cls: r.cls, outcome: r.outcome, reason: r.reason })) });
    }
    case "unarchive": {
      const { data, error } = await db.from("collection_candidates").select("id,status,reasons,draft").in("id", b.ids).in("status", ["excluded"]);
      if (error) return json({ ok: false, error: "更新に失敗しました" }, 500);
      const ok = (data ?? []).filter((r) => isReevaluable(archiveReasonOf({ status: r.status, reasons: r.reasons })) && Boolean((r.draft as { input?: unknown } | null)?.input)).map((r) => r.id);
      if (ok.length === 0) return json({ ok: false, error: "再評価できる候補がありません（解析済みの地域対象外・自動除外だけ戻せます）" }, 422);
      const up = await db.from("collection_candidates").update({ status: "pending", job_state: "review", reasons: ["アーカイブから再評価"], resolved_at: null }).in("id", ok).eq("status", "excluded").select("id");
      return up.error ? json({ ok: false, error: "更新に失敗しました" }, 500) : json({ ok: true, restored: (up.data ?? []).length, skipped: b.ids.length - ok.length });
    }
    case "saveSettings": {
      const s = b.settings;
      const bad = s.prefectures.find((p) => !PREFECTURE_LIST.includes(p));
      if (bad) return json({ ok: false, error: `都道府県の指定が不正です: ${bad}` }, 422);
      const r = await saveCollectionSettings(db, householdId, s as never);
      return r.ok ? json({ ok: true, settings: r.settings }) : json({ ok: false, error: r.error }, 500);
    }
  }
}
