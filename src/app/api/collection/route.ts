import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { getExtractor } from "@/lib/ai/provider";
import { lotteryInputSchema } from "@/lib/lottery-input";
import { isXHost } from "@/lib/server/x-source";
import { ensureCollectionDefaults, registerCandidate, runCollection } from "@/lib/server/collector/run";
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
});

const body = z.discriminatedUnion("action", [
  z.object({ action: z.literal("run"), actor: z.uuid().nullable().optional(), sourceId: uuid.optional() }),
  z.object({ action: z.literal("register"), id: uuid, actor: z.uuid().nullable().optional(), input: z.unknown().optional() }),
  z.object({ action: z.literal("registerReady"), actor: z.uuid().nullable().optional() }),
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
    case "exclude":
    case "restore": {
      const { error } = await db
        .from("collection_candidates")
        .update(b.action === "exclude" ? { status: "excluded", reasons: ["利用者が除外しました"], resolved_at: new Date().toISOString() } : { status: "pending", reasons: ["除外を取り消しました"], resolved_at: null })
        .eq("id", b.id)
        .neq("status", "auto_registered");
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
          max_ai_per_run: s.maxAiPerRun, updated_at: new Date().toISOString(),
        })
        .eq("household_id", householdId);
      return error ? json({ ok: false, error: "保存に失敗しました" }, 500) : json({ ok: true });
    }
  }
}
