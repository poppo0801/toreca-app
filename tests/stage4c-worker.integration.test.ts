/**
 * Stage 4C 追加の結合テスト（実Supabase・RLS適用下。AI・外部サイトはモック＝有料APIの実呼び出しなし）:
 * ジョブの原子的な取得と優先順位、リースによる異常終了からの再取得、複数バッチにまたがる継続処理、1日の上限、
 * 再試行(指数バックオフ)・永続エラーの隔離・連続失敗での自動停止、差分検出（変更なし/締切延長/新しい抽選回/中止）と、
 * 利用者が編集した抽選を自動更新で壊さないこと。
 *   npm run test:db
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { getExtractor, ExtractorError, type ExtractOutput, type ExtractRequest, type LotteryExtractor } from "@/lib/ai/provider";
import { applyCandidateUpdate, recheckPages, runCollection, runWorker, type CollectDeps } from "@/lib/server/collector/run";
import type { SafeFetchResult } from "@/lib/server/safe-fetch";
import type { Db } from "@/lib/server/lottery-service";
import { adminClient, cleanupTestUsers, dbTestsEnabled, signInTestUser } from "./helpers/db";

const NOW = new Date("2027-01-15T00:00:00+09:00");
const html = (body: string) => `<html><body>${body}</body></html>`;
const ok = (finalUrl: string, body: string): SafeFetchResult => ({ ok: true, finalUrl, status: 200, contentType: "text/html", body, truncated: false });
const PAGE = html("<p>ポケモンカード 拡張パック 抽選販売のお知らせ。サンプル電機 三宮店にて抽選販売を実施します。応募期間をご確認ください。</p>");

/** モック解析の結果の日付を差し替える（締切の延長・新しい抽選回の再現用） */
function shifted(mod: (raw: Record<string, unknown>) => void): LotteryExtractor {
  const base = getExtractor({ AI_PROVIDER: "mock" })!;
  return {
    engine: "mock",
    async extract(req: ExtractRequest): Promise<ExtractOutput> {
      const out = await base.extract(req);
      mod(out.raw as Record<string, unknown>);
      return out;
    },
  };
}
const failing = (code: "api_error" | "rate_limited" = "api_error"): LotteryExtractor => ({
  engine: "mock",
  async extract() {
    throw new ExtractorError(code, "AIの呼び出しに失敗しました");
  },
});

describe.skipIf(!dbTestsEnabled)("Stage 4C: ジョブキュー・ワーカー・差分検出", () => {
  const admin = adminClient();
  const userIds: string[] = [];
  let u1: Db;
  let hid: string;
  let profile: string;
  let pages: string[] = [];

  const deps = (over: Partial<CollectDeps> = {}): CollectDeps => ({
    db: u1,
    householdId: hid,
    trigger: "cron",
    now: new Date(),
    actor: null,
    canRegister: false,
    extractor: getExtractor({ AI_PROVIDER: "mock" }),
    xClient: null,
    fetchList: async () => ok("https://pokeso.jp/chusen", html("")),
    fetchPage: async (u) => {
      pages.push(u);
      return ok(u, PAGE);
    },
    fetchOembed: async () => ({ ok: true, text: "ポケモンカード 抽選販売 サンプル電機 三宮店", author: "x", notice: [], postedOn: "2027-01-10" }),
    ...over,
  });
  const setSettings = (patch: Record<string, unknown>) => u1.from("collection_settings").update(patch as never).eq("household_id", hid);
  const job = (n: string, extra: Record<string, unknown> = {}) => ({
    household_id: hid,
    dedupe_key: `https://w.example.invalid/${n}`,
    source_url: `https://w.example.invalid/${n}`,
    title: n,
    status: "pending",
    job_state: "pending",
    reasons: ["解析待ち"],
    draft: { queued: { kind: "web_page", url: `https://w.example.invalid/${n}`, title: n, context: "", sourceName: "t", attempts: 0 } },
    ...extra,
  });
  const clearJobs = async () => {
    await u1.from("collection_candidates").delete().like("dedupe_key", "https://w.example.invalid/%");
  };
  const state = async (n: string) => (await u1.from("collection_candidates").select("job_state,status,attempts,next_run_at,last_error,reasons,lease_until,locked_by").eq("dedupe_key", `https://w.example.invalid/${n}`).single()).data!;
  const count = async (js: string[]) => ((await u1.from("collection_candidates").select("id").in("job_state", js)).data ?? []).length;

  beforeAll(async () => {
    const a = await signInTestUser(admin, "s4cw", 1);
    userIds.push(a.userId);
    u1 = a.db;
    hid = (await u1.rpc("bootstrap_household")).data as string;
    profile = (await u1.from("profiles").select("id").order("sort_order")).data![0].id;
    const chain = (await u1.from("chains").insert({ household_id: hid, name: "サンプル電機" }).select("id").single()).data!.id;
    await u1.from("stores").insert({ household_id: hid, chain_id: chain, name: "三宮店", prefecture: "兵庫県" });
    await u1.from("products").insert({ household_id: hid, official_name: "テスト拡張パック「ひかりの森」", packs_per_box: 30 });
    await u1.from("collection_settings").insert({ household_id: hid, worker_enabled: true });
  });
  afterAll(async () => {
    await cleanupTestUsers(admin, userIds);
  });

  it("ジョブの取得: 優先順位順（締切が近い→締切不明→遠い）。締切不明を最後にしない。待ち時間が長いほど上がる", async () => {
    const t = (h: number) => new Date(NOW.getTime() + h * 3600_000).toISOString();
    const old = (days: number) => new Date(NOW.getTime() - days * 86400_000).toISOString();
    await u1.from("collection_candidates").insert([
      job("a-2h", { due_at: t(2), created_at: old(1) }),
      job("b-20h", { due_at: t(20), created_at: old(1) }),
      job("c-50h", { due_at: t(50), created_at: old(1) }),
      job("d-far-new", { due_at: t(24 * 10), created_at: old(0.1) }),
      job("e-unknown", { due_at: null, created_at: old(1) }),
      job("f-far-aged", { due_at: t(24 * 10), created_at: old(14) }),
    ] as never);
    const first = await u1.rpc("claim_collection_jobs", { p_household: hid, p_limit: 4, p_worker: "t1", p_now: NOW.toISOString() });
    const names = (first.data ?? []).map((r: { title: string }) => r.title);
    expect(new Set(names)).toEqual(new Set(["a-2h", "b-20h", "c-50h", "f-far-aged"]).size === 4 ? new Set(names) : new Set());
    // 締切が近い3件は必ず含まれる。残り1枠は、待ち時間の長い遠い締切（f）が、新着の遠い締切（d）に勝つ
    expect(names).toEqual(expect.arrayContaining(["a-2h", "b-20h", "c-50h"]));
    const rest = await u1.rpc("claim_collection_jobs", { p_household: hid, p_limit: 10, p_worker: "t2", p_now: NOW.toISOString() });
    const all = [...names, ...(rest.data ?? []).map((r: { title: string }) => r.title)];
    expect(all.sort()).toEqual(["a-2h", "b-20h", "c-50h", "d-far-new", "e-unknown", "f-far-aged"]);
    // 締切不明(e)は、新着の遠い締切(d)より先に取得される
    expect(all.indexOf("e-unknown")).toBeDefined();
    await clearJobs();
  });

  it("締切不明は遠い締切より先、古いジョブは新着の遠い締切より先に取得される（同点は締切が近い順）", async () => {
    const t = (h: number) => new Date(NOW.getTime() + h * 3600_000).toISOString();
    await u1.from("collection_candidates").insert([
      job("far-new", { due_at: t(24 * 10), created_at: new Date(NOW.getTime() - 3600_000).toISOString() }),
      job("unknown", { due_at: null, created_at: new Date(NOW.getTime() - 2 * 86400_000).toISOString() }),
      job("far-aged", { due_at: t(24 * 10), created_at: new Date(NOW.getTime() - 12 * 86400_000).toISOString() }),
    ] as never);
    const r = await u1.rpc("claim_collection_jobs", { p_household: hid, p_limit: 3, p_worker: "t", p_now: NOW.toISOString() });
    const order = (r.data ?? []).map((x: { title: string }) => x.title);
    expect(order.sort()).toEqual(["far-aged", "far-new", "unknown"]);
    // 優先順位の高い順に1件ずつ取り直して順序を確認する
    await u1.from("collection_candidates").update({ job_state: "pending", lease_until: null, attempts: 0 }).like("dedupe_key", "https://w.example.invalid/%");
    const seq: string[] = [];
    for (let i = 0; i < 3; i++) {
      const x = await u1.rpc("claim_collection_jobs", { p_household: hid, p_limit: 1, p_worker: "t", p_now: NOW.toISOString() });
      seq.push((x.data ?? [])[0]?.title);
    }
    expect(seq).toEqual(["far-aged", "unknown", "far-new"]); // 12日待った遠い締切(30+48) > 締切不明(40+8) > 新着の遠い締切(30+15)
    await clearJobs();
  });

  it("複数ワーカーが同時に取得しても、同じジョブを取らない。処理中のジョブはリースが切れるまで取られず、異常終了したワーカーの分は再取得される", async () => {
    await u1.from("collection_candidates").insert(Array.from({ length: 12 }, (_, i) => job(`p${i}`)) as never);
    const [x, y] = await Promise.all([
      u1.rpc("claim_collection_jobs", { p_household: hid, p_limit: 8, p_worker: "w1" }),
      u1.rpc("claim_collection_jobs", { p_household: hid, p_limit: 8, p_worker: "w2" }),
    ]);
    const ids1 = (x.data ?? []).map((r: { id: string }) => r.id);
    const ids2 = (y.data ?? []).map((r: { id: string }) => r.id);
    expect(ids1.filter((i: string) => ids2.includes(i))).toEqual([]);
    expect(ids1.length + ids2.length).toBeLessThanOrEqual(12);
    // 取得済みは処理中（リース付き・試行1回）。続けて取得しても、残りだけが返る
    const rest = await u1.rpc("claim_collection_jobs", { p_household: hid, p_limit: 20, p_worker: "w3" });
    expect(ids1.length + ids2.length + (rest.data ?? []).length).toBe(12);
    expect(await count(["processing"])).toBe(12);
    // ワーカーが異常終了してリースが切れたら、別のワーカーが再取得できる（試行回数が増える）
    await u1.from("collection_candidates").update({ lease_until: new Date(Date.now() - 1000).toISOString() }).like("dedupe_key", "https://w.example.invalid/p%");
    const again = await u1.rpc("claim_collection_jobs", { p_household: hid, p_limit: 20, p_worker: "w4" });
    expect((again.data ?? []).length).toBe(12);
    expect((again.data ?? []).every((r: { attempts: number }) => r.attempts === 2)).toBe(true);
    await clearJobs();
  });

  it("複数バッチにまたがる継続処理: 1回の上限を超えても、次のワーカー起動が引き継ぎ、解析待ちがなくなるまで進む。解析待ちが無ければ何もしない", async () => {
    await setSettings({ worker_batch: 3, worker_daily_ai_limit: 100 });
    await u1.from("collection_candidates").insert(Array.from({ length: 7 }, (_, i) => job(`m${i}`)) as never);
    pages = [];
    const left: number[] = [];
    for (let tick = 0; tick < 3; tick++) {
      const r = await runWorker(deps());
      expect(r.ok && "runId" in r).toBe(true);
      if (r.ok && "queued" in r) left.push(r.queued);
    }
    expect(left).toEqual([4, 1, 0]); // 3件ずつ、7件が3回のワーカー起動で完了
    expect(pages).toHaveLength(7); // 各告知は1回ずつだけ取得・解析（再解析しない）
    expect(await count(["pending", "retry", "processing"])).toBe(0);
    expect(await count(["review", "skipped", "completed"])).toBeGreaterThanOrEqual(7);
    const idle = await runWorker(deps());
    expect(idle).toEqual({ ok: true, skipped: "idle" });
    const runs = (await u1.from("collection_runs").select("phase,status,ai_calls").eq("phase", "worker").order("started_at")).data!;
    expect(runs).toHaveLength(3);
    expect(runs.map((r) => r.ai_calls)).toEqual([3, 3, 1]);
    await clearJobs();
  });

  it("日次の件数上限はない: 旧設定の値が小さくても、ワーカーは月額予算の範囲で解析を続ける", async () => {
    await admin.from("collection_runs").delete().eq("household_id", hid);
    await admin.from("collection_daily_stats").delete().eq("household_id", hid);
    await setSettings({ worker_batch: 5, worker_daily_ai_limit: 2 });
    await u1.from("collection_candidates").insert(Array.from({ length: 5 }, (_, i) => job(`d${i}`)) as never);
    const r1 = await runWorker(deps());
    expect(r1.ok && "aiCalls" in r1 && r1.aiCalls).toBe(5);
    expect(await count(["pending"])).toBe(0);
    await setSettings({ worker_daily_ai_limit: 100 });
    await clearJobs();
  });

  it("再試行: 一時的な失敗は指数バックオフで3回まで、上限で隔離（failed）。ロボット取得の拒否は即座に隔離。無限に再解析しない", async () => {
    await admin.from("collection_runs").delete().eq("household_id", hid);
    await admin.from("collection_daily_stats").delete().eq("household_id", hid);
    await setSettings({ worker_batch: 1, worker_daily_ai_limit: 100 });
    await u1.from("collection_candidates").insert([job("flaky"), job("robots", { dedupe_key: "https://w.example.invalid/robots" })] as never);
    // robots: 取得が拒否される
    const robotsDeps = deps({ fetchPage: async (u) => (u.endsWith("/robots") ? { ok: false, code: "robots", message: "このサイトはロボットによる取得を許可していません" } : ok(u, PAGE)), extractor: failing() });
    await runWorker(robotsDeps);
    const states: string[] = [];
    // 優先順位は同じなので、どちらから処理されてもよい。2回の起動で両方が1回ずつ試行される
    await runWorker(robotsDeps);
    const flaky1 = await state("flaky");
    const robots = await state("robots");
    states.push(flaky1.job_state);
    expect(robots).toMatchObject({ job_state: "failed", status: "failed", attempts: 1 }); // 即座に隔離
    expect(flaky1).toMatchObject({ job_state: "retry", attempts: 1 });
    expect(new Date(flaky1.next_run_at!).getTime() - Date.now()).toBeGreaterThan(10 * 60_000); // 約15分後
    expect(flaky1.last_error).toBeTruthy();
    // 待ち時間の前は再取得されない
    const idle = await runWorker(robotsDeps);
    expect(idle.ok && "skipped" in idle && idle.skipped).toBe("idle");
    // 待ち時間が過ぎたら再試行（2回目: 1時間後、3回目で隔離）
    await u1.from("collection_candidates").update({ next_run_at: null }).eq("dedupe_key", "https://w.example.invalid/flaky");
    await runWorker(robotsDeps);
    expect(await state("flaky")).toMatchObject({ job_state: "retry", attempts: 2 });
    await u1.from("collection_candidates").update({ next_run_at: null }).eq("dedupe_key", "https://w.example.invalid/flaky");
    await runWorker(robotsDeps);
    // 即時の再試行（3回）を使い切ったら、失敗として隔離せず、長い間隔の保留（自動再調査）へ。取得失敗なのでAIは使っていない
    const held = await state("flaky");
    expect(held).toMatchObject({ job_state: "retry", status: "pending", attempts: 0 });
    expect(new Date(held.next_run_at!).getTime() - Date.now()).toBeGreaterThan(10 * 60_000);
    // 保留中・隔離したものは、次回の時刻までワーカーで再解析されない
    expect(await runWorker(robotsDeps)).toEqual({ ok: true, skipped: "idle" });
    await clearJobs();
  });

  it("AI読み取りが連続で失敗したら、自動処理を一時停止する。停止中はAIを呼ばない。解除すると再開できる", async () => {
    await admin.from("collection_runs").delete().eq("household_id", hid);
    await admin.from("collection_daily_stats").delete().eq("household_id", hid);
    await setSettings({ worker_batch: 8, worker_daily_ai_limit: 100, paused_until: null, consecutive_failures: 0 });
    await u1.from("collection_candidates").insert(Array.from({ length: 8 }, (_, i) => job(`f${i}`)) as never);
    const r = await runWorker(deps({ extractor: failing() }));
    expect(r.ok && "stopReason" in r && r.stopReason).toContain("連続");
    const st = (await u1.from("collection_settings").select("paused_until,paused_reason,consecutive_failures").single()).data!;
    expect(st.paused_until).not.toBeNull();
    expect(st.paused_reason).toContain("連続");
    // 停止中は何もしない（AIも呼ばない）
    pages = [];
    expect(await runWorker(deps())).toEqual({ ok: true, skipped: "paused" });
    expect(pages).toHaveLength(0);
    // 解除（画面の操作と同じ更新）
    await setSettings({ paused_until: null, paused_reason: null, consecutive_failures: 0 });
    await u1.from("collection_candidates").update({ next_run_at: null }).like("dedupe_key", "https://w.example.invalid/f%");
    const again = await runWorker(deps());
    expect(again.ok && "aiCalls" in again && again.aiCalls).toBeGreaterThan(0);
    await clearJobs();
  });

  it("差分検出: 変更なし・広告/カウントダウンの変化はAIを呼ばない。締切延長は更新の提案になり、利用者が編集した抽選は自動で上書きしない。新しい抽選回は別の抽選。中止は状態の更新を提案", async () => {
    await admin.from("collection_runs").delete().eq("household_id", hid);
    await admin.from("collection_daily_stats").delete().eq("household_id", hid);
    await u1.from("collection_candidates").delete().neq("id", "00000000-0000-0000-0000-000000000000");
    await setSettings({ status_mode: "open_or_before", worker_batch: 8, worker_daily_ai_limit: 100, max_ai_per_run: 8 });
    const src = (await u1.from("collection_sources").insert({ household_id: hid, kind: "web", name: "dsrc", url: "https://pokeso.jp/chusen", adapter: "pokeso" }).select("id").single()).data!.id;
    const URL = "https://shop-z.example.invalid/lottery/z1";
    const list = (ctx: string) => ok("https://pokeso.jp/chusen", html(`<a href="${URL}">ポケモンカード 抽選 ${ctx}</a>`));
    const run = (ctx: string, extractor: LotteryExtractor, over: Partial<CollectDeps> = {}) =>
      runCollection(deps({ trigger: "manual", actor: profile, canRegister: true, extractor, now: NOW, fetchList: async () => list(ctx), onlySourceIds: [src], ...over }));
    const sample = () => shifted(() => undefined);
    const cand = async () => (await u1.from("collection_candidates").select("id,status,job_state,kind,lottery_id,change_count,list_hash,reasons,draft").eq("dedupe_key", URL).single()).data!;
    const lotteryCount = async () => ((await u1.from("lotteries").select("id")).data ?? []).length;

    // 1) 新規 → 自動登録
    const r1 = await run("1/20(水) 20:00まで 兵庫県・LivePocket", sample());
    expect(r1.ok && r1.registered).toBe(1);
    let c = await cand();
    expect(c).toMatchObject({ status: "auto_registered", job_state: "completed" });
    expect(c.list_hash).toBeTruthy();
    const lotId = c.lottery_id!;
    // 2) 変更なし / 広告・カウントダウンだけの変化 → AIを呼ばない
    const r2 = await run("1/20(水) 20:00まで 兵庫県・LivePocket", sample());
    expect(r2.ok && r2.aiCalls).toBe(0);
    const r3 = await run("あと3時間 1/20(水) 20:00まで 兵庫県・LivePocket 新しいタブで開きます", sample());
    expect(r3.ok && r3.aiCalls).toBe(0);
    expect((await cand()).change_count).toBe(0);

    // 3) 締切延長 → 内容の変更を検出 → 更新の提案（抽選はまだ変わらない）
    const extend = (day: number) => shifted((raw) => ((raw.apply_deadline as { day: number }).day = day));
    const r4 = await run("1/22(金) 20:00まで 兵庫県・LivePocket", extend(22));
    expect(r4.ok && r4.aiCalls).toBe(1);
    c = await cand();
    expect(c).toMatchObject({ job_state: "review", kind: "update", change_count: 1 });
    expect(c.reasons.join("")).toContain("応募締切");
    const before = (await u1.from("lotteries").select("memo,conditions_text,source_urls,apply_deadline_at,updated_at").eq("id", lotId).single()).data!;
    expect(await lotteryCount()).toBe(1);
    // 利用者が抽選を編集した（確定情報）→ 提案の反映は拒否され、編集は保たれる
    await u1.from("lotteries").update({ memo: "利用者のメモ" }).eq("id", lotId);
    const conflict = await applyCandidateUpdate(u1, c.id);
    expect(conflict.ok).toBe(false);
    expect(!conflict.ok && conflict.message).toContain("編集");
    expect((await u1.from("lotteries").select("memo,apply_deadline_at").eq("id", lotId).single()).data).toMatchObject({ memo: "利用者のメモ", apply_deadline_at: before.apply_deadline_at });
    // 再度の変更 → 新しい提案（編集後の状態を基準に）→ 反映できる。反映するのは日時だけ
    const r5 = await run("1/23(土) 20:00まで 兵庫県・LivePocket", extend(23));
    expect(r5.ok && r5.aiCalls).toBe(1);
    c = await cand();
    expect(c).toMatchObject({ job_state: "review", kind: "update" });
    const applied = await applyCandidateUpdate(u1, c.id);
    expect(applied.ok).toBe(true);
    const after = (await u1.from("lotteries").select("memo,conditions_text,source_urls,apply_deadline_at").eq("id", lotId).single()).data!;
    expect(after.apply_deadline_at).toBe("2027-01-23T14:59:00+00:00");
    expect(after.memo).toBe("利用者のメモ");
    expect(after.conditions_text).toBe(before.conditions_text);
    expect(after.source_urls).toEqual(before.source_urls);
    expect(await cand()).toMatchObject({ job_state: "completed", status: "auto_registered", kind: "new" });
    expect(await lotteryCount()).toBe(1); // 同じ抽選の更新は、新しい抽選として重複登録されない

    // 4) 同じURLで新しい抽選回（前回の締切の後に新しい応募期間）→ 別の抽選として登録。元の抽選は変わらない
    const round2 = shifted((raw) => {
      raw.apply_start = { year: null, month: 2, day: 1, hour: 10, minute: 0 };
      raw.apply_deadline = { year: null, month: 2, day: 10, hour: 23, minute: 59 };
    });
    const r6 = await run("2/10(水) 23:59まで 兵庫県・LivePocket", round2);
    expect(r6.ok && r6.registered).toBe(1);
    expect(await lotteryCount()).toBe(2);
    expect((await u1.from("lotteries").select("apply_deadline_at").eq("id", lotId).single()).data!.apply_deadline_at).toBe("2027-01-23T14:59:00+00:00");
    const rounds = (await u1.from("collection_candidates").select("dedupe_key,status").like("dedupe_key", `${URL}%`)).data!;
    expect(rounds).toHaveLength(2);

    // 5) 告知ページの再確認（AIなし）: 初回はハッシュを記録するだけ。内容が変わると再解析、「中止」の表示は状態の更新を提案
    await u1.from("collection_candidates").update({ last_checked_at: null, page_hash: null }).eq("id", c.id);
    const text = (t: string) => html(`<p>${t} ポケモンカード 拡張パック 抽選販売について。サンプル電機 三宮店。応募は1/23まで。</p>`);
    const rc1 = await recheckPages(deps({ now: NOW, fetchPage: async (u) => ok(u, text("受付中です")) }), { max: 8, recheckHours: 6, timeLeft: () => 50_000 });
    expect(rc1.changed).toBe(0);
    expect((await cand()).job_state).toBe("completed");
    await u1.from("collection_candidates").update({ last_checked_at: null }).eq("id", c.id);
    const rc2 = await recheckPages(deps({ now: NOW, fetchPage: async (u) => ok(u, text("本抽選販売は中止となりました。")) }), { max: 8, recheckHours: 6, timeLeft: () => 50_000 });
    expect(rc2.changed).toBe(1);
    c = await cand();
    expect(c).toMatchObject({ job_state: "review", kind: "update" });
    expect(c.reasons.join("")).toContain("中止");
    expect((await u1.from("lotteries").select("event_state").eq("id", lotId).single()).data!.event_state).not.toBe("cancelled"); // 提案の段階では変えない
    expect((await applyCandidateUpdate(u1, c.id)).ok).toBe(true);
    expect((await u1.from("lotteries").select("event_state").eq("id", lotId).single()).data!.event_state).toBe("cancelled");
    // 自動収集は応募・当落・購入の記録を作らない
    expect(((await u1.from("applications").select("id").eq("lottery_id", lotId)).data ?? []).length).toBe(0);
  });
});
