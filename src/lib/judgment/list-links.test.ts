// @vitest-environment node
/** Stage 10M: 項目の応募先リンク（短縮→展開の対応）・単独投稿の1項目化。架空データのみ。 */
import { describe, expect, it } from "vitest";
import { linkResolver, parseListItems, singleItemParent } from "./list-items";

const T = "🏯架空 | 2件 《店A（県）- 1件》 ・架空TCG 抽選 https://t.co/aa - 11/22(日)23:59〆 《店B（県）- 1件》 ・架空TCG 抽選 https://t.co/bb - 11/22(日)23:59〆 《店C（県）- 1件》 ・別TCG 抽選 https://t.co/cc - 11/23(月)23:59〆";

describe("項目の応募先: 展開後のURLが同じ項目だけを同一応募の根拠にできる", () => {
  const p = parseListItems(T);
  it("対応表があれば、項目ごとの応募先（ホスト）と、同じ応募先かが分かる。トラッキング引数・末尾スラッシュ・wwwの差は吸収", () => {
    const r = linkResolver([{ short: "https://t.co/aa", url: "https://www.shop.example.com/lottery/1/?utm_source=x" }, { short: "https://t.co/bb", url: "https://shop.example.com/lottery/1" }, { short: "https://t.co/cc", url: "https://other.example.com/l/2" }]);
    expect(r.host(p.items[0])).toBe("shop.example.com");
    expect(r.sameDestination(p.items[0], p.items[1])).toBe(true);
    expect(r.sameDestination(p.items[0], p.items[2])).toBe(false);
  });
  it("対応表が無い・表にない短縮リンクの項目は、応募先を特定できない（同一とは言えない＝統合しない）", () => {
    const none = linkResolver(undefined);
    expect(none.sameDestination(p.items[0], p.items[1])).toBe(false);
    expect(none.host(p.items[0])).toBeNull();
    const partial = linkResolver([{ short: "https://t.co/aa", url: "https://shop.example.com/x" }]);
    expect(partial.sameDestination(p.items[0], p.items[1])).toBe(false);
  });
});

describe("単独の投稿（一覧でない）を、同じ処理の流れに乗せる", () => {
  it("本文全体が項目1（範囲は原文と一致）。空に近い本文は項目なし", () => {
    const text = "  単独の告知 架空TCG 抽選 4/8まで https://t.co/x  ";
    const s = singleItemParent(text);
    expect(s.isList).toBe(false);
    expect(s.items).toHaveLength(1);
    expect(text.slice(s.items[0].start, s.items[0].end)).toBe(s.items[0].text);
    expect(s.items[0].links).toEqual(["https://t.co/x"]);
    expect(singleItemParent(" ").items).toEqual([]);
  });
});
