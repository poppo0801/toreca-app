/**
 * Stage 4B.5 の結合テスト（実Supabase・RLS適用下）: AI解析フィードバックの記録、別表記の表、世帯の分離。
 *   npm run test:db   ※ マイグレーション 20261029000021 の適用後に実行する
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ExtractedLottery } from "@/lib/ai/extraction";
import { normalizeExtraction } from "@/lib/ai/extraction";
import type { Json } from "@/types/database";
import { saveLottery, type Db } from "@/lib/server/lottery-service";
import type { LotteryInput } from "@/lib/lottery-input";
import { adminClient, cleanupTestUsers, dbTestsEnabled, signInTestUser } from "./helpers/db";

describe.skipIf(!dbTestsEnabled)("Stage 4B.5: AI解析フィードバック", () => {
  const admin = adminClient();
  const ids: string[] = [];
  let u1: Db;
  let u2: Db;
  let hid1: string;
  let hid2: string;
  let chainId: string;
  let productId: string;
  let profile: string;
  let extraction: ExtractedLottery;

  const flex = (date: string, time: string) => ({ precision: time ? ("date_time" as const) : ("date_only" as const), date, time });
  const input = (over: Partial<LotteryInput> = {}): LotteryInput => ({
    chain: { id: chainId, name: "" },
    store: { id: null, name: "三宮店", prefecture: "" },
    multiMode: "single",
    campaignId: null,
    newCampaign: null,
    items: [{ id: null, product: { id: productId, name: "" }, quantity: 1, unit: "box" }],
    applyStart: { precision: "unknown", date: "", time: "" },
    applyDeadline: flex("2026-11-10", "23:59"),
    resultDate: flex("2026-11-13", ""),
    procedureDeadline: { precision: "unknown", date: "", time: "" },
    receiveMethod: "store",
    applyMethod: "app",
    conditionsText: "",
    verificationText: "",
    announcementMethod: "",
    announcementUrl: "",
    sourceUrls: [],
    eventState: "open",
    limitBasis: "person",
    limitMaxCount: 1,
    memo: "",
    applications: [],
    appliedAt: "",
    ...over,
  });
  const log = async (db: Db, hid: string) => {
    const r = await db
      .from("ai_extraction_logs")
      .insert({ household_id: hid, kind: "text", engine: "anthropic", status: "ok", model: "claude-haiku-5-5", prompt_version: "test", extraction: extraction as unknown as Json })
      .select("id")
      .single();
    expect(r.error).toBeNull();
    return r.data!.id as string;
  };
  const rec = (x: LotteryInput) => x as unknown as Record<string, unknown>;

  beforeAll(async () => {
    const a = await signInTestUser(admin, "s4b5", 1);
    const b = await signInTestUser(admin, "s4b5", 2);
    ids.push(a.userId, b.userId);
    u1 = a.db;
    u2 = b.db;
    hid1 = (await u1.rpc("bootstrap_household")).data as string;
    hid2 = (await u2.rpc("bootstrap_household")).data as string;
    profile = (await u1.from("profiles").select("id").limit(1)).data![0].id;
    chainId = (await u1.from("chains").insert({ household_id: hid1, name: "4B5系列" }).select("id").single()).data!.id;
    productId = (await u1.from("products").insert({ household_id: hid1, official_name: "4B5商品", packs_per_box: 20 }).select("id").single()).data!.id;
    extraction = normalizeExtraction(
      {
        is_lottery_announcement: true,
        chain_name: "4B5系列",
        store_name: "三宮店",
        products: [{ name: "4B5商品", code: "", quantity: 1, unit: "box" }],
        multi_mode: "single",
        apply_deadline: { year: 2026, month: 11, day: 10, hour: 23, minute: 59 },
        result_date: { year: 2026, month: 11, day: 13, hour: null, minute: null },
        apply_method: "app",
        receive_method: "store",
      },
      new Date("2026-10-28T03:00:00Z"),
    );
  });
  afterAll(async () => {
    await cleanupTestUsers(admin, ids);
  });

  it("AI読み取りから新規登録すると、採用/修正/補完を1件だけ記録する。理由（明示）は修正しただけでは増えない", async () => {
    const runId = await log(u1, hid1);
    const final = input({ applyDeadline: flex("2026-11-11", "23:59"), conditionsText: "会員のみ", aiFeedback: { runId, filled: rec(input()), reason: "other_source" } });
    const res = await saveLottery(u1, hid1, null, final, profile);
    expect(res.ok).toBe(true);
    const fb = await u1.from("ai_extraction_feedback").select("*").eq("run_id", runId).single();
    expect(fb.error).toBeNull();
    expect(fb.data).toMatchObject({ engine: "anthropic", kind: "text", reason: "other_source", explicit_error_count: 0 });
    const fr = fb.data!.field_results as Record<string, { status: string }>;
    expect(fr.applyDeadline.status).toBe("modified");
    expect(fr.conditions.status).toBe("supplemented");
    expect(fr.resultDate.status).toBe("adopted");
    expect(fb.data!.modified_count).toBeGreaterThanOrEqual(1);
    expect(fb.data!.supplemented_count).toBeGreaterThanOrEqual(1);
  });

  it("同じ解析からの再送信でも重複しない。登録後の編集では記録しない", async () => {
    const runId = await log(u1, hid1);
    const mk = () => input({ aiFeedback: { runId, filled: rec(input()), reason: null } });
    const first = await saveLottery(u1, hid1, null, mk(), profile);
    expect(first.ok).toBe(true);
    const second = await saveLottery(u1, hid1, null, mk(), profile);
    expect(second.ok).toBe(true);
    expect((await u1.from("ai_extraction_feedback").select("id").eq("run_id", runId)).data).toHaveLength(1);

    if (first.ok) {
      const edited = await saveLottery(u1, hid1, first.value.id, input({ applyDeadline: flex("2026-12-01", "12:00"), aiFeedback: { runId, filled: rec(input()), reason: "ai_wrong" } }), profile);
      expect(edited.ok).toBe(true);
      const rows = (await u1.from("ai_extraction_feedback").select("reason").eq("run_id", runId)).data!;
      expect(rows).toHaveLength(1);
      expect(rows[0].reason).toBeNull();
    }
  });

  it("存在しない解析ID・他世帯の解析IDでは記録せず、抽選の保存は成功する", async () => {
    const other = await log(u2, hid2);
    for (const runId of [crypto.randomUUID(), other]) {
      const res = await saveLottery(u1, hid1, null, input({ aiFeedback: { runId, filled: rec(input()), reason: null } }), profile);
      expect(res.ok).toBe(true);
    }
    expect((await admin.from("ai_extraction_feedback").select("id").eq("run_id", other)).data ?? []).toHaveLength(0);
  });

  it("フィードバックは追記専用（更新・削除不可）で、他世帯からは見えない。不正な挿入は拒否される", async () => {
    const runId = await log(u1, hid1);
    expect((await saveLottery(u1, hid1, null, input({ aiFeedback: { runId, filled: rec(input()), reason: null } }), profile)).ok).toBe(true);
    const row = (await u1.from("ai_extraction_feedback").select("id,lottery_id").eq("run_id", runId).single()).data!;
    expect((await u1.from("ai_extraction_feedback").update({ reason: "ai_wrong" }).eq("id", row.id).select()).data ?? []).toHaveLength(0);
    expect((await u1.from("ai_extraction_feedback").delete().eq("id", row.id).select()).data ?? []).toHaveLength(0);
    expect((await u2.from("ai_extraction_feedback").select("id")).data ?? []).toHaveLength(0);
    const bad = await u2.from("ai_extraction_feedback").insert({ household_id: hid1, run_id: runId, lottery_id: row.lottery_id, engine: "anthropic", kind: "text", field_results: {} });
    expect(bad.error).not.toBeNull();
    const badEngine = await u1.from("ai_extraction_feedback").insert({ household_id: hid1, run_id: crypto.randomUUID(), lottery_id: row.lottery_id, engine: "x", kind: "text", field_results: {} });
    expect(badEngine.error).not.toBeNull();
  });

  it("系列・店舗の別表記: 同じ世帯で重複不可。他世帯の系列には付けられず、他世帯からは見えない", async () => {
    const add = (db: Db, hid: string, chain: string, alias: string) => db.from("chain_aliases").insert({ household_id: hid, chain_id: chain, alias, normalized_alias: alias.toLowerCase() });
    expect((await add(u1, hid1, chainId, "ジョーシン")).error).toBeNull();
    expect((await add(u1, hid1, chainId, "ジョーシン")).error).not.toBeNull();
    expect((await add(u2, hid2, chainId, "ほか")).error).not.toBeNull();
    expect((await u2.from("chain_aliases").select("id")).data ?? []).toHaveLength(0);
    const store = (await u1.from("stores").insert({ household_id: hid1, chain_id: chainId, name: "4B5店" }).select("id").single()).data!.id;
    expect((await u1.from("store_aliases").insert({ household_id: hid1, store_id: store, alias: "三宮", normalized_alias: "三宮" })).error).toBeNull();
    expect((await u1.from("store_aliases").insert({ household_id: hid1, store_id: store, alias: "三宮", normalized_alias: "三宮" })).error).not.toBeNull();
  });
});
