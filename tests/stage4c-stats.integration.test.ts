/**
 * Stage 4C 追加(運用調整)の結合テスト（実Supabase・RLS適用下。AI・外部サイトはモック）:
 * 日別統計の正確性（新規発見・AI解析・登録の区別、初回取込と通常の新着、重複取得の二重計上なし）、
 * 日次上限100件(既定)と一時的な変更(当日のみ)、月額予算の到達・安全側の停止と費用の記録(二重計上なし)。
 *   npm run test:db
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { getExtractor, type ExtractOutput, type ExtractRequest, type LotteryExtractor } from "@/lib/ai/provider";
import { runCollection, runWorker, type CollectDeps } from "@/lib/server/collector/run";
import { monthBudget } from "@/lib/server/ai-budget";
import { effectiveDailyLimit, jstDayString } from "@/lib/collector/queue";
import type { SafeFetchResult } from "@/lib/server/safe-fetch";
import type { Db } from "@/lib/server/lottery-service";
import { adminClient, cleanupTestUsers, dbTestsEnabled, signInTestUser } from "./helpers/db";

const NOW = new Date("2027-01-15T00:00:00+09:00");
const html = (b: string) => `<html><body>${b}</body></html>`;
const ok = (finalUrl: string, body: string): SafeFetchResult => ({ ok: true, finalUrl, status: 200, contentType: "text/html", body, truncated: false });
const PAGE = html("<p>ポケモンカード 拡張パック 抽選販売のお知らせ。サンプル電機 三宮店にて抽選販売を実施します。応募期間をご確認ください。</p>");

/** 実際のAIのように、トークン数つき（Haiku 5.5 の料金で計算される）の結果を返すモック */
function metered(input = 3000, output = 400): LotteryExtractor {
  const base = getExtractor({ AI_PROVIDER: "mock" })!;
  return {
    engine: "anthropic" as never,
    async extract(req: ExtractRequest): Promise<ExtractOutput> {
      const out = await base.extract(req);
      return { ...out, engine: "anthropic", model: "claude-haiku-5-5", usage: { input, output } };
    },
  };
}

describe.skipIf(!dbTestsEnabled)("Stage 4C: 日別統計・日次上限・月額予算", () => {
  const admin = adminClient();
  const userIds: string[] = [];
  let u1: Db;
  let hid: string;
  let profile: string;
  let pages: string[] = [];

  const deps = (over: Partial<CollectDeps> = {}): CollectDeps => ({
    db: u1,
    householdId: hid,
    trigger: "manual",
    now: NOW,
    actor: profile,
    canRegister: true,
    extractor: getExtractor({ AI_PROVIDER: "mock" }),
    xClient: null,
    fetchList: async () => ok("https://pokeso.jp/chusen", html("")),
    fetchPage: async (u) => {
      pages.push(u);
      return ok(u, PAGE);
    },
    fetchOembed: async () => ({ ok: true, text: "ポケモンカード 抽選販売", author: "x", notice: [], postedOn: "2027-01-10" }),
    ...over,
  });
  const setSettings = (patch: Record<string, unknown>) => u1.from("collection_settings").update(patch as never).eq("household_id", hid);
  const stat = async (day = jstDayString(NOW)) => (await u1.from("collection_daily_stats").select("*").eq("day", day).maybeSingle()).data;
  const a = (n: string, ctx = "1/20(水) 20:00まで 兵庫県・LivePocket") => `<a href="https://shop-s.example.invalid/lottery/${n}">ポケモンカード 抽選 ${ctx}</a>`;

  beforeAll(async () => {
    const x = await signInTestUser(admin, "s4cs", 1);
    userIds.push(x.userId);
    u1 = x.db;
    hid = (await u1.rpc("bootstrap_household")).data as string;
    profile = (await u1.from("profiles").select("id").order("sort_order")).data![0].id;
    const chain = (await u1.from("chains").insert({ household_id: hid, name: "サンプル電機" }).select("id").single()).data!.id;
    await u1.from("stores").insert({ household_id: hid, chain_id: chain, name: "三宮店", prefecture: "兵庫県" });
    await u1.from("products").insert({ household_id: hid, official_name: "テスト拡張パック「ひかりの森」", packs_per_box: 30 });
    await u1.from("collection_settings").insert({ household_id: hid, worker_enabled: true, worker_batch: 2 });
  });
  afterAll(async () => {
    await cleanupTestUsers(admin, userIds);
  });

  it("日次上限の既定は100件。1回の解析上限(ワーカー2件)はそのまま。上限は設定から変えられる", async () => {
    const s = (await u1.from("collection_settings").select("worker_daily_ai_limit,worker_batch,worker_limit_override").single()).data!;
    expect(s).toMatchObject({ worker_daily_ai_limit: 100, worker_batch: 2, worker_limit_override: null });
    await setSettings({ worker_daily_ai_limit: 30 });
    expect((await u1.from("collection_settings").select("worker_daily_ai_limit").single()).data!.worker_daily_ai_limit).toBe(30);
    await setSettings({ worker_daily_ai_limit: 100 });
  });

  it("日別統計: 初回の取り込みと通常の新着を区別し、同じ候補を何度取得しても新規発見を二重に数えない。新規発見・AI解析・登録は別の数字", async () => {
    const src = (await u1.from("collection_sources").insert({ household_id: hid, kind: "web", name: "s", url: "https://pokeso.jp/chusen", adapter: "pokeso" }).select("id").single()).data!.id;
    const run = (list: string, over: Partial<CollectDeps> = {}) => runCollection(deps({ fetchList: async () => ok("https://pokeso.jp/chusen", html(list)), onlySourceIds: [src], ...over }));
    // 初回: 5件を取り込む（うち1件は締切済み＝AI前に除外）。解析は上限(1回8件)の範囲で行う
    const first = [a("n1"), a("n2"), a("n3"), a("n4"), a("old", "1/10(日) 20:00まで 兵庫県・LivePocket")].join("<div></div>");
    const r1 = await run(first, { extractor: metered() });
    expect(r1.ok && r1.newCount).toBe(5);
    let st = (await stat())!;
    expect(st).toMatchObject({ discovered_initial: 5, discovered_new: 0, excluded: 1, ai_calls: 4 });
    expect(st.ai_success).toBe(4);
    expect(st.registered_new).toBe(1); // 同じ店舗・商品・締切なので、登録は1件、残り3件は重複
    expect(st.duplicates).toBe(3);
    expect(st.input_tokens).toBe(4 * 3000);
    expect(st.output_tokens).toBe(4 * 400);
    expect(Number(st.cost_jpy)).toBeCloseTo(4 * ((3000 * 0.1 + 400 * 0.5) / 1_000_000) * 150, 3);
    // 再取得（変化なし）: 何も加算されない
    const r2 = await run(first, { extractor: metered() });
    expect(r2.ok && r2.newCount).toBe(0);
    st = (await stat())!;
    expect(st).toMatchObject({ discovered_initial: 5, discovered_new: 0, ai_calls: 4, registered_new: 1 });
    // 通常運用の新着: 初回とは別に数える（収集元は取得済みなので『初回』ではない）
    await run(first + a("n5", "1/21(木) 20:00まで 兵庫県・LivePocket"), { extractor: metered() });
    st = (await stat())!;
    expect(st).toMatchObject({ discovered_initial: 5, discovered_new: 1, ai_calls: 5 });
    expect(st.queue_remaining).toBe(0);
  });

  it("統計は世帯ごとにRLSで分離され、日付は日本時間", async () => {
    const other = await signInTestUser(admin, "s4cs", 2);
    userIds.push(other.userId);
    await other.db.rpc("bootstrap_household");
    expect(((await other.db.from("collection_daily_stats").select("day")).data ?? []).length).toBe(0);
    expect((await stat())!.day).toBe("2027-01-15");
    const deny = await other.db.from("collection_daily_stats").update({ ai_calls: 0 }).eq("household_id", hid).select("day");
    expect(deny.data ?? []).toHaveLength(0);
  });

  it("日次上限: 上限に達したら新しい解析を始めない。当日だけ一時的に引き上げると再開し、翌日は通常に戻る", async () => {
    await setSettings({ worker_daily_ai_limit: 5 }); // 本日の解析数は既に5件
    const jobs = ["q1", "q2"].map((n) => ({ household_id: hid, dedupe_key: `https://q.example.invalid/${n}`, source_url: `https://q.example.invalid/${n}`, title: n, status: "pending", job_state: "pending", reasons: ["解析待ち"], draft: { queued: { kind: "web_page", url: `https://q.example.invalid/${n}`, title: n, context: "", sourceName: "t", attempts: 0 } } }));
    await u1.from("collection_candidates").insert(jobs as never);
    pages = [];
    const r1 = await runWorker(deps({ trigger: "cron", canRegister: false, extractor: metered() }));
    expect(JSON.stringify(r1)).toMatch(/上限|daily_limit/);
    expect(pages).toHaveLength(0); // 上限に達したらAIも呼ばず、ページも取得しない
    // 今日だけ上限を引き上げ（画面の操作と同じ更新）→ 再開
    await setSettings({ worker_limit_override: 150, worker_limit_override_date: jstDayString(NOW) });
    const row = (await u1.from("collection_settings").select("*").single()).data!;
    expect(effectiveDailyLimit(row as never, NOW)).toEqual({ limit: 150, overridden: true });
    const r2 = await runWorker(deps({ trigger: "cron", canRegister: false, extractor: metered() }));
    expect(r2.ok && "aiCalls" in r2 && r2.aiCalls).toBe(2);
    // 翌日(日本時間)は通常の設定に戻る
    expect(effectiveDailyLimit(row as never, new Date(NOW.getTime() + 24 * 3600_000))).toEqual({ limit: 5, overridden: false });
    await setSettings({ worker_limit_override: null, worker_limit_override_date: null, worker_daily_ai_limit: 100 });
  });

  it("月額予算: 実トークンから費用を計算して記録(二重計上なし)。レート変更が反映され、予算に近づくと安全側に止まり、日次上限を上げても再開しない。予算を戻せば再開", async () => {
    const b0 = await monthBudget(u1, hid);
    const logs = (await u1.from("ai_extraction_logs").select("input_tokens,output_tokens,engine").eq("household_id", hid)).data!;
    const real = logs.filter((l) => l.engine === "anthropic");
    const expected = real.reduce((sum, l) => sum + ((l.input_tokens! * 0.1 + l.output_tokens! * 0.5) / 1_000_000) * 150, 0);
    expect(b0.costJpy).toBeCloseTo(expected, 4);
    expect(b0.calls).toBe(real.length);
    // 統計の費用は、AI利用記録と同じ（同じ呼び出しを二重に数えない）
    const statsCost = ((await u1.from("collection_daily_stats").select("cost_jpy")).data ?? []).reduce((s, r) => s + Number(r.cost_jpy), 0);
    expect(statsCost).toBeCloseTo(expected, 3);
    // 為替レートの変更は費用に反映される
    expect((await u1.rpc("save_ai_budget", { p_budget: 3000, p_rate: 200, p_actor: profile })).error).toBeNull();
    const b1 = await monthBudget(u1, hid);
    expect(b1.rate).toBe(200);
    expect(b1.costJpy).toBeCloseTo((expected / 150) * 200, 4);
    // 予算を『残り5円』にする → 1回の見込み(約8円)に満たないので、新しい解析は始めない
    await u1.rpc("save_ai_budget", { p_budget: Math.ceil(b1.costJpy) + 5, p_rate: 200, p_actor: profile });
    const j = { household_id: hid, dedupe_key: "https://q.example.invalid/budget", source_url: "https://q.example.invalid/budget", title: "b", status: "pending", job_state: "pending", reasons: ["解析待ち"], draft: { queued: { kind: "web_page", url: "https://q.example.invalid/budget", title: "b", context: "", sourceName: "t", attempts: 0 } } };
    await u1.from("collection_candidates").insert(j as never);
    await setSettings({ worker_limit_override: 500, worker_limit_override_date: jstDayString(NOW), worker_daily_ai_limit: 500 });
    pages = [];
    const r = await runWorker(deps({ trigger: "cron", canRegister: false, extractor: metered() }));
    expect(JSON.stringify(r)).toContain("予算");
    expect(pages).toHaveLength(0); // 日次上限を上げても、予算が不足なら解析しない
    // 予算0円でも止まる
    await u1.rpc("save_ai_budget", { p_budget: 0, p_rate: 150, p_actor: profile });
    expect((await monthBudget(u1, hid)).blocked).toBe(true);
    // 予算を十分に戻せば再開する
    await u1.rpc("save_ai_budget", { p_budget: 3000, p_rate: 150, p_actor: profile });
    const r2 = await runWorker(deps({ trigger: "cron", canRegister: false, extractor: metered() }));
    expect(r2.ok && "aiCalls" in r2 && r2.aiCalls).toBe(1);
    expect((await u1.from("household_settings").select("ai_monthly_budget_jpy").single()).data!.ai_monthly_budget_jpy).toBe(3000);
  });
});
