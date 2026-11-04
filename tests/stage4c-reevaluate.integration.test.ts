/**
 * Stage 4C 追加: 確認待ち候補の再評価（実Supabase・RLS適用下。AI・外部サイトはモック＝有料APIの実呼び出しなし。架空データのみ）:
 * 判定のみ（DBを変更しない）、無料の再照合での登録、受付終了・重複の除外/統合（候補は物理削除しない）、AI再解析の件数上限、
 * 変更前の記録と復元、既存の抽選・応募・当落を変更しないこと。
 *   npm run test:db
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { getExtractor } from "@/lib/ai/provider";
import { EMPTY_FLEX } from "@/lib/lottery-input";
import { restoreReevaluation, runReevaluation, type ReevalReport } from "@/lib/server/collector/reevaluate";
import { loadAppData, type Db } from "@/lib/server/lottery-service";
import type { CollectDeps } from "@/lib/server/collector/run";
import type { SafeFetchResult } from "@/lib/server/safe-fetch";
import { saveLegacy as saveLottery, type LegacyInput } from "./helpers/legacy";
import { adminClient, cleanupTestUsers, dbTestsEnabled, signInTestUser } from "./helpers/db";

const NOW = new Date();
const ymd = (offsetDays: number) => new Date(NOW.getTime() + offsetDays * 86_400_000 + 9 * 3600_000).toISOString().slice(0, 10);
const PAGE = `<html><body><p>ポケモンカード 拡張パック 抽選販売のお知らせ。サンプル電機 三宮店にて抽選販売を実施します。応募期間をご確認ください。</p></body></html>`;
const okPage = (u: string): SafeFetchResult => ({ ok: true, finalUrl: u, status: 200, contentType: "text/html", body: PAGE, truncated: false });

describe.skipIf(!dbTestsEnabled)("Stage 4C 追加: 確認待ち候補の再評価", () => {
  const admin = adminClient();
  const userIds: string[] = [];
  let u1: Db;
  let hid: string;
  let profile: string;
  let chainId: string;
  let storeId: string;
  let productId: string;
  let manualLottery: string;
  let aiCalls = 0;

  const deps = (over: Partial<CollectDeps> = {}): CollectDeps => ({
    db: u1, householdId: hid, trigger: "manual", now: NOW, actor: profile, canRegister: true,
    extractor: { engine: "mock", extract: async (r) => { aiCalls++; return getExtractor({ AI_PROVIDER: "mock" })!.extract(r); } },
    xClient: null,
    fetchPage: async (u) => okPage(u),
    fetchOembed: async () => ({ ok: true, text: "ポケモンカード 抽選販売 サンプル電機 三宮店", author: "x", notice: ["添付画像とリンク先は解析できていません（本文のみ）"], postedOn: ymd(0) }),
    ...over,
  });

  const storedInput = (over: Record<string, unknown> = {}) => ({
    chain: { id: null, name: "サンプル電機" },
    store: { id: null, name: "三宮店", prefecture: "兵庫県" },
    campaignId: null, newCampaign: null,
    items: [{ product: { id: null, name: "テスト拡張パック「ひかりの森」" }, quantity: 1, unit: "box" }],
    multiMode: "single",
    applyStart: EMPTY_FLEX, applyDeadline: { precision: "date_only", date: ymd(20), time: "" }, resultDate: EMPTY_FLEX,
    procedureStart: EMPTY_FLEX, procedureDeadline: EMPTY_FLEX, receiveMethod: "store", applyMethod: "web", requirementTags: [],
    conditionsText: "", verificationText: "", announcementMethod: "", announcementUrl: "", sourceUrls: [], eventState: "open", limitBasis: "account", limitMaxCount: 1, memo: "", applications: [],
    ...over,
  });
  const draft = (input: Record<string, unknown>, extra: Record<string, unknown> = {}) => ({
    input, flags: {}, summary: { chain: "none", store: "none", items: [{ name: "x", kind: "none", matchedName: null }] }, warnings: [], modePending: false, verdict: "review", ready: false, notices: [], ...extra,
  });
  const url = (n: string) => `https://r.example.invalid/${n}`;
  const addCand = async (n: string, d: unknown, extra: Record<string, unknown> = {}) => {
    const { error } = await u1.from("collection_candidates").insert({ household_id: hid, dedupe_key: url(n), source_url: url(n), title: n, status: "pending", job_state: "review", kind: "new", reasons: ["要確認"], draft: d as never, ...extra } as never);
    expect(error).toBeNull();
  };
  const cand = async (n: string) => (await u1.from("collection_candidates").select("id,status,job_state,reasons,draft,lottery_id").eq("dedupe_key", url(n)).single()).data!;
  const clear = async () => {
    await u1.from("collection_candidates").delete().like("dedupe_key", "https://r.example.invalid/%");
  };

  beforeAll(async () => {
    const a = await signInTestUser(admin, "s4cr", 1);
    userIds.push(a.userId);
    u1 = a.db;
    hid = (await u1.rpc("bootstrap_household")).data as string;
    profile = (await u1.from("profiles").select("id").order("sort_order")).data![0].id;
    chainId = (await u1.from("chains").insert({ household_id: hid, name: "サンプル電機" }).select("id").single()).data!.id;
    storeId = (await u1.from("stores").insert({ household_id: hid, chain_id: chainId, name: "三宮店", prefecture: "兵庫県" }).select("id").single()).data!.id;
    productId = (await u1.from("products").insert({ household_id: hid, official_name: "テスト拡張パック「ひかりの森」", packs_per_box: 30 }).select("id").single()).data!.id;
    await u1.from("collection_settings").insert({ household_id: hid, auto_register: true, worker_enabled: false });
    const base: LegacyInput = {
      chainId, storeId, campaignId: null, newCampaign: null, items: [{ productId, quantity: 1, unit: "box" }], multiMode: "single",
      applyStart: EMPTY_FLEX, applyDeadline: { precision: "date_only", date: ymd(40), time: "" }, resultDate: EMPTY_FLEX, procedureStart: EMPTY_FLEX, procedureDeadline: EMPTY_FLEX,
      receiveMethod: "store", applyMethod: "web", conditionsText: "手動登録", verificationText: "", announcementMethod: "", announcementUrl: "", sourceUrls: [url("manual")],
      eventState: "open", limitBasis: "account", limitMaxCount: 1, memo: "手動のメモ", applications: [], appliedAt: "",
    };
    const l = await saveLottery(u1, hid, null, base, profile);
    if (!l.ok) throw new Error("setup");
    manualLottery = l.value.id;
  });
  afterAll(async () => {
    await clear();
    await cleanupTestUsers(admin, userIds);
  });

  const snapshot = async () => {
    const d = await loadAppData(u1, hid);
    return JSON.stringify({ lotteries: d.lotteries.map((l) => [l.id, l.memo, l.conditionsText, l.sourceUrls]).sort(), apps: d.applications.map((a) => [a.id, a.result]).sort(), purchases: d.purchases.length });
  };

  it("判定のみ（execute=false）はDBを一切変更しない。分類と件数だけ返す", async () => {
    await clear();
    await addCand("past", draft(storedInput({ applyDeadline: { precision: "date_only", date: ymd(-5), time: "" } })));
    await addCand("rematch", draft(storedInput()));
    const beforeRows = JSON.stringify((await u1.from("collection_candidates").select("id,status,job_state,reasons,draft").like("dedupe_key", "https://r.example.invalid/%").order("id")).data);
    const r = (await runReevaluation(deps(), { execute: false, aiMax: 0 })) as ReevalReport;
    expect(r.ok).toBe(true);
    expect(r.before.review).toBe(2);
    expect(r.byClass).toMatchObject({ E: 1, B: 1 });
    expect(JSON.stringify((await u1.from("collection_candidates").select("id,status,job_state,reasons,draft").like("dedupe_key", "https://r.example.invalid/%").order("id")).data)).toBe(beforeRows);
  });

  it("実行: 受付終了は除外（候補は残る）、新しい照合で特定できた候補はAIなしで自動登録。既存の抽選・応募・当落は変更されない", async () => {
    const snap0 = await snapshot();
    aiCalls = 0;
    const r = (await runReevaluation(deps(), { execute: true, aiMax: 0 })) as ReevalReport;
    expect(r.counts).toMatchObject({ excluded_past: 1, registered: 1 });
    expect(aiCalls).toBe(0);
    const past = await cand("past");
    expect(past).toMatchObject({ status: "excluded", job_state: "skipped" });
    expect(past.reasons[0]).toContain("受付終了");
    const reg = await cand("rematch");
    expect(reg.status).toBe("auto_registered");
    expect(reg.lottery_id).not.toBeNull();
    // 新規登録された抽選は自動収集の印つき・★管理対象にならず・応募記録もない
    const lot = (await u1.from("lotteries").select("source_kind,is_new").eq("id", reg.lottery_id!).single()).data!;
    expect(lot.source_kind).toBe("auto");
    expect(((await u1.from("lottery_management").select("is_managed").eq("lottery_id", reg.lottery_id!)).data ?? []).every((m) => m.is_managed === false)).toBe(true);
    expect(((await u1.from("applications").select("id").eq("lottery_id", reg.lottery_id!)).data ?? []).length).toBe(0);
    // 既存（手動登録）の抽選の内容は変わらない
    const snap1 = JSON.parse(await snapshot());
    const snap0j = JSON.parse(snap0);
    const manual0 = snap0j.lotteries.find((l: unknown[]) => l[0] === manualLottery);
    expect(snap1.lotteries.find((l: unknown[]) => l[0] === manualLottery)).toEqual(manual0);
    expect(snap1.apps).toEqual(snap0j.apps);
    // 候補は物理削除されていない
    expect(((await u1.from("collection_candidates").select("id").like("dedupe_key", "https://r.example.invalid/%")).data ?? []).length).toBe(2);
  });

  it("変更前の状態が記録され、復元できる（候補だけ。登録された抽選は削除せず通知する）", async () => {
    const past = await cand("past");
    const m = (past.draft as { reeval: { before: { status: string; job_state: string; reasons: string[] } } }).reeval;
    expect(m.before).toMatchObject({ status: "pending", job_state: "review", reasons: ["要確認"] });
    const out = await restoreReevaluation(u1, hid, [past.id]);
    expect(out.restored).toBe(1);
    const back = await cand("past");
    expect(back).toMatchObject({ status: "pending", job_state: "review", reasons: ["要確認"] });
    expect((back.draft as Record<string, unknown>).reeval).toBeUndefined();
  });

  it("既存の抽選と同じ内容の候補は重複として統合（既存の抽選に紐付けるだけ）", async () => {
    await clear();
    const sameDay = (await u1.from("lotteries").select("apply_deadline_date").eq("id", manualLottery).single()).data!.apply_deadline_date as string;
    await addCand("dup", draft(storedInput({ chain: { id: chainId, name: "サンプル電機" }, store: { id: storeId, name: "三宮店", prefecture: "" }, items: [{ product: { id: productId, name: "テスト拡張パック「ひかりの森」" }, quantity: 1, unit: "box" }], applyDeadline: { precision: "date_only", date: sameDay, time: "" }, sourceUrls: [url("dup-src")] }), { summary: { chain: "exact", store: "exact", items: [{ name: "x", kind: "exact", matchedName: "x" }] } }), { source_url: url("dup-src") });
    const before = await snapshot();
    const r = (await runReevaluation(deps(), { execute: true, aiMax: 0 })) as ReevalReport;
    expect(r.counts.duplicate).toBe(1);
    const c = await cand("dup");
    expect(c).toMatchObject({ status: "duplicate", job_state: "completed", lottery_id: manualLottery });
    expect(await snapshot()).toBe(before);
  });

  it("AI再解析は件数の上限内だけ。上限0ではAIを呼ばず、確認待ちのまま理由を記録する。上限1なら1件だけ解析する", async () => {
    await clear();
    const unknownDeadline = storedInput({ applyDeadline: EMPTY_FLEX });
    await addCand("web1", draft(unknownDeadline, { warnings: [] }));
    await addCand("web2", draft(unknownDeadline, { warnings: [] }));
    aiCalls = 0;
    const none = (await runReevaluation(deps(), { execute: true, aiMax: 0 })) as ReevalReport;
    expect(aiCalls).toBe(0);
    expect(none.after.review).toBe(2);
    expect((await cand("web1")).reasons.join(" ")).toContain("上限");
    aiCalls = 0;
    const one = (await runReevaluation(deps(), { execute: true, aiMax: 1 })) as ReevalReport;
    expect(one.ai).toMatchObject({ requested: 1, allowed: 1 });
    expect(aiCalls).toBe(1);
    // 解析された1件は確認待ち以外（または結果の記録つき）、もう1件は確認待ちのまま
    const states = [await cand("web1"), await cand("web2")];
    expect(states.filter((s) => (s.draft as { reeval?: unknown }).reeval).length).toBe(2);
    expect(states.filter((s) => s.job_state === "pending").length).toBe(0); // 解析待ちのまま残らない
  });

  it("AI未設定・上限超過のときはAIを呼ばず、候補を保持する", async () => {
    await clear();
    await addCand("noai", draft(storedInput({ applyDeadline: EMPTY_FLEX })));
    const r = (await runReevaluation(deps({ extractor: null }), { execute: true, aiMax: 5 })) as ReevalReport;
    expect(r.ai.allowed).toBe(0);
    const c = await cand("noai");
    expect(c).toMatchObject({ status: "pending", job_state: "review" });
    expect(c.reasons.join(" ")).toContain("AI");
  });
});
