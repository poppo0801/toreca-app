import { describe, expect, it } from "vitest";
import { parseListHints, parseListing } from "@/lib/collector/listing";

const tags = 'class="relative pointer-events-none p-2.5 lg:p-3 lg:pb-3.5 flex flex-col gap-1 lg:gap-[5px] flex-1 text-[11px] lg:text-xs font-semibold text-[#525252] line-clamp-1"';
const card = (store: string, product: string, url: string) =>
  `<article class="relative flex flex-col"><button type="button" aria-label="${store}の詳細と応募のしかた"></button><div ${tags}><span ${tags}>${product}</span><span ${tags}>${store}</span><span ${tags}>販売価格 <span ${tags}>¥7,200</span></span><span ${tags}>11/4(水) 21:00まで</span><span ${tags}><span ${tags}></span><span ${tags}>東京都・Xでフォロー</span></span><a href="${url}" ${tags}>応募する</a></div></article>`;

describe("一覧のカード全体の文章（5X）", () => {
  const html = `<link rel="x">${card("架空ショップ一号店", "テスト拡張パック", "https://t.co/aaaa")}${card("架空ショップ二号店", "別のテスト商品", "https://t.co/bbbb")}`;
  const e = parseListing("pokeso", html, "https://list.example.invalid/chusen");
  it("リンク直前の数百文字では届かない店舗名・商品名を、カード全体から取得する", () => {
    expect(e).toHaveLength(2);
    expect(e[0].context).not.toContain("架空ショップ一号店");
    expect(e[0].card).toContain("架空ショップ一号店");
    expect(e[0].card).toContain("テスト拡張パック");
    expect(e[0].card).toContain("11/4(水) 21:00まで");
  });
  it("別のカードの文章は混ぜない", () => {
    expect(e[0].card).not.toContain("二号店");
    expect(e[1].card).toContain("二号店");
    expect(e[1].card).not.toContain("一号店");
  });
  it("カードの外にあるリンク（<link>や閉じた後のリンク）にはカードを付けない", () => {
    const r = parseListing("generic", `<ul><li>前</li></ul><a href="https://a.example.invalid/x">ポケカ 抽選</a>`, "https://list.example.invalid/");
    expect(r[0].card).toBeUndefined();
  });
  it("カード全体からも締切・都道府県を読み取れる", () => {
    const h = parseListHints(`${e[0].title} ${e[0].card}`, new Date("2026-11-04T03:00:00Z"));
    expect(h.deadlineIso).toBe("2026-11-04T12:00:00.000Z");
    expect(h.prefecture).toBe("東京都");
  });
});
