import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { getExtractor } from "@/lib/ai/provider";
import { lotteryInputSchema } from "@/lib/lottery-input";
import { isXHost } from "@/lib/server/x-source";
import { applyCandidateUpdate, ensureCollectionDefaults, registerCandidate, runCollection } from "@/lib/server/collector/run";
import { createXClient } from "@/lib/server/collector/x-client";
import { checkUrl } from "@/lib/server/safe-fetch";
import { isSupabaseMode } from "@/lib/supabase/env";
import { createClient } from "@/lib/supabase/server";
import { PREFECTURE_LIST } from "@/lib/geo";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

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
  autoRegister: z.boolean(),
  scheduleEnabled: z.boolean(),
  scheduleHourJst: z.number().int().min(0).max(23),
  xEnabled: z.boolean(),
  xMonthlyBudgetJpy: z.number().int().min(0).max(1_000_000),
  xMaxPostsPerRun: z.number().int().min(1).max(100),
  maxAiPerRun: z.number().int().min(1).max(50),
  workerEnabled: z.boolean(),
  workerBatch: z.number().int().min(1).max(20),
  workerDailyAiLimit: z.number().int().min(0).max(500),
  recheckHours: z.number().int().min(1).max(168),
});

const body = z.discriminatedUnion("action", [
  z.object({ action: z.literal("run"), actor: z.uuid().nullable().optional(), sourceId: uuid.optional() }),
  z.object({ action: z.literal("register"), id: uuid, actor: z.uuid().nullable().optional(), input: z.unknown().optional() }),
  z.object({ action: z.literal("registerReady"), actor: z.uuid().nullable().optional() }),
  z.object({ action: z.literal("applyUpdate"), id: uuid }),
  z.object({ action: z.literal("bulkRegister"), ids: z.array(uuid).min(1).max(50), actor: z.uuid().nullable().optional() }),
  z.object({ action: z.literal("bulkExclude"), ids: z.array(uuid).min(1).max(100) }),
  z.object({ action: z.literal("reanalyze"), id: uuid }),
  z.object({ action: z.literal("markRegistered"), id: uuid, lotteryId: uuid }),
  z.object({ action: z.literal("resume") }),
  z.object({ action: z.literal("setAiBudget"), budgetJpy: z.number().int().min(0).max(1_000_000), rate: z.number().min(50).max(500), actor: z.uuid().nullable().optional() }),
  // 本日(日本時間)だけの日次上限の一時変更。null で解除。翌日は通常の設定に戻る
  z.object({ action: z.literal("setDailyOverride"), limit: z.number().int().min(0).max(1000).nullable() }),
  z.object({ action: z.literal("exclude"), id: uuid }),
  z.object({ action: z.literal("restore"), id: uuid }),
  z.object({ action: z.literal("addSource"), source: sourceInput }),
  z.object({ action: z.literal("updateSource"), id: uuid, source: sourceInput }),
  z.object({ action: z.literal("toggleSource"), id: uuid, enabled: z.boolean() }),
  z.object({ action: z.literal("deleteSource"), id: uuid }),
  z.object({ action: z.literal("saveSettings"), settings: settingsInput }),
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
      // 選んだ確認待ちの候補をまとめて登録する（1件ずつ登録し、失敗した件数を返す。★管理対象にせず、応募記録は作らない）
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
      const { error } = await db
        .from("collection_candidates")
        .update({ status: "excluded", job_state: "skipped", reasons: ["利用者が除外しました"], resolved_at: new Date().toISOString(), lease_until: null, locked_by: null })
        .in("id", b.ids)
        .neq("status", "auto_registered");
      return error ? json({ ok: false, error: "更新に失敗しました" }, 500) : json({ ok: true, excluded: b.ids.length });
    }
    case "reanalyze": {
      // 再解析: 取得済みの内容は削除せず、同じ候補をキューに戻す（AIの利用上限・予算の範囲で、ワーカーが解析する）
      const { data: c } = await db.from("collection_candidates").select("id,draft,status,source_url,dedupe_key,title").eq("id", b.id).maybeSingle();
      if (!c || c.status === "auto_registered" || !c.source_url) return json({ ok: false, error: "再解析できる候補ではありません" }, 422);
      const prior = (c.draft as object | null) ?? {};
      const queued = { kind: c.dedupe_key.startsWith("x:") ? "x_oembed" : "web_page", url: c.source_url, title: c.title, context: "", sourceName: "再解析", attempts: 0, changed: true };
      const { error } = await db.from("collection_candidates").update({ job_state: "pending", status: "pending", attempts: 0, next_run_at: null, reasons: ["再解析待ち"], draft: { ...prior, queued } as never, lease_until: null, locked_by: null }).eq("id", b.id);
      return error ? json({ ok: false, error: "更新に失敗しました" }, 500) : json({ ok: true });
    }
    case "markRegistered": {
      // 画面で内容を直して登録した抽選を、候補に紐付ける
      await db.rpc("bump_collection_stats", { p_household: householdId, p_day: new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Tokyo", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date()), p_delta: { registered_new: 1 } });
      await db.from("collection_candidates").update({ status: "auto_registered", job_state: "completed", lottery_id: b.lotteryId, reasons: ["内容を確認・修正して登録しました"], resolved_at: new Date().toISOString(), completed_at: new Date().toISOString() }).eq("id", b.id);
      return json({ ok: true });
    }
    case "setAiBudget": {
      // アプリ内の停止条件（月額予算と円換算レート）の変更のみ。外部サービス（Anthropic）の契約・課金上限は変更しない
      const { error } = await db.rpc("save_ai_budget", { p_budget: b.budgetJpy, p_rate: b.rate, p_actor: (b.actor ?? null) as string });
      return error ? json({ ok: false, error: "保存に失敗しました" }, 500) : json({ ok: true });
    }
    case "setDailyOverride": {
      const today = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Tokyo", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
      const { error } = await db.from("collection_settings").update(b.limit === null ? { worker_limit_override: null, worker_limit_override_date: null } : { worker_limit_override: b.limit, worker_limit_override_date: today }).eq("household_id", householdId);
      return error ? json({ ok: false, error: "更新に失敗しました" }, 500) : json({ ok: true });
    }
    case "resume": {
      // 自動停止（連続失敗など）の解除
      const { error } = await db.from("collection_settings").update({ paused_until: null, paused_reason: null, consecutive_failures: 0 }).eq("household_id", householdId);
      return error ? json({ ok: false, error: "更新に失敗しました" }, 500) : json({ ok: true });
    }
    case "exclude": {
      const { error } = await db
        .from("collection_candidates")
        .update({ status: "excluded", job_state: "skipped", reasons: ["利用者が除外しました"], resolved_at: new Date().toISOString(), lease_until: null, locked_by: null })
        .eq("id", b.id)
        .neq("status", "auto_registered");
      return error ? json({ ok: false, error: "更新に失敗しました" }, 500) : json({ ok: true });
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
    case "saveSettings": {
      const s = b.settings;
      const bad = s.prefectures.find((p) => !PREFECTURE_LIST.includes(p));
      if (bad) return json({ ok: false, error: `都道府県の指定が不正です: ${bad}` }, 422);
      const { error } = await db
        .from("collection_settings")
        .update({
          prefectures: s.prefectures, include_online: s.includeOnline, max_distance_km: s.maxDistanceKm, apply_methods: s.applyMethods, receive_methods: s.receiveMethods,
          req_include: s.reqInclude, req_exclude: s.reqExclude, product_mode: s.productMode, product_ids: s.productIds, status_mode: s.statusMode, auto_register: s.autoRegister,
          schedule_enabled: s.scheduleEnabled, schedule_hour_jst: s.scheduleHourJst, x_enabled: s.xEnabled, x_monthly_budget_jpy: s.xMonthlyBudgetJpy, x_max_posts_per_run: s.xMaxPostsPerRun,
          max_ai_per_run: s.maxAiPerRun, worker_enabled: s.workerEnabled, worker_batch: s.workerBatch, worker_daily_ai_limit: s.workerDailyAiLimit, recheck_hours: s.recheckHours, updated_at: new Date().toISOString(),
        })
        .eq("household_id", householdId);
      return error ? json({ ok: false, error: "保存に失敗しました" }, 500) : json({ ok: true });
    }
  }
}
