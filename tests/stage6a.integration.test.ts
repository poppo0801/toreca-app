/**
 * Stage 6A: AI利用ログ（システム実行）・月額予算の基準・定期収集の判定・再解析での一覧情報の保持（実Supabase・RLS適用下。AI・外部サイトはモック）
 *   npm run test:db
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { getExtractor } from "@/lib/ai/provider";
import { DEFAULT_CONDITIONS } from "@/lib/collector/conditions";
import { rebuildQueued } from "@/lib/collector/queued";
import { slotDateOf } from "@/lib/collector/schedule";
import { monthBudget } from "@/lib/server/ai-budget";
import { loadAppData, type Db } from "@/lib/server/lottery-service";
import { aiAllowance, processQueue, runCollection, type CollectDeps } from "@/lib/server/collector/run";
import { planScheduledCollection } from "@/lib/server/collector/schedule";
import { adminClient, cleanupTestUsers, dbTestsEnabled, signInTestUser } from "./helpers/db";

const NOW = new Date();
const q6a = (n: string) => `https://q6a.example.invalid/${n}`;

describe.skipIf(!dbTestsEnabled)("Stage 6A", () => {
  const admin = adminClient();
  const userIds: string[] = [];
  let u1: Db;
  let u2: Db;
  let hid: string;
  let hid2: string;
  let profile: string;
  let aiCalls = 0;
  const sys = admin as unknown as Db;

  const mock = () => ({ engine: "mock" as const, extract: async (r: never) => { aiCalls++; return getExtractor({ AI_PROVIDER: "mock" })!.extract(r); } });
  const robots = async () => ({ ok: false as const, code: "robots" as const, message: "このサイトはロボットによるページ取得を許可していません。告知の文章をコピーするか、画像で読み取ってください" });
  const cronDeps = (over: Partial<CollectDeps> = {}): CollectDeps => ({ db: sys, householdId: hid, trigger: "cron", now: NOW, actor: null, canRegister: false, serviceRegister: true, extractor: mock(), xClient: null, fetchPage: robots, fetchOembed: async () => ({ ok: false, message: "x" }), ...over });
  const run = async (d: CollectDeps) => processQueue(d, { settings: { auto_register: false }, cond: DEFAULT_CONDITIONS, data: await loadAppData(sys, hid), aiLeft: 20, timeLeft: () => 50_000, perBatch: 4 });
  const cand = async (key: string) => (await sys.from("collection_candidates").select("id,status,job_state,reasons,draft,ai_calls").eq("household_id", hid).eq("dedupe_key", key).maybeSingle()).data!;

  beforeAll(async () => {
    const a = await signInTestUser(admin, "s6a", 1);
    userIds.push(a.userId);
    u1 = a.db;
    hid = (await u1.rpc("bootstrap_household")).data as string;
    profile = (await u1.from("profiles").select("id").order("sort_order")).data![0].id;
    await u1.from("collection_settings").insert({ household_id: hid, auto_register: false, worker_enabled: false });
    const b = await signInTestUser(admin, "s6a", 2);
    userIds.push(b.userId);
    u2 = b.db;
    hid2 = (await u2.rpc("bootstrap_household")).data as string;
  });
  afterAll(async () => {
    await sys.from("collection_candidates").delete().like("dedupe_key", "%q6a.example.invalid%");
    await cleanupTestUsers(admin, userIds);
  });

  // ------------------------------------------------------------ A1: システム実行のAI利用ログ
  it("cron（サービスロール・ログインなし）の解析が、system として利用ログに保存される。実行理由も残る", async () => {
    const key = q6a("robots-1");
    const card = "テスト商品 テスト玩具 本店 販売価格 ¥7,200 11/20(金) 21:00まで 東京都・店頭受取";
    await sys.from("collection_candidates").insert({ household_id: hid, dedupe_key: key, source_url: key, title: "【抽選】テスト商品", status: "pending", job_state: "pending", reasons: ["解析待ち"], draft: { queued: { kind: "web_page", url: key, title: "【抽選】テスト商品", context: "テスト玩具 本店", card, fields: { store: "テスト玩具 本店", product: "テスト商品" }, sourceName: "pokeso", attempts: 0, listSeenAt: NOW.toISOString() } } as never });
    const before = (await sys.from("ai_extraction_logs").select("id", { count: "exact", head: true }).eq("household_id", hid)).count ?? 0;
    aiCalls = 0;
    await run(cronDeps());
    expect(aiCalls).toBe(1);
    const logs = (await sys.from("ai_extraction_logs").select("actor_kind,user_id,trigger_reason,household_id,status").eq("household_id", hid).order("created_at", { ascending: false }).limit(1)).data!;
    expect((await sys.from("ai_extraction_logs").select("id", { count: "exact", head: true }).eq("household_id", hid)).count).toBe(before + 1);
    expect(logs[0]).toMatchObject({ actor_kind: "system", user_id: null, trigger_reason: "initial", household_id: hid });
    const st = (await sys.from("collection_daily_stats").select("ai_calls,ai_log_failures").eq("household_id", hid)).data!;
    expect(st.reduce((a, r) => a + r.ai_calls, 0)).toBeGreaterThanOrEqual(1);
    expect(st.reduce((a, r) => a + r.ai_log_failures, 0)).toBe(0);
  });

  it("利用者（ログイン）の手動実行は従来どおり利用者として保存される。システム行は他世帯・他の利用者に見えない", async () => {
    const ins = await u1.from("ai_extraction_logs").insert({ household_id: hid, kind: "text", engine: "mock", status: "ok" } as never).select("user_id,actor_kind").single();
    expect(ins.error).toBeNull();
    expect(ins.data).toMatchObject({ actor_kind: "user" });
    expect(ins.data!.user_id).toBeTruthy();
    // 利用者はシステム行を書けない／user_id なしで user 行を書けない
    expect((await u1.from("ai_extraction_logs").insert({ household_id: hid, kind: "text", engine: "mock", status: "ok", actor_kind: "system" } as never)).error).not.toBeNull();
    expect((await u1.from("ai_extraction_logs").insert({ household_id: hid, kind: "text", engine: "mock", status: "ok", user_id: null } as never)).error).not.toBeNull();
    // 他の世帯からは見えない
    expect((await u2.from("ai_extraction_logs").select("id").eq("household_id", hid)).data ?? []).toHaveLength(0);
    expect((await u2.rpc("collection_integrity", { p_household: hid })).error).not.toBeNull();
    expect((await u2.rpc("collection_integrity", { p_household: hid2 })).error).toBeNull();
  });

  it("利用ログの保存に失敗したら検出して記録する（日別統計に失敗件数）。費用は日別統計に残るので予算は過少にならない", async () => {
    const key = q6a("logfail-1");
    await sys.from("collection_candidates").insert({ household_id: hid, dedupe_key: key, source_url: key, title: "t", status: "pending", job_state: "pending", reasons: ["解析待ち"], draft: { queued: { kind: "web_page", url: key, title: "【抽選】失敗テスト", context: "テスト玩具 本店 11/20(金) 21:00まで 東京都", card: "失敗テスト商品 テスト玩具 本店 11/20(金) 21:00まで 東京都", sourceName: "pokeso", attempts: 0 } } as never });
    // ai_extraction_logs の挿入だけを失敗させる
    const failing = new Proxy(sys as unknown as Record<string, unknown>, {
      get(t, p) {
        if (p === "from") return (name: string) => (name === "ai_extraction_logs" ? { insert: async () => ({ error: { code: "23502" } }), select: () => (sys as unknown as { from: (n: string) => unknown }).from(name) } : (t.from as (n: string) => unknown)(name));
        const v = t[p as string];
        return typeof v === "function" ? (v as (...a: unknown[]) => unknown).bind(t) : v;
      },
    }) as unknown as Db;
    const before = (await sys.from("collection_daily_stats").select("ai_log_failures").eq("household_id", hid)).data!.reduce((a, r) => a + r.ai_log_failures, 0);
    await run(cronDeps({ db: failing }));
    const after = (await sys.from("collection_daily_stats").select("ai_log_failures").eq("household_id", hid)).data!.reduce((a, r) => a + r.ai_log_failures, 0);
    expect(after).toBe(before + 1);
  });

  // ------------------------------------------------------------ A1: 月額予算
  it("月額予算: 利用ログが空でも日別統計の費用が予算を超えていれば、有料AI解析を停止する（anthropic エンジン）", async () => {
    await u1.rpc("save_ai_budget", { p_budget: 3000, p_rate: 150, p_actor: profile });
    const day = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Tokyo", year: "numeric", month: "2-digit", day: "2-digit" }).format(NOW);
    await sys.from("collection_daily_stats").upsert({ household_id: hid, day, ai_calls: 9000, cost_jpy: 3100 } as never, { onConflict: "household_id,day" });
    const b = await monthBudget(sys, hid);
    expect(b.blocked).toBe(true);
    expect(b.statsCostJpy).toBeGreaterThanOrEqual(3100);
    const allow = await aiAllowance({ ...cronDeps(), extractor: { engine: "anthropic", extract: async () => { throw new Error("呼ばれてはいけない"); } } as never }, 8);
    expect(allow).toMatchObject({ allowed: 0, stop: "budget" });
  });
  it("月替わり: 前月の費用は今月に数えない", async () => {
    const d = new Date(NOW.getTime());
    const prev = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() - 1, 15));
    const prevDay = prev.toISOString().slice(0, 10);
    const today = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Tokyo", year: "numeric", month: "2-digit", day: "2-digit" }).format(NOW);
    await sys.from("collection_daily_stats").delete().eq("household_id", hid).eq("day", today);
    await sys.from("collection_daily_stats").upsert({ household_id: hid, day: prevDay, ai_calls: 9000, cost_jpy: 9000 } as never, { onConflict: "household_id,day" });
    const b = await monthBudget(sys, hid);
    expect(b.statsCostJpy).toBe(0);
    expect(b.blocked).toBe(false);
  });

  // ------------------------------------------------------------ C5: robots 制限のページを再解析しても一覧の情報を保持する
  it("robots制限: 一覧カード→初回AI解析→再解析（手動・自動）でカード情報が保持され、再解析も一覧カードで行える", async () => {
    const key = q6a("robots-1");
    const first = await cand(key);
    const d1 = first.draft as { listInfo?: { card?: string; fields?: unknown; hints?: unknown }; secondary?: string[] };
    expect(first.job_state).not.toBe("pending");
    expect(d1.listInfo?.card).toContain("テスト玩具 本店");
    expect(d1.listInfo?.fields).toMatchObject({ store: "テスト玩具 本店" });
    expect(d1.secondary?.join("")).toContain("取得制限"); // 一覧の表示（二次情報）から読み取った
    // 手動再解析と同じ組み立て（collection/route.ts の reanalyze）
    const queued = rebuildQueued(first.draft, { kind: "web_page", url: key, sourceName: "再解析", reason: "manual_reanalyze", changed: true, fallbackTitle: "t" });
    expect(queued.card).toBe(d1.listInfo?.card);
    await sys.from("collection_candidates").update({ job_state: "pending", status: "pending", attempts: 0, next_run_at: null, draft: { ...(first.draft as object), queued } as never }).eq("id", first.id);
    aiCalls = 0;
    await run(cronDeps());
    expect(aiCalls).toBe(1);
    const second = await cand(key);
    const d2 = second.draft as { listInfo?: { card?: string }; secondary?: string[] };
    expect(d2.listInfo?.card).toBe(d1.listInfo?.card);
    expect(d2.secondary?.join("")).toContain("取得制限"); // 元ページが取れなくても、保持した一覧カードで再解析できた
    const reasons = (await sys.from("ai_extraction_logs").select("trigger_reason").eq("household_id", hid).eq("actor_kind", "system").order("created_at")).data!.map((r) => r.trigger_reason);
    expect(reasons).toContain("manual_reanalyze");
    // 手動修正・登録済みの抽選には触れない（候補の行だけが変わる）
    expect((await sys.from("lotteries").select("id", { count: "exact", head: true }).eq("household_id", hid)).count).toBe(0);
  });

  // ------------------------------------------------------------ B1: 定期収集
  it("定期収集: 手動収集と独立に判定し、一部の収集元が失敗しても他を実行済みにせず、成功した収集元は重複取得しない", async () => {
    const mk = async (n: string) => (await sys.from("collection_sources").insert({ household_id: hid, kind: "web", name: `src-${n}`, url: q6a(`list-${n}`), adapter: "generic" } as never).select("id").single()).data!.id as string;
    const idA = await mk("a");
    const idB = await mk("b");
    const html = (n: string) => `<html><body><a href="https://shop-${n}.example.invalid/ev">ポケモンカード 抽選販売 11/28(土) 21:00まで</a></body></html>`;
    const listOk = (n: string) => async () => ({ ok: true as const, finalUrl: q6a(`list-${n}`), status: 200, contentType: "text/html", body: html(n), truncated: false });
    const slot = slotDateOf(NOW, 6);
    const noAi = { extractor: null };

    // 手動収集（ログイン・両方成功）: 定期収集の判定には数えない
    await runCollection({ ...cronDeps(noAi), db: u1, trigger: "manual", canRegister: true, actor: profile, fetchList: async (u) => (u.includes("list-a") ? listOk("a")() : listOk("b")()) });
    let plan = await planScheduledCollection(sys, hid, NOW, 6);
    expect(plan?.slotDate).toBe(slot);
    expect(plan?.due.sort()).toEqual([idA, idB].sort());

    // 定期収集 1回目: A は成功、B は取得制限
    const r1 = await runCollection({ ...cronDeps(noAi), scheduled: { slotDate: slot, sourceIds: plan!.due }, fetchList: async (u) => (u.includes("list-a") ? listOk("a")() : { ok: false as const, code: "robots" as const, message: "robots" }) });
    expect(r1.ok).toBe(true);
    const run1 = (await sys.from("collection_runs").select("slot_date,result,sources_total,sources_ok,sources_failed,items_found").eq("household_id", hid).eq("slot_date", slot).order("started_at", { ascending: false }).limit(1).single()).data!;
    expect(run1).toMatchObject({ slot_date: slot, result: "partial", sources_total: 2, sources_ok: 1, sources_failed: 1 });
    const att = (await sys.from("collection_source_attempts").select("source_id,status,items,trigger,slot_date").eq("household_id", hid).eq("slot_date", slot)).data!;
    expect(att.find((a) => a.source_id === idA)).toMatchObject({ status: "ok", items: 1, trigger: "cron" });
    expect(att.find((a) => a.source_id === idB)).toMatchObject({ status: "blocked" });

    // 直後は B の再試行待ち（5分おきの Cron で連続して取得しない）。A は実行済み
    plan = await planScheduledCollection(sys, hid, new Date(NOW.getTime() + 5 * 60_000), 6);
    expect(plan?.due).toEqual([]);
    expect(plan?.waiting).toEqual([idB]);
    expect(plan?.done).toEqual([idA]);
    // 30分後は B だけが再試行の対象
    plan = await planScheduledCollection(sys, hid, new Date(NOW.getTime() + 31 * 60_000), 6);
    expect(plan?.due).toEqual([idB]);

    // 再試行で B が成功 → 同日の定期収集は完了。以後は何も取得しない
    const r2 = await runCollection({ ...cronDeps(noAi), now: new Date(NOW.getTime() + 31 * 60_000), scheduled: { slotDate: slot, sourceIds: [idB] }, fetchList: listOk("b") });
    expect(r2.ok).toBe(true);
    plan = await planScheduledCollection(sys, hid, new Date(NOW.getTime() + 40 * 60_000), 6);
    expect(plan).toMatchObject({ due: [], waiting: [] });
    expect(plan?.done.sort()).toEqual([idA, idB].sort());

    // 同じ告知は重複した候補にならない（手動・定期・再試行で同じ宛先）
    for (const n of ["a", "b"]) {
      const rows = (await sys.from("collection_candidates").select("id").eq("household_id", hid).eq("dedupe_key", `https://shop-${n}.example.invalid/ev`)).data ?? [];
      expect(rows).toHaveLength(1);
    }
    // 他の世帯の取得結果は見えない
    expect((await u2.from("collection_source_attempts").select("id").eq("household_id", hid)).data ?? []).toHaveLength(0);
  });
});
