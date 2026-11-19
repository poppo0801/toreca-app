/**
 * Stage 9Y の結合テスト（実Supabase・架空データ）: 当選発表の終了日だけの登録（マイグレーション107）。
 *   npm run test:db
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { EMPTY_FLEX, type LotteryInput } from "@/lib/lottery-input";
import { loadAppData, saveLottery, type Db } from "@/lib/server/lottery-service";
import { resultStage } from "@/lib/lottery-flow";
import { adminClient, cleanupTestUsers, dbTestsEnabled, signInTestUser } from "./helpers/db";

describe.skipIf(!dbTestsEnabled)("Stage 9Y: 当選発表の終了日だけの登録", () => {
  const admin = adminClient();
  const userIds: string[] = [];
  let db: Db;
  let hid: string;
  let profA: string;

  const input = (over: Partial<LotteryInput> = {}): LotteryInput => ({
    chain: { id: null, name: "9Y系列" },
    store: { id: null, name: "9Y店", prefecture: "" },
    multiMode: "single",
    campaignId: null,
    newCampaign: null,
    items: [{ product: { id: null, name: "9Y商品" }, quantity: 1, unit: "box" }],
    applyStart: EMPTY_FLEX,
    applyDeadline: { precision: "date_only", date: "2026-10-24", time: "" },
    resultDate: EMPTY_FLEX,
    resultEndDate: "2026-10-30",
    procedureDeadline: EMPTY_FLEX,
    receiveMethod: "store",
    applyMethod: "web",
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

  beforeAll(async () => {
    const a = await signInTestUser(admin, "s9y", 1);
    userIds.push(a.userId);
    db = a.db;
    hid = (await db.rpc("bootstrap_household")).data as string;
    profA = ((await db.from("profiles").select("id,label")).data ?? []).find((p) => p.label === "A")!.id;
  });
  afterAll(async () => {
    await cleanupTestUsers(admin, userIds);
  });

  it("開始日が不明のまま終了日だけを保存でき、読み戻しても終了日のみ（開始日は推定値でも保存されない）", async () => {
    const r = await saveLottery(db, hid, null, input(), profA);
    expect(r.ok, r.ok ? "" : r.error).toBe(true);
    if (!r.ok) return;
    const row = (await db.from("lotteries").select("result_precision,result_date,result_at,result_end_date").eq("id", r.value.id).single()).data!;
    expect(row).toMatchObject({ result_precision: "unknown", result_date: null, result_at: null, result_end_date: "2026-10-30" });
    const lot = (await loadAppData(db)).lotteries.find((l) => l.id === r.value.id)!;
    expect(lot.resultDate.precision).toBe("unknown");
    expect(lot.resultEndDate).toBe("2026-10-30");
    // 応募締切の翌日を内部の開始日とみなして「発表期間中」を判定する（表示判定のみ）
    expect(resultStage(lot, new Date("2026-10-26T03:00:00Z"))).toBe("in_period");
  });

  it("開始日があるときの『終了日 >= 開始日』の制約は従来どおり（DBでも拒否される）", async () => {
    const bad = await db.from("lotteries").update({ result_precision: "date_only", result_date: "2026-10-28", result_end_date: "2026-10-27" }).eq("household_id", hid);
    expect(bad.error).not.toBeNull();
  });
});
