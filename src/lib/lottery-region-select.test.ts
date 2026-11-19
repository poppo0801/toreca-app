import { describe, expect, it } from "vitest";
import { matchLotteryRegion } from "@/lib/lottery-view";

const KANSAI = ["兵庫県", "大阪府", "京都府"];
const select = (stores: { name: string; prefecture: string }[]) => ({ storeMode: "select_on_apply" as const, selectableStores: stores, receiveMethod: "store" as const });
const placeholder = { prefecture: "", salesKind: "physical" };

describe("店舗選択式の地域判定（選べる店舗の都道府県で判定）", () => {
  it("選べる店舗がすべて対象地域外（都道府県が分かっている）なら地域外", () => {
    expect(matchLotteryRegion(KANSAI, select([{ name: "渋谷店", prefecture: "東京都" }, { name: "浜松店", prefecture: "静岡県" }]), placeholder)).toBe(false);
  });
  it("1つでも対象地域内、または都道府県が不明なら表示する（見落とし防止）", () => {
    expect(matchLotteryRegion(KANSAI, select([{ name: "渋谷店", prefecture: "東京都" }, { name: "梅田店", prefecture: "大阪府" }]), placeholder)).toBe(true);
    expect(matchLotteryRegion(KANSAI, select([{ name: "渋谷店", prefecture: "東京都" }, { name: "不明店", prefecture: "" }]), placeholder)).toBe(true);
  });
  it("選べる店舗が未登録・地域の指定なし・通常の抽選は従来どおり", () => {
    expect(matchLotteryRegion(KANSAI, select([]), placeholder)).toBe(true); // 店舗未登録の選択式は除外しない
    expect(matchLotteryRegion([], select([{ name: "渋谷店", prefecture: "東京都" }]), placeholder)).toBe(true);
    expect(matchLotteryRegion(KANSAI, { storeMode: "fixed", selectableStores: [], receiveMethod: "store" }, { prefecture: "東京都", salesKind: "physical" })).toBe(false);
    expect(matchLotteryRegion(KANSAI, { storeMode: "fixed", selectableStores: [], receiveMethod: "store" }, { prefecture: "", salesKind: "physical" })).toBe(true);
  });
});
