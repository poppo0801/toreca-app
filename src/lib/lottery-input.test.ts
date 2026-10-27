import { describe, expect, it } from "vitest";
import { createMockData } from "@/data/mock";
import { dbToFlex, EMPTY_FLEX, flexInputToDb, flexToInput, jstToIso, lotteryInputSchema } from "@/lib/lottery-input";
import { setEventState } from "@/lib/mutations";
import { manualPurchaseSchema } from "@/lib/purchase-input";

const uuid = "123e4567-e89b-42d3-a456-426614174000";
const valid = {
  chain: { id: uuid, name: "" },
  store: { id: uuid, name: "" },
  campaignId: null,
  newCampaign: null,
  items: [{ product: { id: uuid, name: "" }, quantity: 1, unit: "box" as const }],
  applyStart: EMPTY_FLEX,
  applyDeadline: EMPTY_FLEX,
  resultDate: EMPTY_FLEX,
  procedureDeadline: EMPTY_FLEX,
  receiveMethod: "store" as const,
  applyMethod: "web" as const,
  conditionsText: "",
  verificationText: "",
  announcementMethod: "",
  announcementUrl: "",
  sourceUrls: [],
  eventState: "open" as const,
  limitBasis: "unknown" as const,
  limitMaxCount: 1,
  memo: "",
};

describe("抽選入力の検証", () => {
  it("過去の締切でも受理し、日時が不明な項目はすべて不明のまま通る", () => {
    expect(lotteryInputSchema.safeParse(valid).success).toBe(true);
    const past = { ...valid, applyDeadline: { precision: "date_time" as const, date: "2020-01-01", time: "10:00" } };
    expect(lotteryInputSchema.safeParse(past).success).toBe(true);
  });
  it("日付のみ・日時は必要な欄が欠けると拒否する（時刻を推測で補わない）", () => {
    const noDate = { ...valid, resultDate: { precision: "date_only" as const, date: "", time: "" } };
    const noTime = { ...valid, resultDate: { precision: "date_time" as const, date: "2026-01-01", time: "" } };
    expect(lotteryInputSchema.safeParse(noDate).success).toBe(false);
    expect(lotteryInputSchema.safeParse(noTime).success).toBe(false);
  });
  it("商品必須・数量1以上・URLはhttp(s)のみ", () => {
    expect(lotteryInputSchema.safeParse({ ...valid, items: [] }).success).toBe(false);
    expect(lotteryInputSchema.safeParse({ ...valid, items: [{ product: { id: uuid, name: "" }, quantity: 0, unit: "box" }] }).success).toBe(false);
    expect(lotteryInputSchema.safeParse({ ...valid, announcementUrl: "javascript:alert(1)" }).success).toBe(false);
    expect(lotteryInputSchema.safeParse({ ...valid, sourceUrls: ["ftp://x"] }).success).toBe(false);
    expect(lotteryInputSchema.safeParse({ ...valid, announcementUrl: "https://example.com/a" }).success).toBe(true);
  });
});

describe("日時の変換（JST・精度）", () => {
  it("JSTの日時はUTCに変換され、往復で同じ入力に戻る", () => {
    expect(jstToIso("2026-01-10", "23:59")).toBe("2026-01-10T14:59:00.000Z");
    const input = { precision: "date_time" as const, date: "2026-01-10", time: "23:59" };
    const db = flexInputToDb(input);
    expect(db).toEqual({ precision: "date_time", date: null, at: "2026-01-10T14:59:00.000Z" });
    expect(flexToInput(dbToFlex(db.precision, db.date, db.at))).toEqual(input);
  });
  it("日付のみ・不明は時刻を持たない", () => {
    expect(flexInputToDb({ precision: "date_only", date: "2026-02-03", time: "12:00" })).toEqual({ precision: "date_only", date: "2026-02-03", at: null });
    expect(flexInputToDb(EMPTY_FLEX)).toEqual({ precision: "unknown", date: null, at: null });
    expect(dbToFlex("date_time", null, null)).toEqual({ precision: "unknown" });
  });
});

describe("購入入力・状態変更", () => {
  it("金額不明(null)と0円を区別して受理する", () => {
    const base = { storeId: "", date: "", time: "", channel: "store" as const, note: "" };
    expect(manualPurchaseSchema.safeParse({ ...base, items: [{ productId: "", quantity: 1, unit: "box", amountPaid: null }] }).success).toBe(true);
    expect(manualPurchaseSchema.safeParse({ ...base, items: [{ productId: "", quantity: 1, unit: "box", amountPaid: 0 }] }).success).toBe(true);
    expect(manualPurchaseSchema.safeParse({ ...base, items: [{ productId: "", quantity: 1, unit: "box", amountPaid: -1 }] }).success).toBe(false);
    expect(manualPurchaseSchema.safeParse({ ...base, items: [] }).success).toBe(false);
  });
  it("中止・延期は抽選の状態として記録され、個別の応募結果は変わらない", () => {
    const now = new Date("2026-10-26T03:00:00Z");
    const d0 = createMockData(now);
    const d1 = setEventState(d0, "pA", "L1", "cancelled", now);
    expect(d1.lotteries.find((l) => l.id === "L1")?.eventState).toBe("cancelled");
    expect(d1.applications).toEqual(d0.applications);
    expect(d1.audit[0]).toMatchObject({ action: "set_event_state" });
    expect(setEventState(d1, "pA", "L1", "cancelled", now)).toBe(d1);
  });
});
