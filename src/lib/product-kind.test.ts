import { describe, expect, it } from "vitest";
import { boxHintLabel, boxHintOf, isPackProduct, kindOf, receiptError, unitForProduct, unitOptions } from "@/lib/product-kind";

const values = (o: { value: string }[]) => o.map((x) => x.value);

describe("商品区分ごとの数量の単位", () => {
  it("拡張パックはパック／BOX、構築済みデッキ・プレミアムセット・その他は個", () => {
    expect(values(unitOptions({ productKind: "expansion_pack" }))).toEqual(["box", "pack"]);
    expect(values(unitOptions({ productKind: "deck" }))).toEqual(["piece"]);
    expect(values(unitOptions({ productKind: "premium_set" }))).toEqual(["piece"]);
    expect(values(unitOptions({ productKind: "other" }))).toEqual(["piece"]);
  });
  it("未分類・商品未選択は従来どおりパック／BOX。販売形態が単品・セットと分かっているものは個", () => {
    expect(values(unitOptions(undefined))).toEqual(["box", "pack"]);
    expect(values(unitOptions({ productKind: null, salesForm: null }))).toEqual(["box", "pack"]);
    expect(kindOf({ productKind: null, salesForm: "single_set" })).toBe("other");
    expect(values(unitOptions({ productKind: null, salesForm: "single_set" }))).toEqual(["piece"]);
  });
  it("保存済みの旧データの単位（セットなど）は変換せず、選択肢に残す", () => {
    expect(values(unitOptions({ productKind: "deck" }, "set"))).toEqual(["piece", "set"]);
    expect(values(unitOptions({ productKind: "expansion_pack" }, "set"))).toEqual(["box", "pack", "set"]);
    expect(values(unitOptions({ productKind: "expansion_pack" }, "pack"))).toEqual(["box", "pack"]);
  });
  it("商品を選び直したとき、使える単位は維持し、使えない単位だけ直す", () => {
    expect(unitForProduct({ productKind: "expansion_pack" }, "pack")).toBe("pack");
    expect(unitForProduct({ productKind: "expansion_pack" }, "piece")).toBe("box");
    expect(unitForProduct({ productKind: "deck" }, "box")).toBe("piece");
    expect(isPackProduct({ productKind: "premium_set" })).toBe(false);
  });
});

describe("BOX販売形態の目安", () => {
  it("系列の目安は「（目安）」付き、抽選で確定していればそれを優先して（目安）を付けない", () => {
    const chain = { boxShrinkHint: "shrink" as const };
    const a = boxHintOf({ boxShrinkHint: null }, chain);
    expect(a && boxHintLabel(a)).toBe("シュリンクあり（目安）");
    const b = boxHintOf({ boxShrinkHint: "no_shrink" }, chain);
    expect(b && boxHintLabel(b)).toBe("シュリンクなし");
  });
  it("不明・未設定は表示しない（抽選側が不明でも系列の目安にはならず、系列が不明なら何も出ない）", () => {
    expect(boxHintOf({ boxShrinkHint: null }, { boxShrinkHint: null })).toBeNull();
    expect(boxHintOf({ boxShrinkHint: null }, { boxShrinkHint: "unknown" })).toBeNull();
    expect(boxHintOf({ boxShrinkHint: null }, undefined)).toBeNull();
    const c = boxHintOf({ boxShrinkHint: "unknown" }, { boxShrinkHint: "pack_only" });
    expect(c && boxHintLabel(c)).toBe("パックのみ（目安）");
  });
});

describe("受取のシュリンク状態の検証", () => {
  it("状態ごとの数量の合計が購入数量以下ならよい（混在可）", () => {
    expect(receiptError([{ state: "shrink", quantity: 2 }, { state: "no_shrink", quantity: 1 }], 3)).toBeNull();
    expect(receiptError([{ state: "unknown", quantity: 1 }], 3)).toBeNull();
    expect(receiptError([], 3)).toBeNull();
  });
  it("購入数量の超過・重複した状態・0以下や小数は拒否する", () => {
    expect(receiptError([{ state: "shrink", quantity: 3 }, { state: "no_shrink", quantity: 1 }], 3)).toContain("超えて");
    expect(receiptError([{ state: "shrink", quantity: 1 }, { state: "shrink", quantity: 1 }], 3)).toContain("重複");
    expect(receiptError([{ state: "shrink", quantity: 0 }], 3)).not.toBeNull();
    expect(receiptError([{ state: "shrink", quantity: 1.5 }], 3)).not.toBeNull();
    expect(receiptError([{ state: "shrink", quantity: -1 }], 3)).not.toBeNull();
  });
});
