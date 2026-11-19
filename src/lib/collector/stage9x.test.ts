import { describe, expect, it } from "vitest";
import { decideRegistration, type RegistrationContext } from "@/lib/collector/attention";
import { EMPTY_FLEX, type LotteryInput } from "@/lib/lottery-input";

const known = { ...EMPTY_FLEX, precision: "date_only" as const, date: "2026-11-20" };
const ctx = (storeName: string): RegistrationContext => ({
  input: {
    chain: { id: "c1", name: "テスト" }, store: { id: null, name: storeName, prefecture: "" }, items: [{ product: { id: "p1", name: "商品A" }, quantity: 1, unit: "box" }],
    applyStart: known, applyDeadline: known, resultDate: known, procedureStart: known, procedureDeadline: known, receiveStart: known, receiveDeadline: known,
    receiveMethod: "store", applyMethod: "web", requirementTags: [], sourceUrls: ["https://example.invalid/a"], conditionsText: "会員",
  } as unknown as LotteryInput,
  verdict: "match", verdictReasons: [], missing: [], fields: {}, duplicateCount: 0, stage: "open", modePending: false, textConflict: null, storeResolved: true, now: "2026-11-19T00:00:00Z",
});

describe("Stage 9X: 複数の店舗名が1つにまとまった店舗名は、自動登録しない", () => {
  it("「渋谷店、浜松店」のような名前は確認待ち（C）にし、理由を示す。通常の店舗名は従来どおり", () => {
    const multi = decideRegistration(ctx("渋谷店、浜松店"));
    expect(multi.grade).toBe("C");
    expect(multi.blockers.join()).toContain("複数の店舗名");
    expect(decideRegistration(ctx("天王寺店")).grade).not.toBe("C");
    expect(decideRegistration(ctx("ホビー・ランド 梅田店")).grade).not.toBe("C");
  });
});
