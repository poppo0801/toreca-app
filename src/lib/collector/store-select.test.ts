import { describe, expect, it } from "vitest";
import { detectStoreSelect } from "@/lib/collector/store-select";
import { DEFAULT_CONDITIONS, evaluateCandidate } from "@/lib/collector/conditions";
import type { LotteryInput } from "@/lib/lottery-input";

describe("店舗選択式の抽選の判定", () => {
  it("応募時に店舗を選ぶ文言を判定する", () => {
    expect(detectStoreSelect({ texts: ["受取店舗を選択して応募してください"] })).toBe(true);
    expect(detectStoreSelect({ texts: ["応募時に店舗をお選びください"] })).toBe(true);
  });
  it("トレカキャピタルは文言が無くても店舗選択式", () => {
    expect(detectStoreSelect({ texts: ["抽選販売のお知らせ"], chainName: "トレカキャピタル" })).toBe(true);
  });
  it("関係のない告知は判定しない（推測で店舗選択式にしない）", () => {
    expect(detectStoreSelect({ texts: ["店頭にて抽選を実施します。梅田店でお受取り"], chainName: "ヨドバシ" })).toBe(false);
    expect(detectStoreSelect({ texts: [null, ""] })).toBe(false);
  });
});

const NOW = new Date("2026-11-07T00:00:00Z");
const base = (over: Partial<LotteryInput>): LotteryInput =>
  ({
    chain: { id: null, name: "トレカキャピタル" },
    store: { id: null, name: "応募時に店舗選択", prefecture: "" },
    storeMode: "select_on_apply",
    selectableStores: [],
    multiMode: "single",
    items: [{ product: { id: null, name: "テスト弾" }, quantity: 1, unit: "box" }],
    applyStart: { precision: "unknown", date: "", time: "" },
    applyDeadline: { precision: "date_only", date: "2026-11-20", time: "" },
    receiveMethod: "store",
    applyMethod: "web",
    requirementTags: [],
    sourceUrls: [],
    ...over,
  }) as unknown as LotteryInput;
const ctx = { prefecture: "", storeKind: "physical" as const, distanceKm: null, now: NOW };

describe("店舗選択式の抽選の地域判定", () => {
  const cond = { ...DEFAULT_CONDITIONS, prefectures: ["大阪府", "兵庫県"], includeOnline: false };
  it("都道府県が取得できない場合は、地域不明を理由に除外しない", () => {
    expect(evaluateCandidate(base({}), cond, ctx).verdict).toBe("match");
  });
  it("選べる店舗の1店舗でも対象地域なら収集する", () => {
    const i = base({ selectableStores: [{ name: "東京店", prefecture: "東京都" }, { name: "大阪店", prefecture: "大阪府" }] });
    expect(evaluateCandidate(i, cond, ctx).verdict).toBe("match");
  });
  it("選べる店舗がすべて対象外と確認できたときは、従来どおり除外する", () => {
    const i = base({ selectableStores: [{ name: "東京店", prefecture: "東京都" }, { name: "福岡店", prefecture: "福岡県" }] });
    const e = evaluateCandidate(i, cond, ctx);
    expect(e.verdict).toBe("exclude");
    expect(e.reasons.join()).toContain("対象外の地域");
  });
  it("一部の店舗の都道府県が不明で、残りが対象外のときは除外しない", () => {
    const i = base({ selectableStores: [{ name: "東京店", prefecture: "東京都" }, { name: "不明店", prefecture: "" }] });
    expect(evaluateCandidate(i, cond, ctx).verdict).toBe("match");
  });
  it("店舗固定の抽選は従来どおり（地域不明は要確認）", () => {
    const fixed = base({ storeMode: "fixed", store: { id: null, name: "どこかの店", prefecture: "" } });
    expect(evaluateCandidate(fixed, cond, ctx).verdict).toBe("review");
  });
});
