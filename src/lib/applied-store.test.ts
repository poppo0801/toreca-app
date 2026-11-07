import { describe, expect, it } from "vitest";
import { appliedStoreLabel, SELECT_STORE_PLACEHOLDER, storeChoices } from "@/lib/applied-store";

const stores = [
  { id: "s1", chainId: "c1", name: "大阪店", prefecture: "大阪府", archived: false },
  { id: "s2", chainId: "c1", name: SELECT_STORE_PLACEHOLDER, prefecture: "", archived: false },
  { id: "s3", chainId: "c2", name: "他系列店", prefecture: "東京都", archived: false },
  { id: "s4", chainId: "c1", name: "閉店", prefecture: "兵庫県", archived: true },
] as never;

describe("応募店舗の候補", () => {
  it("店舗一覧が取得済みなら、それを候補にする（マスターにある店舗は id を補う）", () => {
    const r = storeChoices({ stores }, { chainId: "c1", selectableStores: [{ name: "大阪店", prefecture: "" }, { name: "京都店", prefecture: "京都府" }] });
    expect(r).toEqual([{ id: "s1", name: "大阪店", prefecture: "大阪府" }, { id: null, name: "京都店", prefecture: "京都府" }]);
  });
  it("一覧が不明なら同じ系列の店舗マスターを候補にする（仮の店舗・他系列・アーカイブ済みは除く）", () => {
    expect(storeChoices({ stores }, { chainId: "c1", selectableStores: [] })).toEqual([{ id: "s1", name: "大阪店", prefecture: "大阪府" }]);
  });
  it("店舗が無い系列は候補が空（手入力）", () => {
    expect(storeChoices({ stores }, { chainId: "c9" })).toEqual([]);
  });
  it("未設定は明示的に null", () => {
    expect(appliedStoreLabel(null)).toBeNull();
    expect(appliedStoreLabel({ name: "", prefecture: "" })).toBeNull();
    expect(appliedStoreLabel({ name: "大阪店", prefecture: "大阪府" })).toBe("大阪店（大阪府）");
  });
});
