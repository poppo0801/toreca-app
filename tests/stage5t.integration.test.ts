/**
 * Stage 5T: 月額予算の予約・保留（自動再調査）と要手動確認・収集元の除外ルール・取得困難の記録（実Supabase・RLS適用下。AI・外部サイトはモック。架空データのみ）
 *   npm run test:db
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { getExtractor } from "@/lib/ai/provider";
import { DEFAULT_CONDITIONS } from "@/lib/collector/conditions";
import { loadAppData, type Db } from "@/lib/server/lottery-service";
import { processQueue, type CollectDeps } from "@/lib/server/collector/run";
import { runHoldPass } from "@/lib/server/collector/hold";
import { recordHardSource } from "@/lib/server/collector/sources-health";
import { adminClient, cleanupTestUsers, dbTestsEnabled, signInTestUser } from "./helpers/db";

const NOW = new Date();

describe.skipIf(!dbTestsEnabled)("Stage 5T", () => {
  const admin = adminClient();
  const userIds: string[] = [];
  let u1: Db;
  let hid: string;
  let profile: string;
  let aiCalls = 0;
  const url = (n: string) => `https://q5t.example.invalid/${n}`;

  const deps = (): CollectDeps => ({
    db: u1, householdId: hid, trigger: "manual", now: NOW, actor: profile, canRegister: true,
    extractor: { engine: "mock", extract: async (r) => { aiCalls++; return getExtractor({ AI_PROVIDER: "mock" })!.extract(r); } },
    xClient: null,
    fetchPage: async () => ({ ok: false, code: "timeout", message: "ページの取得がタイムアウトしました" }),
    fetchOembed: async () => ({ ok: false, message: "x" }),
  });
  const run = async () => processQueue(deps(), { settings: { auto_register: false }, cond: DEFAULT_CONDITIONS, data: await loadAppData(u1, hid), aiLeft: 20, timeLeft: () => 50_000, perBatch: 4 });
  const get = async (key: string) => (await u1.from("collection_candidates").select("status,job_state,triage,triage_reason,hold_count,next_run_at,manual_state,manual_reason,reasons,fail_kind,fetch_methods").eq("dedupe_key", key).single()).data!;

  beforeAll(async () => {
    const a = await signInTestUser(admin, "s5t", 1);
    userIds.push(a.userId);
    u1 = a.db;
    hid = (await u1.rpc("bootstrap_household")).data as string;
    profile = (await u1.from("profiles").select("id").order("sort_order")).data![0].id;
    await u1.from("collection_settings").insert({ household_id: hid, auto_register: false, worker_enabled: false });
  });
  afterAll(async () => {
    await u1.from("collection_candidates").delete().like("dedupe_key", "%q5t.example.invalid%");
    await cleanupTestUsers(admin, userIds);
  });

  // ------------------------------------------------------------ 月額予算の予約
  it("予約: 並列で同時に要求しても、予算を超える分は許可されない", async () => {
    const results = await Promise.all(Array.from({ length: 6 }, () => u1.rpc("reserve_ai_budget", { p_household: hid, p_est_jpy: 8, p_month_cost_jpy: 2980, p_budget_jpy: 3000, p_ttl_seconds: 60 })));
    const granted = results.filter((r: { error: unknown; data: unknown }) => !r.error && r.data).length;
    expect(granted).toBe(2); // 残り20円 / 見込み8円 = 2件まで（実費2980＋予約16＋次の8 > 3000）
    // 予算を超える見込みは許可されない（予算超過）
    const over = await u1.rpc("reserve_ai_budget", { p_household: hid, p_est_jpy: 8, p_month_cost_jpy: 3000, p_budget_jpy: 3000, p_ttl_seconds: 60 });
    expect(over.data).toBeNull();
  });
  it("予約: 他の世帯の予約操作はできない（RLS／関数内の検査）。予約の表は直接読めない", async () => {
    const other = await signInTestUser(admin, "s5t", 2);
    userIds.push(other.userId);
    await other.db.rpc("bootstrap_household");
    const r = await other.db.rpc("reserve_ai_budget", { p_household: hid, p_est_jpy: 1, p_month_cost_jpy: 0, p_budget_jpy: 3000, p_ttl_seconds: 60 });
    expect(r.error).not.toBeNull();
    expect((await u1.from("ai_budget_reservations").select("id")).data ?? []).toHaveLength(0);
  });
  it("予算不足の並列バッチ: 解析せず待機に残し（除外・完了にしない）、試行回数を戻して理由を返す", async () => {
    await u1.rpc("save_ai_budget", { p_budget: 5, p_rate: 150, p_actor: profile }); // 見込み(最大8円)に満たない
    const jobs = ["b1", "b2"].map((n) => ({ household_id: hid, dedupe_key: url(n), source_url: url(n), title: n, status: "pending", job_state: "pending", reasons: ["解析待ち"], draft: { queued: { kind: "web_page", url: url(n), title: n, context: "", sourceName: "t", attempts: 0 } } }));
    await u1.from("collection_candidates").insert(jobs as never);
    aiCalls = 0;
    // 実エンジンでの予約を検証するため anthropic 相当のエンジン名で動かす（AI呼び出しはモック）
    const d = deps();
    d.extractor = { engine: "anthropic", extract: async (r: never) => { aiCalls++; return getExtractor({ AI_PROVIDER: "mock" })!.extract(r); } } as never;
    const q = await processQueue(d, { settings: { auto_register: false }, cond: DEFAULT_CONDITIONS, data: await loadAppData(u1, hid), aiLeft: 20, timeLeft: () => 50_000, perBatch: 4 });
    expect(aiCalls).toBe(0);
    expect(q.aiCalls).toBe(0);
    for (const n of ["b1", "b2"]) {
      const c = await get(url(n));
      expect(c.job_state).toBe("pending");
      expect(c.status).toBe("pending");
    }
    await u1.rpc("save_ai_budget", { p_budget: 3000, p_rate: 150, p_actor: profile });
  });

  // ------------------------------------------------------------ 保留（自動再調査）と要手動確認
  const addReview = async (n: string, dueInHours: number | null, extra: Record<string, unknown> = {}) => {
    const { error } = await u1.from("collection_candidates").insert({ household_id: hid, dedupe_key: url(n), source_url: null, title: n, status: "pending", job_state: "review", kind: "new", reasons: ["店舗を確実に特定できません"], due_at: dueInHours === null ? null : new Date(NOW.getTime() + dueInHours * 3600_000).toISOString(), draft: null, ...extra } as never);
    expect(error).toBeNull();
  };
  it("締切に余裕がある確認待ちは、手動確認に送らず保留（自動再調査）にする。次回時刻は内部で設定される", async () => {
    await addReview("hold-ok", 24 * 6);
    const out = await runHoldPass(deps(), { max: 10, timeLeft: () => 30_000 });
    expect(out.checked).toBeGreaterThan(0);
    const c = await get(url("hold-ok"));
    expect(c.triage).toBe("auto_retry");
    expect(c.hold_count).toBe(1);
    expect(new Date(c.next_run_at!).getTime()).toBeGreaterThan(NOW.getTime());
    expect(c.job_state).toBe("review");
  });
  it("締切が近いのに情報が足りない候補は、規定回数に達していなくても要手動確認（未対応）にする", async () => {
    await addReview("hold-urgent", 10);
    await runHoldPass(deps(), { max: 10, timeLeft: () => 30_000 });
    const c = await get(url("hold-urgent"));
    expect(c.triage).toBe("manual");
    expect(c.manual_state).toBe("open");
    expect(c.manual_reason).toContain("取得できていません");
  });
  it("保留は規定回数で打ち切り、無限に再調査しない（要手動確認へ）。次回時刻前の候補は再調査しない", async () => {
    await addReview("hold-cap", null, { triage: "auto_retry", hold_count: 6, next_run_at: new Date(NOW.getTime() - 60_000).toISOString() });
    await addReview("hold-wait", 24 * 6, { triage: "auto_retry", hold_count: 1, next_run_at: new Date(NOW.getTime() + 3600_000).toISOString() });
    await runHoldPass(deps(), { max: 10, timeLeft: () => 30_000 });
    expect((await get(url("hold-cap"))).triage).toBe("manual");
    const w = await get(url("hold-wait"));
    expect(w.triage).toBe("auto_retry");
    expect(w.hold_count).toBe(1); // まだ次回の時刻前なので変わらない
  });
  it("受付終了の保留候補は自動除外（理由を残し、削除しない）", async () => {
    await addReview("hold-past", -5, { triage: "auto_retry", hold_count: 1, next_run_at: new Date(NOW.getTime() - 60_000).toISOString() });
    await runHoldPass(deps(), { max: 10, timeLeft: () => 30_000 });
    const c = await get(url("hold-past"));
    expect(c.status).toBe("excluded");
    expect(c.triage).toBe("auto_exclude");
    expect(c.reasons[0]).toContain("受付終了");
  });
  it("取得が一時的に失敗し続けても、保留に入り、AIは呼ばない（取得失敗はAI未使用）", async () => {
    const queued = { kind: "web_page", url: url("fetch-fail"), title: "応募する", context: "", sourceName: "t", attempts: 0 };
    // 試行回数が上限に達している状態（即時の再試行を使い切った）
    await u1.from("collection_candidates").insert({ household_id: hid, dedupe_key: url("fetch-fail"), source_url: url("fetch-fail"), title: "f", status: "pending", job_state: "retry", attempts: 2, reasons: ["再試行待ち"], due_at: new Date(NOW.getTime() + 24 * 5 * 3600_000).toISOString(), draft: { queued } as never } as never);
    aiCalls = 0;
    await run();
    const c = await get(url("fetch-fail"));
    expect(aiCalls).toBe(0);
    expect(c.triage).toBe("auto_retry");
    expect(c.job_state).toBe("retry");
    expect(new Date(c.next_run_at!).getTime()).toBeGreaterThan(NOW.getTime());
  });

  // ------------------------------------------------------------ 収集元の除外ルール
  it("Xアカウントの除外ルールに一致する投稿は、AIを呼ばずに除外する。ほかのアカウントは影響を受けない", async () => {
    expect((await u1.from("collection_exclusions").insert({ household_id: hid, scope: "x_account", key: "badshop", label: "@badshop", reason_code: "untrusted_shop", created_by_profile_id: profile } as never)).error).toBeNull();
    const post = (id: string) => ({ id, text: "ポケモンカード 抽選のお知らせ", images: [], links: [], createdAt: NOW.toISOString() });
    for (const [n, src] of [["9000001", "badshop"], ["9000002", "goodshop"]] as const) {
      const queued = { kind: "x_post", url: `https://x.com/${src}/status/${n}`, title: "t", context: "", sourceName: src, attempts: 0, post: post(n) };
      await u1.from("collection_candidates").insert({ household_id: hid, dedupe_key: `x:${n}-q5t.example.invalid`, source_url: queued.url, x_post_id: n, title: n, status: "pending", job_state: "pending", reasons: ["解析待ち"], draft: { queued } as never } as never);
    }
    aiCalls = 0;
    await run();
    const bad = await get("x:9000001-q5t.example.invalid");
    expect(bad.status).toBe("excluded");
    expect(bad.triage).toBe("auto_exclude");
    const good = await get("x:9000002-q5t.example.invalid");
    expect(good.triage).not.toBe("auto_exclude");
    expect(aiCalls).toBe(1); // 除外した分はAIを呼んでいない
  });
  it("除外ルールは解除でき（履歴として残る）、物理削除はできない。他の世帯からは見えない", async () => {
    const rule = (await u1.from("collection_exclusions").select("id,active").eq("key", "badshop").single()).data!;
    expect(rule.active).toBe(true);
    const del = await u1.from("collection_exclusions").delete().eq("id", rule.id).select("id");
    expect(del.data ?? []).toHaveLength(0);
    expect((await u1.from("collection_exclusions").update({ active: false, released_at: new Date().toISOString(), released_by_profile_id: profile }).eq("id", rule.id)).error).toBeNull();
    expect((await u1.from("collection_exclusions").select("active").eq("id", rule.id).single()).data!.active).toBe(false);
    const other = await signInTestUser(admin, "s5t", 3);
    userIds.push(other.userId);
    await other.db.rpc("bootstrap_household");
    expect((await other.db.from("collection_exclusions").select("id")).data ?? []).toHaveLength(0);
    expect((await other.db.from("collection_hard_sources").select("id")).data ?? []).toHaveLength(0);
  });

  // ------------------------------------------------------------ 取得困難の記録
  it("取得困難の記録: 店舗×応募サービスで記録し、代替取得の成功で手動確認の要求が外れる。別の店舗は影響を受けない", async () => {
    const chain = (await u1.from("chains").insert({ household_id: hid, name: "テスト系列5T" } as never).select("id").single()).data!;
    const s1 = (await u1.from("stores").insert({ household_id: hid, chain_id: chain.id, name: "テスト店A" } as never).select("id").single()).data!;
    const s2 = (await u1.from("stores").insert({ household_id: hid, chain_id: chain.id, name: "テスト店B" } as never).select("id").single()).data!;
    const u = "https://shoplottery.e-starbox.com/lottery/1";
    await recordHardSource(u1, hid, NOW, { url: u, chainId: chain.id, storeId: s1.id, storeName: "テスト店A", failKind: "robots" });
    let rows = (await u1.from("collection_hard_sources").select("scope,key,needs_manual,fail_count,alt_success").eq("household_id", hid)).data!;
    expect(rows.filter((r) => !r.key.includes("q5t.example.invalid")).map((r) => r.scope).sort()).toEqual(["service", "store"]);
    expect(rows.find((r) => r.scope === "store")!.needs_manual).toBe(true);
    await recordHardSource(u1, hid, NOW, { url: u, chainId: chain.id, storeId: s1.id, storeName: "テスト店A", failKind: "robots", alt: { source: "list_text", ok: true } });
    rows = (await u1.from("collection_hard_sources").select("scope,key,needs_manual,fail_count,alt_success,alt_source").eq("household_id", hid)).data!;
    const st = rows.find((r) => r.scope === "store")!;
    expect(st).toMatchObject({ needs_manual: false, alt_success: 1, alt_source: "list_text", fail_count: 2 });
    // 別の店舗の失敗は別の行（サービス全体の失敗を理由に店舗全体を一律に取得不可としない）
    await recordHardSource(u1, hid, NOW, { url: "https://shoplottery.e-starbox.com/lottery/2", chainId: chain.id, storeId: s2.id, storeName: "テスト店B", failKind: "robots" });
    const stores = (await u1.from("collection_hard_sources").select("scope,key,needs_manual").eq("household_id", hid).eq("scope", "store")).data!;
    expect(stores).toHaveLength(2);
    expect(stores.filter((r) => r.needs_manual)).toHaveLength(1);
  });

  // ------------------------------------------------------------ 登録経路
  it("登録経路: 既存の抽選は manual/auto に移行済みで、確認履歴は確認者と日時を持つ", async () => {
    const chain = (await u1.from("chains").select("id").eq("name", "テスト系列5T").single()).data!;
    const store = (await u1.from("stores").select("id").eq("name", "テスト店A").single()).data!;
    const l = (await u1.from("lotteries").insert({ household_id: hid, chain_id: chain.id, store_id: store.id, source_kind: "auto", registration_path: "auto" } as never).select("id,registration_path,confirmed_at").single()).data!;
    expect(l.registration_path).toBe("auto");
    expect(l.confirmed_at).toBeNull();
    const at = new Date().toISOString();
    expect((await u1.from("lotteries").update({ registration_path: "auto_confirmed", confirmed_at: at, confirmed_by_profile_id: profile }).eq("id", l.id)).error).toBeNull();
    const after = (await u1.from("lotteries").select("registration_path,confirmed_by_profile_id").eq("id", l.id).single()).data!;
    expect(after).toMatchObject({ registration_path: "auto_confirmed", confirmed_by_profile_id: profile });
    // 不正な値は拒否される
    expect((await u1.from("lotteries").update({ registration_path: "robot" } as never).eq("id", l.id)).error).not.toBeNull();
  });
});
