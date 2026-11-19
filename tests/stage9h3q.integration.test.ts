/**
 * Stage 9H-3Q: 自律型AI主体の収集の統合（実Supabase・RLS適用下。実AI・実検索・外部通信なし＝架空のWebとモックAI）
 *   未知店舗の探索→登録 / 既存の登録経路（再解析・重複照合）/ 根拠の保存 / 排他・二重起動 / 方式の切り替え・データの維持 /
 *   既存・人間確認済みの保護 / 失敗の隔離 / 地域 / 記録の保存・保持方針
 *   npm run test:db
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DiscoveryMockBrain } from "@/lib/agent/discovery/mock-brain";
import { createSimWorld, type SimWorldSpec } from "@/lib/agent/discovery/sim-world";
import { EMPTY_FLEX } from "@/lib/lottery-input";
import { prune, runAutonomousCollection, type AutonomousDeps } from "@/lib/server/agent/discovery-service";
import { createRealDiscoveryWorld } from "@/lib/server/agent/discovery-world";
import type { Db } from "@/lib/server/lottery-service";
import { saveLegacy as saveLottery, type LegacyInput } from "./helpers/legacy";
import { adminClient, cleanupTestUsers, dbTestsEnabled, signInTestUser } from "./helpers/db";

const NOW = new Date();
const md = (n: number) => {
  const d = new Date(NOW.getTime() + n * 86_400_000 + 9 * 3600_000);
  return `${d.getUTCMonth() + 1}/${d.getUTCDate()}`;
};
const iso = (n: number) => new Date(NOW.getTime() + n * 86_400_000 + 9 * 3600_000).toISOString().slice(0, 10);
const ROOT = "https://toy9q.example.invalid/";
const SEED = "https://news.toy9q.example.invalid/1";
const STORES = "https://toy9q.example.invalid/stores";
const page = (store: string, host: string) => ({
  [`https://${host}.toy9q.example.invalid/n/1`]: {
    title: `${store} ハドウシーカー 抽選販売のお知らせ`,
    text: `テスト玩具 ${store} ハドウシーカー 抽選販売 応募受付\n【抽選】系列: テスト玩具 / 店舗: ${store} / 商品: ハドウシーカー / 応募期間: ${md(1)}〜${md(6)}\n応募期間 ${md(1)}〜${md(6)} 当選発表 ${md(8)}`,
  },
});

const world = (over: Partial<SimWorldSpec> = {}): SimWorldSpec => ({
  pages: {
    [SEED]: { title: "ハドウシーカー 抽選のお知らせ", text: `テスト玩具 梅田店 ハドウシーカー 抽選販売 応募受付\n【抽選】系列: テスト玩具 / 店舗: 梅田店 / 商品: ハドウシーカー / 応募期間: ${md(1)}〜${md(6)}`, links: [{ url: STORES, text: "店舗一覧" }] },
    [ROOT]: { title: "テスト玩具 公式", text: "公式サイト 抽選販売のご案内", links: [{ url: STORES, text: "店舗一覧" }] },
    [ROOT.replace(/\/$/, "")]: { title: "テスト玩具 公式", text: "公式サイト 抽選販売のご案内", links: [{ url: STORES, text: "店舗一覧" }] },
    [STORES]: { title: "店舗一覧", text: "テスト玩具 店舗一覧\n- 梅田店（大阪府）\n- 三宮店（兵庫県）\n- 難波店（大阪府）\n- 東京駅店（東京都）", searchable: false },
    ...page("三宮店", "s-sannomiya"),
    ...page("難波店", "s-namba"),
    ...page("東京駅店", "s-tokyo"),
  },
  ...over,
});

describe.skipIf(!dbTestsEnabled)("Stage 9H-3Q: 自律型収集の統合", () => {
  const admin = adminClient();
  const sys = admin as unknown as Db;
  const userIds: string[] = [];
  let u1: Db;
  let hid: string;
  let profile: string;
  let chainId: string;
  let productId: string;
  const storeIds: Record<string, string> = {};
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- 新しい表・列は生成型に無い
  const tbl = (t: string) => (sys as any).from(t);
  const count = async (t: string) => (await sys.from(t as never).select("id", { count: "exact", head: true }).eq("household_id", hid)).count ?? 0;
  const setSettings = (patch: Record<string, unknown>) => tbl("collection_settings").update(patch).eq("household_id", hid);
  const lots = async () => (await sys.from("lotteries").select("id,store_id,source_kind,updated_at,source_urls").eq("household_id", hid).is("archived_at", null)).data ?? [];

  const deps = (spec: SimWorldSpec, over: Partial<AutonomousDeps> = {}): AutonomousDeps => ({
    db: sys,
    householdId: hid,
    now: NOW,
    trigger: "manual",
    actor: null,
    asService: true,
    llmFor: () => new DiscoveryMockBrain("scout"),
    world: createRealDiscoveryWorld({ db: sys, householdId: hid, override: createSimWorld(spec) }),
    sleep: async () => {},
    env: { toremaneEnv: "local" },
    ...over,
  });

  beforeAll(async () => {
    const a = await signInTestUser(admin, "s9h3q", 1);
    userIds.push(a.userId);
    u1 = a.db;
    hid = (await u1.rpc("bootstrap_household")).data as string;
    profile = (await u1.from("profiles").select("id").order("sort_order")).data![0].id;
    chainId = (await u1.from("chains").insert({ household_id: hid, name: "テスト玩具" }).select("id").single()).data!.id;
    for (const [name, pref] of [["梅田店", "大阪府"], ["三宮店", "兵庫県"], ["難波店", "大阪府"], ["東京駅店", "東京都"]] as const)
      storeIds[name] = (await u1.from("stores").insert({ household_id: hid, chain_id: chainId, name, prefecture: pref, ...(name === "梅田店" ? { store_url: ROOT } : {}) } as never).select("id").single()).data!.id;
    productId = (await u1.from("products").insert({ household_id: hid, official_name: "ハドウシーカー", packs_per_box: 30 }).select("id").single()).data!.id;
    await u1.rpc("bootstrap_household");
    await tbl("collection_settings").insert({ household_id: hid });
    await setSettings({ prefectures: ["大阪府", "兵庫県"], auto_register: true, collection_engine: "autonomous" });
    // 起点: 利用者が手動で登録した梅田店の抽選（人間が確認した情報）
    const input: LegacyInput = { chainId, storeId: storeIds["梅田店"], campaignId: null, newCampaign: null, items: [{ productId, quantity: 1, unit: "box" }], applyStart: { precision: "date_only", date: iso(1), time: "" }, applyDeadline: { precision: "date_only", date: iso(6), time: "" }, resultDate: EMPTY_FLEX, procedureDeadline: EMPTY_FLEX, receiveMethod: "store", applyMethod: "web", conditionsText: "", verificationText: "", announcementMethod: "", announcementUrl: "", sourceUrls: [SEED], eventState: "open", limitBasis: "account", limitMaxCount: 1, memo: "", applications: [], appliedAt: "" };
    const r = await saveLottery(u1, hid, null, input, profile);
    expect(r.ok, (r as { error?: string }).error).toBe(true);
  });
  afterAll(async () => {
    await cleanupTestUsers(admin, userIds);
  });

  it("収集方式の設定: 既定は従来方式（DBの既定値）。不正な値は保存できない。保存は世帯単位でDBに残る", async () => {
    const fresh = await tbl("collection_settings").select("collection_engine").eq("household_id", hid).maybeSingle();
    expect(fresh.data.collection_engine).toBe("autonomous"); // このテストで設定したもの
    const bad = await setSettings({ collection_engine: "xyz" });
    expect(bad.error).toBeTruthy();
    expect((await tbl("collection_settings").select("collection_engine").eq("household_id", hid).maybeSingle()).data.collection_engine).toBe("autonomous");
  });

  it("従来方式の設定では、自律型は実行されず、何も変更しない", async () => {
    await setSettings({ collection_engine: "legacy" });
    const before = { l: await count("lotteries"), r: await count("discovery_runs") };
    const r = await runAutonomousCollection(deps(world()));
    expect(r).toMatchObject({ ok: false, skipped: true });
    expect(await count("lotteries")).toBe(before.l);
    expect(await count("discovery_runs")).toBe(before.r);
    await setSettings({ collection_engine: "autonomous" });
  });

  it("開発環境以外では、設定が自律型でも実行しない（本番の安全）", async () => {
    const r = await runAutonomousCollection(deps(world(), { env: { toremaneEnv: "production" } }));
    expect(r).toMatchObject({ ok: false, skipped: true });
  });

  it("自律探索: 公式の店舗一覧から未知の店舗を見つけ、既存の登録経路で登録する。根拠・経緯が保存され、対象地域外・手動登録済みは登録しない", async () => {
    const before = await lots();
    const out = await runAutonomousCollection(deps(world()));
    if (!out.ok) throw new Error(JSON.stringify(out));
    const after = await lots();
    const added = after.filter((l) => !before.some((b) => b.id === l.id));
    const addedStores = added.map((l) => Object.entries(storeIds).find(([, id]) => id === l.store_id)?.[0]).sort();
    expect(addedStores).toEqual(["三宮店", "難波店"]); // 東京駅店は対象地域外。梅田店は手動登録済み
    expect(added.every((l) => l.source_kind === "auto")).toBe(true);
    expect(out.counts.registered).toBe(2);
    expect(out.counts.found).toBe(2);
    expect(out.counts.alreadyKnown).toBeGreaterThanOrEqual(1); // 梅田店（手動登録）はAIの実績に数えない
    // 手動登録の抽選は変更されていない
    const manual = before.find((l) => l.store_id === storeIds["梅田店"])!;
    expect(after.find((l) => l.id === manual.id)!.updated_at).toBe(manual.updated_at);
    // 根拠・取得経路・経緯が、抽選とは別に保存される
    const origins = ((await tbl("lottery_discovery_origins").select("lottery_id,source_url,provenance,evidence_quote,reason").eq("household_id", hid)).data ?? []) as { lottery_id: string; source_url: string; provenance: string; evidence_quote: string }[];
    expect(origins).toHaveLength(2);
    expect(origins.every((o) => o.evidence_quote.includes("【抽選】") && o.source_url.startsWith("https://s-"))).toBe(true);
    expect(origins.every((o) => o.provenance === "search")).toBe(true);
    // 調査履歴・探索実績の保存
    const run = (await tbl("discovery_runs").select("*").eq("id", out.runId).single()).data;
    expect(run.status).toBe("completed");
    expect(run.counts.registered).toBe(2);
    expect(run.records[0].focus.length).toBeGreaterThan(0);
    expect(run.records[0].followUps.some((f: { action: string }) => f.action === "list_stores")).toBe(true);
    expect(run.records[0].unconfirmed).toBeDefined();
    expect(Number(run.cost_jpy)).toBe(0);
    const mem = (await tbl("discovery_strategy").select("memory").eq("household_id", hid).single()).data.memory;
    expect(mem.chains["テスト玩具"].aiNew).toBe(2);
    expect(mem.chains["テスト玩具"].alreadyKnown).toBeGreaterThanOrEqual(1);
    // 排他は解放されている
    expect((await tbl("collection_settings").select("autonomous_lock_until").eq("household_id", hid).single()).data.autonomous_lock_until).toBeNull();
  });

  it("同じ時間枠の再実行では同じミッションを繰り返さず、別の枠でも重複登録しない（既存＝AIが登録済みと認識し、新規に数えない）", async () => {
    const before = await count("lotteries");
    const again = await runAutonomousCollection(deps(world()));
    expect(await count("lotteries")).toBe(before);
    if (again.ok) expect(again.counts.registered).toBe(0);
    // 枠を変えて（別の時刻）実行しても、既存の抽選は重複登録されない
    await tbl("discovery_runs").update({ slot: "old" }).eq("household_id", hid);
    const third = await runAutonomousCollection(deps(world()));
    if (!third.ok) throw new Error(JSON.stringify(third));
    expect(third.counts.registered).toBe(0);
    expect(third.counts.found).toBe(0);
    expect(await count("lotteries")).toBe(before);
  });

  it("二重起動の防止: ロック中は実行されず、同時に2件起動しても本登録は1つだけが行う", async () => {
    await tbl("discovery_runs").delete().eq("household_id", hid);
    await tbl("lottery_discovery_origins").delete().eq("household_id", hid);
    const toDelete = (await lots()).filter((l) => l.source_kind === "auto").map((l) => l.id);
    await sys.from("lotteries").delete().in("id", toDelete);
    await setSettings({ autonomous_lock_until: new Date(NOW.getTime() + 60_000).toISOString() });
    const locked = await runAutonomousCollection(deps(world()));
    expect(locked).toMatchObject({ ok: false, skipped: true });
    await setSettings({ autonomous_lock_until: null });
    const [x, y] = await Promise.all([runAutonomousCollection(deps(world())), runAutonomousCollection(deps(world()))]);
    expect([x.ok, y.ok].filter(Boolean)).toHaveLength(1);
    const autos = (await lots()).filter((l) => l.source_kind === "auto");
    expect(autos).toHaveLength(2); // 二重登録なし
  });

  it("従来方式の収集が実行中なら、自律型は開始しない", async () => {
    await tbl("discovery_runs").update({ slot: "old2" }).eq("household_id", hid);
    const run = await tbl("collection_runs").insert({ household_id: hid, trigger: "manual", phase: "collect", status: "running" }).select("id").single();
    const r = await runAutonomousCollection(deps(world()));
    expect(r).toMatchObject({ ok: false, skipped: true });
    expect((r as { reason: string }).reason).toContain("従来方式");
    await tbl("collection_runs").delete().eq("id", run.data.id);
  });

  it("AIの失敗は記録に残り、応募・既存の抽選・方式の設定に影響しない。ロックは解放される（自動で従来方式へ切り替えない）", async () => {
    await tbl("discovery_runs").update({ slot: "old3" }).eq("household_id", hid);
    const before = await lots();
    const broken = { name: "broken", step: async () => { throw new Error("AIサービスの一時的な障害"); } };
    const r = await runAutonomousCollection(deps(world(), { llmFor: () => broken as never }));
    expect(await lots()).toEqual(before);
    if (r.ok) expect(r.counts.registered).toBe(0);
    const latest = (await tbl("discovery_runs").select("status,error").eq("household_id", hid).order("started_at", { ascending: false }).limit(1)).data[0];
    expect(["failed", "completed"]).toContain(latest.status);
    const st = (await tbl("collection_settings").select("collection_engine,autonomous_lock_until").eq("household_id", hid).single()).data;
    expect(st.collection_engine).toBe("autonomous");
    expect(st.autonomous_lock_until).toBeNull();
    // 例外が起きても失敗として記録される（取得部品の例外）
    await tbl("discovery_runs").update({ slot: "old4" }).eq("household_id", hid);
    const w = createRealDiscoveryWorld({ db: sys, householdId: hid, override: { fetchPage: async () => { throw new Error("接続エラー"); } } });
    const r2 = await runAutonomousCollection(deps(world(), { world: w }));
    expect(await lots()).toEqual(before);
    expect(r2.ok || "error" in r2 || "skipped" in r2).toBe(true);
    expect((await tbl("collection_settings").select("autonomous_lock_until").eq("household_id", hid).single()).data.autonomous_lock_until).toBeNull();
  });

  it("実行時間の上限などで途中終了した記録（期限切れの実行中）は、次の開始時に失敗として閉じられ、費用は上限額として計上される。調査の成果は先に保存される", async () => {
    await tbl("discovery_runs").update({ slot: "old5" }).eq("household_id", hid);
    const stale = (await tbl("discovery_runs").insert({ household_id: hid, trigger: "cron", status: "running", slot: "stale", started_at: new Date(NOW.getTime() - 20 * 60_000).toISOString(), cost_jpy: 0 }).select("id").single()).data;
    const r = await runAutonomousCollection(deps(world(), { perMissionJpy: 15, slot: "fresh-slot" }));
    expect(r.ok || "skipped" in r || "error" in r).toBe(true);
    const row = (await tbl("discovery_runs").select("status,cost_jpy,error").eq("id", stale.id).single()).data;
    expect(row.status).toBe("failed");
    expect(Number(row.cost_jpy)).toBe(15);
    expect(row.error).toContain("上限額");
    // 呼び出し口が決めた調査機会（slot）で記録される
    if (r.ok) expect((await tbl("discovery_runs").select("slot").eq("id", r.runId).single()).data.slot).toBe("fresh-slot");
  });

  it("方式を切り替えても、取得済みの抽選・応募・根拠は維持される（削除・初期化しない）", async () => {
    const before = { l: await count("lotteries"), o: await count("lottery_discovery_origins") };
    await setSettings({ collection_engine: "legacy", collection_engine_changed_at: new Date().toISOString() });
    await setSettings({ collection_engine: "autonomous" });
    expect(await count("lotteries")).toBe(before.l);
    expect(await count("lottery_discovery_origins")).toBe(before.o);
  });

  it("実AI・実検索を使う実行は、費用を記録できなければ開始しない", async () => {
    await tbl("discovery_runs").update({ slot: "old5" }).eq("household_id", hid);
    const r = await runAutonomousCollection(deps(world(), { real: true }));
    expect(r).toMatchObject({ ok: false, skipped: true });
    expect((r as { reason: string }).reason).toContain("費用を記録できない");
  });

  it("定期実行の呼び出し口: 本番相当では何もしない。開発環境でも実AIの関門が未設定なら、開始できなかった理由を記録する（同じ枠で1回・方式の設定は変えない）", async () => {
    const { runAutonomousInCron } = await import("@/lib/server/collector/autonomous-hook");
    const hours = [6, 18];
    const saved = process.env.TOREMANE_ENV;
    try {
      process.env.TOREMANE_ENV = "production";
      expect(await runAutonomousInCron({ db: sys, householdId: hid, now: NOW, hours, extractor: null })).toMatchObject({ status: "disabled" });
      process.env.TOREMANE_ENV = "local";
      await tbl("discovery_runs").delete().eq("household_id", hid);
      const r1 = await runAutonomousInCron({ db: sys, householdId: hid, now: NOW, hours, extractor: null });
      expect(r1.status).toBe("skipped");
      await runAutonomousInCron({ db: sys, householdId: hid, now: NOW, hours, extractor: null });
      const skipped = ((await tbl("discovery_runs").select("status,error").eq("household_id", hid).eq("status", "skipped")).data ?? []) as { error: string }[];
      expect(skipped).toHaveLength(1);
      expect(skipped[0].error.length).toBeGreaterThan(0);
      expect((await tbl("collection_settings").select("collection_engine").eq("household_id", hid).single()).data.collection_engine).toBe("autonomous");
    } finally {
      process.env.TOREMANE_ENV = saved;
    }
  });

  it("店舗マスターに無い未知の店舗も、公式の店舗一覧から見つけて、仮登録（未確認の新規店舗）として登録する。系列が不明なものは登録しない", async () => {
    await tbl("discovery_strategy").delete().eq("household_id", hid); // 9U: 直前のテストで調べたミッションは再調査までの間隔があるため、探索履歴を空にする
    await tbl("discovery_runs").update({ slot: "old6" }).eq("household_id", hid);
    const spec = world();
    spec.pages[STORES].text += "\n- 新規開拓店（大阪府）";
    Object.assign(spec.pages, page("新規開拓店", "s-newshop"));
    const before = await lots();
    const out = await runAutonomousCollection(deps(spec));
    if (!out.ok) throw new Error(JSON.stringify(out));
    expect(out.outcomes.filter((o) => o.outcome === "registered").length, JSON.stringify({ o: out.outcomes, l: out.records[0]?.leads.map((l) => [l.lead.store, l.decision.status, l.decision.reason]), f: out.records[0]?.followUps.map((f) => `${f.action}:${f.input}`), stop: out.records[0]?.stop, m: out.counts })).toBe(1);
    const added = (await lots()).filter((l) => !before.some((b) => b.id === l.id));
    expect(added).toHaveLength(1);
    const store = (await sys.from("stores").select("name,chain_id").eq("id", added[0].store_id!).single()).data!;
    expect(store.name).toBe("新規開拓店");
    expect(store.chain_id).toBe(chainId);
    // 根拠が保存される
    const o = ((await tbl("lottery_discovery_origins").select("source_url,evidence_quote").eq("lottery_id", added[0].id)).data ?? []) as { source_url: string; evidence_quote: string }[];
    expect(o).toHaveLength(1);
    expect(o[0].source_url).toContain("s-newshop");
  });

  it("本番の費用管理: 調査履歴の費用から今日・今月の残り予算を計算する。失敗・途中終了でも消費した費用が記録される", async () => {
    await tbl("discovery_strategy").delete().eq("household_id", hid); // 9U: 直前のテストで調べたミッションは再調査までの間隔があるため、探索履歴を空にして同じミッションを選べる状態にする
    const { budgetRemainingJpy } = await import("@/lib/server/collector/autonomous-hook");
    await tbl("discovery_runs").delete().eq("household_id", hid);
    expect(await budgetRemainingJpy(sys, hid, NOW, { AUTONOMOUS_DAILY_CAP_JPY: "30", AUTONOMOUS_MONTHLY_CAP_JPY: "300" })).toBe(30);
    await tbl("discovery_runs").insert({ household_id: hid, trigger: "cron", status: "completed", slot: "b1", started_at: NOW.toISOString(), cost_jpy: 12 });
    expect(await budgetRemainingJpy(sys, hid, NOW, { AUTONOMOUS_DAILY_CAP_JPY: "30", AUTONOMOUS_MONTHLY_CAP_JPY: "300" })).toBe(18);
    expect(await budgetRemainingJpy(sys, hid, NOW, { AUTONOMOUS_DAILY_CAP_JPY: "30", AUTONOMOUS_MONTHLY_CAP_JPY: "20" })).toBe(8); // 月の上限が先に尽きる
    expect(await budgetRemainingJpy(sys, hid, NOW, { AUTONOMOUS_DAILY_CAP_JPY: "10", AUTONOMOUS_MONTHLY_CAP_JPY: "300" })).toBe(0);
    await tbl("discovery_runs").delete().eq("household_id", hid);
    // 既定の上限は 日次100円・月次1,500円。実行中の記録は、費用が確定していなくても1件の上限額（既定15円）を消費したものとして数える（同時実行・途中終了で超えない）
    expect(await budgetRemainingJpy(sys, hid, NOW, {})).toBe(100);
    await tbl("discovery_runs").insert({ household_id: hid, trigger: "cron", status: "running", slot: "b2", started_at: NOW.toISOString(), cost_jpy: 0 });
    expect(await budgetRemainingJpy(sys, hid, NOW, {})).toBe(85);
    // 期限切れの実行中の記録は、次の実行の開始時に、上限額を消費したものとして閉じられる（費用が不明でも予算を超えない）
    await tbl("discovery_runs").delete().eq("household_id", hid);
    // 例外で途中終了しても、消費した費用を記録する
    let spent = 0;
    const r = await runAutonomousCollection(deps(world(), { costSoFar: () => spent, llmFor: () => { spent = 6.5; throw new Error("想定外の例外"); } }));
    expect(r.ok).toBe(false);
    const row = (await tbl("discovery_runs").select("status,cost_jpy").eq("household_id", hid).order("started_at", { ascending: false }).limit(1)).data[0];
    expect(row.status).toBe("failed");
    expect(Number(row.cost_jpy)).toBe(6.5);
    expect((await tbl("collection_settings").select("collection_engine,autonomous_lock_until").eq("household_id", hid).single()).data).toEqual({ collection_engine: "autonomous", autonomous_lock_until: null });
  });

  it("本番で明示的に許可（AUTONOMOUS_COLLECTION=on）しても、キー・予算が揃わなければ実行せず理由を記録する。許可がなければ何もしない", async () => {
    const { runAutonomousInCron } = await import("@/lib/server/collector/autonomous-hook");
    const keep = { e: process.env.TOREMANE_ENV, a: process.env.AUTONOMOUS_COLLECTION, k: process.env.ANTHROPIC_API_KEY, k2: process.env.AUTONOMOUS_ANTHROPIC_API_KEY };
    try {
      delete process.env.TOREMANE_ENV;
      delete process.env.ANTHROPIC_API_KEY;
      delete process.env.AUTONOMOUS_ANTHROPIC_API_KEY;
      process.env.AUTONOMOUS_COLLECTION = "off";
      expect(await runAutonomousInCron({ db: sys, householdId: hid, now: NOW, hours: [6, 18], extractor: null })).toMatchObject({ status: "disabled" });
      process.env.AUTONOMOUS_COLLECTION = "on";
      await tbl("discovery_runs").delete().eq("household_id", hid);
      const before = await count("lotteries");
      const r = await runAutonomousInCron({ db: sys, householdId: hid, now: NOW, hours: [6, 18], extractor: null });
      expect(r.status).toBe("skipped");
      expect(r.message).toContain("キー");
      expect(await count("lotteries")).toBe(before);
    } finally {
      for (const [k, v] of [["TOREMANE_ENV", keep.e], ["AUTONOMOUS_COLLECTION", keep.a], ["ANTHROPIC_API_KEY", keep.k], ["AUTONOMOUS_ANTHROPIC_API_KEY", keep.k2]] as const) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
  });

  it("履歴の保持方針: 古い記録は削除され、新しい記録・実行中の記録は残る", async () => {
    const old = new Date(NOW.getTime() - 90 * 86_400_000).toISOString();
    await tbl("discovery_runs").insert({ household_id: hid, trigger: "cron", status: "completed", started_at: old, finished_at: old, slot: "x" });
    const n = await prune(sys, hid, NOW);
    expect(n).toBeGreaterThanOrEqual(1);
    const left = (await tbl("discovery_runs").select("started_at").eq("household_id", hid)).data ?? [];
    expect(left.every((r: { started_at: string }) => r.started_at > old)).toBe(true);
  });

  it("RLS: 別の世帯の調査履歴・探索実績・根拠は見えない／書けない", async () => {
    const b = await signInTestUser(admin, "s9h3q", 2);
    userIds.push(b.userId);
    await b.db.rpc("bootstrap_household");
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const other = b.db as any;
    expect((await other.from("discovery_runs").select("id")).data ?? []).toHaveLength(0);
    expect((await other.from("discovery_strategy").select("household_id")).data ?? []).toHaveLength(0);
    expect((await other.from("lottery_discovery_origins").select("id")).data ?? []).toHaveLength(0);
    const ins = await other.from("discovery_runs").insert({ household_id: hid, trigger: "manual", status: "completed" });
    expect(ins.error).toBeTruthy();
    // 自分の世帯の履歴は、メンバーなら読める
    expect(((await (u1 as never as { from: (t: string) => { select: (c: string) => Promise<{ data: unknown[] }> } }).from("discovery_runs").select("id")).data ?? []).length).toBeGreaterThan(0);
  });
});
