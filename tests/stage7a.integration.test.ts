/**
 * Stage 7A の結合テスト（実Supabase・RLS適用下。AI・外部サイトは使わない＝有料APIの呼び出しなし。架空データのみ）:
 * 注意情報の保存、日別統計（注意付き登録・地域外除外・確認待ち理由）、確認待ち候補の再評価（注意付き登録・地域外の除外・確認待ちに残す・再実行で二重登録しない）、
 * 注意付き抽選の自動補完（手動編集の保護）、系列の店舗選択式の設定。
 *   npm run test:db   ※ マイグレーション 20261129000077 の適用後に実行する
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { EMPTY_FLEX } from "@/lib/lottery-input";
import { autoCompleteLottery } from "@/lib/server/collector/complete";
import { runReevaluation, type ReevalReport } from "@/lib/server/collector/reevaluate";
import { loadAppData, type Db } from "@/lib/server/lottery-service";
import type { CollectDeps } from "@/lib/server/collector/run";
import { saveLegacy, type LegacyInput } from "./helpers/legacy";
import { adminClient, cleanupTestUsers, dbTestsEnabled, signInTestUser } from "./helpers/db";

const NOW = new Date();
const ymd = (offsetDays: number) => new Date(NOW.getTime() + offsetDays * 86_400_000 + 9 * 3600_000).toISOString().slice(0, 10);
const jstDay = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Tokyo" }).format(NOW);

describe.skipIf(!dbTestsEnabled)("Stage 7A: 自動収集の改善", () => {
  const admin = adminClient();
  const userIds: string[] = [];
  let u1: Db;
  let hid: string;
  let profile: string;
  let chainId: string;
  let storeId: string;
  let productId: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- 新しい列・関数は生成型に含まれない場合がある
  const x = (db: unknown) => db as any;

  const deps = (): CollectDeps => ({ db: u1, householdId: hid, trigger: "manual", now: NOW, actor: profile, canRegister: true, extractor: null, xClient: null });
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
  const draft = (input: Record<string, unknown>) => ({ input, flags: {}, summary: { chain: "none", store: "none", items: [{ name: "x", kind: "none", matchedName: null }] }, warnings: [], modePending: false, verdict: "review", ready: false, notices: [] });
  const url = (n: string) => `https://s7a.example.invalid/${n}`;
  const addCand = async (n: string, d: unknown) => {
    const { error } = await u1.from("collection_candidates").insert({ household_id: hid, dedupe_key: url(n), source_url: url(n), title: n, status: "pending", job_state: "review", kind: "new", reasons: ["要確認"], draft: d as never } as never);
    expect(error).toBeNull();
  };
  const cand = async (n: string) => (await u1.from("collection_candidates").select("id,status,job_state,reasons,draft,lottery_id").eq("dedupe_key", url(n)).single()).data!;
  const lotteryCount = async () => (await loadAppData(u1, hid)).lotteries.length;

  beforeAll(async () => {
    const a = await signInTestUser(admin, "s7a", 1);
    userIds.push(a.userId);
    u1 = a.db;
    hid = (await u1.rpc("bootstrap_household")).data as string;
    profile = (await u1.from("profiles").select("id").order("sort_order")).data![0].id;
    chainId = (await u1.from("chains").insert({ household_id: hid, name: "サンプル電機" }).select("id").single()).data!.id;
    storeId = (await u1.from("stores").insert({ household_id: hid, chain_id: chainId, name: "三宮店", prefecture: "兵庫県" }).select("id").single()).data!.id;
    productId = (await u1.from("products").insert({ household_id: hid, official_name: "テスト拡張パック「ひかりの森」", packs_per_box: 30 }).select("id").single()).data!.id;
    await u1.from("collection_settings").insert({ household_id: hid, auto_register: true, worker_enabled: false, prefectures: ["兵庫県", "大阪府", "京都府"] } as never);
  });
  afterAll(async () => {
    await u1.from("collection_candidates").delete().like("dedupe_key", "https://s7a.example.invalid/%");
    await cleanupTestUsers(admin, userIds);
  });

  it("抽選の注意情報（cautions/confidence）を保存できる。配列以外・不正な信頼度は拒否される。通常の抽選は空配列", async () => {
    const base: LegacyInput = {
      chainId, storeId, campaignId: null, newCampaign: null, items: [{ productId, quantity: 1, unit: "box" }], multiMode: "single",
      applyStart: EMPTY_FLEX, applyDeadline: { precision: "date_only", date: ymd(-60), time: "" }, resultDate: EMPTY_FLEX, procedureStart: EMPTY_FLEX, procedureDeadline: EMPTY_FLEX,
      receiveMethod: "store", applyMethod: "web", conditionsText: "手動登録", verificationText: "", announcementMethod: "", announcementUrl: "", sourceUrls: [url("manual")],
      eventState: "open", limitBasis: "account", limitMaxCount: 1, memo: "", applications: [], appliedAt: "",
    };
    const l = await saveLegacy(u1, hid, null, base, profile);
    if (!l.ok) throw new Error(l.error);
    const row = (await u1.from("lotteries").select("cautions,confidence").eq("id", l.value.id).single()).data as unknown as { cautions: unknown[]; confidence: string | null };
    expect(row.cautions).toEqual([]);
    const caution = [{ code: "result_date_unknown", field: "resultDate", message: "当選発表日が確認できていません", at: NOW.toISOString() }];
    expect((await x(u1).from("lotteries").update({ cautions: caution, confidence: "partial" }).eq("id", l.value.id)).error).toBeNull();
    expect((await x(u1).from("lotteries").select("cautions").eq("id", l.value.id).single()).data.cautions).toEqual(caution);
    expect((await x(u1).from("lotteries").update({ cautions: { a: 1 } }).eq("id", l.value.id)).error).not.toBeNull();
    expect((await x(u1).from("lotteries").update({ confidence: "unknown_level" }).eq("id", l.value.id)).error).not.toBeNull();
  });

  it("日別統計: 注意付き登録・地域外除外・確認待ち理由を加算できる（理由は分類ごとに合算）", async () => {
    const day = jstDay;
    await u1.rpc("bump_collection_stats", { p_household: hid, p_day: day, p_delta: { registered_new: 2, registered_caution: 1, excluded: 1, excluded_region: 1, reasons: { chain_store: 1, product: 2 } } });
    await u1.rpc("bump_collection_stats", { p_household: hid, p_day: day, p_delta: { registered_caution: 2, reasons: { chain_store: 3, region: 1 } } });
    const r = (await x(u1).from("collection_daily_stats").select("registered_new,registered_caution,excluded,excluded_region,review_reasons").eq("household_id", hid).eq("day", day).single()).data;
    expect(r).toMatchObject({ registered_new: 2, registered_caution: 3, excluded: 1, excluded_region: 1 });
    expect(r.review_reasons).toEqual({ chain_store: 4, product: 2, region: 1 });
  });

  it("再評価: 情報不足は注意付きで登録、地域外は根拠つきで除外、判断できないものは確認待ちに残す。再実行しても二重登録しない", async () => {
    await addCand("caution", draft(storedInput()));
    await addCand("offarea", draft(storedInput({ store: { id: null, name: "豊橋店", prefecture: "愛知県" }, receiveMethod: "unknown" })));
    await addCand("nochain", draft(storedInput({ chain: { id: null, name: "" }, store: { id: null, name: "", prefecture: "" } })));
    const before = await lotteryCount();
    const r = (await runReevaluation(deps(), { execute: true, aiMax: 0 })) as ReevalReport;
    expect(r.ok).toBe(true);
    expect(r.counts).toMatchObject({ registered_caution: 1, excluded_offtarget: 1 });

    const reg = await cand("caution");
    expect(reg.status).toBe("auto_registered");
    expect(reg.lottery_id).not.toBeNull();
    const lot = (await x(u1).from("lotteries").select("source_kind,cautions,confidence,cautions_updated_at").eq("id", reg.lottery_id!).single()).data;
    expect(lot.source_kind).toBe("auto");
    expect(lot.confidence).toBe("partial");
    expect((lot.cautions as { code: string }[]).map((c) => c.code)).toContain("result_date_unknown");
    expect(lot.cautions_updated_at).not.toBeNull();
    // 応募・当落の記録は作らない
    expect(((await u1.from("applications").select("id").eq("lottery_id", reg.lottery_id!)).data ?? []).length).toBe(0);

    const off = await cand("offarea");
    expect(off).toMatchObject({ status: "excluded", job_state: "skipped" }); // 物理削除せず、除外一覧から確認・戻せる
    const ex = (off.draft as { exclusion?: { kind: string; prefecture: string; basis: string; note: string; source: string; at: string } }).exclusion!;
    expect(ex).toMatchObject({ kind: "region", prefecture: "愛知県", source: url("offarea") });
    expect(ex.note).toContain("愛知県");
    expect(ex.at).toBeTruthy();
    expect(off.reasons.join("")).toContain("判定根拠");

    const keep = await cand("nochain");
    expect(keep).toMatchObject({ status: "pending", job_state: "review" });

    expect(await lotteryCount()).toBe(before + 1);
    // 再実行: 登録済み・除外済みの候補は対象外。抽選は増えない
    const again = (await runReevaluation(deps(), { execute: true, aiMax: 0 })) as ReevalReport;
    expect(again.counts.registered_caution ?? 0).toBe(0);
    expect(again.counts.excluded_offtarget ?? 0).toBe(0);
    expect(await lotteryCount()).toBe(before + 1);
    // 統計にも反映される
    const st = (await x(u1).from("collection_daily_stats").select("registered_caution,excluded_region").eq("household_id", hid).eq("day", jstDay).single()).data;
    expect(st.registered_caution).toBeGreaterThanOrEqual(1);
    expect(st.excluded_region).toBeGreaterThanOrEqual(1);
  });

  it("自動補完: 新しい情報で不足を補い注意を解除する。値のある項目は上書きせず、手動編集した抽選は触らない", async () => {
    const reg = await cand("caution");
    const id = reg.lottery_id!;
    const inc = { resultDate: { precision: "date_only" as const, date: ymd(25), time: "" }, applyDeadline: { precision: "date_only" as const, date: ymd(20), time: "" }, procedureStart: EMPTY_FLEX, procedureDeadline: EMPTY_FLEX, receiveStart: EMPTY_FLEX, receiveDeadline: EMPTY_FLEX, receiveMethod: "store" as const, applyMethod: "web" as const };
    const r = await autoCompleteLottery(u1, id, inc, { official: false, now: NOW });
    expect(r).toMatchObject({ updated: true });
    expect(r.filled).toContain("当選発表日");
    const after = (await x(u1).from("lotteries").select("result_date,result_precision,cautions,apply_deadline_date").eq("id", id).single()).data;
    expect(after.result_date).toBe(ymd(25));
    expect((after.cautions as { code: string }[]).map((c) => c.code)).not.toContain("result_date_unknown");
    // 値のある発表日は上書きしない（相違は注意として追加）
    const r2 = await autoCompleteLottery(u1, id, { ...inc, resultDate: { precision: "date_only", date: ymd(27), time: "" } }, { official: false, now: NOW });
    expect(r2.updated).toBe(true);
    const a2 = (await x(u1).from("lotteries").select("result_date,cautions").eq("id", id).single()).data;
    expect(a2.result_date).toBe(ymd(25));
    expect((a2.cautions as { code: string }[]).map((c) => c.code)).toContain("conflict_resultDate");
    // 手動編集（自動処理の更新より後に更新された）の抽選は触らない
    // 自動処理の更新の印（cautions_updated_at）より十分後に更新された＝利用者が保存し直した抽選として扱う
    await x(admin).from("lotteries").update({ cautions_updated_at: new Date(Date.now() - 60 * 60_000).toISOString() }).eq("id", id);
    const r3 = await autoCompleteLottery(u1, id, { ...inc, receiveMethod: "shipping" }, { official: false, now: NOW });
    expect(r3).toMatchObject({ updated: false, skipped: "manual_edit" });
  });

  it("系列の「店舗選択式を基本とする」設定を保存できる（自世帯の系列のみ）", async () => {
    expect((await x(u1).from("chains").update({ store_select_default: true }).eq("id", chainId)).error).toBeNull();
    expect((await x(u1).from("chains").select("store_select_default").eq("id", chainId).single()).data.store_select_default).toBe(true);
    const d = await loadAppData(u1, hid);
    expect(d.chains.find((c) => c.id === chainId)?.storeSelectDefault).toBe(true);
    // 他世帯のユーザーは更新できない
    const b = await signInTestUser(admin, "s7a", 2);
    userIds.push(b.userId);
    await b.db.rpc("bootstrap_household");
    await x(b.db).from("chains").update({ store_select_default: false }).eq("id", chainId);
    expect((await x(admin).from("chains").select("store_select_default").eq("id", chainId).single()).data.store_select_default).toBe(true);
  });
});
