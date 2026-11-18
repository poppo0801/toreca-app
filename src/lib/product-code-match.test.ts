import { describe, expect, it } from "vitest";
import { matchProduct } from "@/lib/lottery-match";
import { splitProductName } from "@/lib/product-name";

/** Stage 9F: 型番（【EB-05】など）・販売形態の語が付いた商品名でも、商品マスターとの照合を失敗させない（実収集の「商品名の判別失敗」への対策）。架空の商品のみ */
const P = (id: string, officialName: string, code = "", aliases: string[] = []) => ({ id, officialName, aliases, code, archived: false, packsPerBox: 30 }) as never;
const master = [P("p1", "ハドウシーカー", "EB-05"), P("p2", "ニンジャスピナー", ""), P("p3", "ハドウシーカー 特別版", "")];
const idOf = (name: string, code = "") => matchProduct(name, code, master as never).item?.id ?? null;

describe("商品名の型番・販売形態", () => {
  it("括弧の型番は商品名から分離し、型番として扱う", () => {
    const p = splitProductName("【EB-05】ハドウシーカー");
    expect(p.cleaned).toBe("ハドウシーカー");
    expect(p.codes).toEqual(["EB-05"]);
  });
  it("型番付きの商品名が、マスターの正式名称・型番に一致する", () => {
    expect(idOf("【EB-05】ハドウシーカー")).toBe("p1");
    expect(idOf("ハドウシーカー［EB05］")).toBe("p1");
    expect(idOf("【EB-05】ニンジャスピナー")).toBe("p2"); // 型番がマスターに無い／一致しなくても、名称が一致すれば照合できる
  });
  it("シュリンク有無・数量・販売状況の語が付いても照合できる", () => {
    expect(idOf("ハドウシーカー（シュリンク付き）1BOX")).toBe("p1");
    expect(idOf("【再販】ニンジャスピナー シュリンクなし")).toBe("p2");
  });
  it("商品を区別する語（特別版）を落として別商品に紐づけない", () => {
    expect(idOf("【EB-05】ハドウシーカー 特別版")).toBe("p3");
  });
  it("商品名ではない括弧（型番に見えない語）は消さない", () => {
    expect(splitProductName("ハドウシーカー【特別版】").cleaned).toContain("特別版");
    expect(splitProductName("ハドウシーカー（第3弾）").codes).toEqual([]);
  });
  it("実在の告知の形（ブランド名＋商品名＋【型番】）でも、型番と名称がマスターに一致すれば照合できる。型番だけでは別の商品に紐づけない", () => {
    const m = [P("e1", "Heroines Edition vol.2", "EB-05"), P("e2", "Heroines Edition vol.3", "EB-06")];
    const id = (n: string) => matchProduct(n, "", m as never).item?.id ?? null;
    expect(id("ONE PIECE Heroines Edition vol.2【EB-05】")).toBe("e1");
    expect(id("ONE PIECE Heroines Edition vol.9【EB-05】")).toBeNull(); // 型番だけが一致し、名称が合わない（別の商品かもしれない）
  });
  it("マスターに無い商品は、型番が付いていても一致させない（推測で紐づけない）", () => {
    expect(idOf("【EB-99】ミライノツバサ")).toBeNull();
  });
});
