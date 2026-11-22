// @vitest-environment node
/** Stage 10T: 応募ページの構造取得（架空のHTMLでの回帰テスト。実ページの内容は含めない）。 */
import { describe, expect, it } from "vitest";
import { bracketLabel, observeRelated, parseApplyPage, productPhrase, structureToObservations } from "./page-structure";

const card = (title: string, extra = "") => `<section class="event-detail-ticket-card"><div class="event-detail-ticket-card__block"><h4 class="event-detail-ticket-card__title">${title}</h4><div class="event-detail-ticket-card__info"><div class="event-detail-ticket-card__status"><span class="tag-primary">販売中</span></div><p class="event-detail-ticket-card__price"><span>¥0</span>（税込）</p></div></div><div class="event-detail-ticket-card__toggle"><p class="event-detail-ticket-card__text js-toggle-more-content">説明A &amp; 説明B</p></div>${extra}</section>`;
const related = (title: string, place: string) => `<a class="event-card event-card--other" data-turbo="false" href="/e/abc"><div class="event-card__image-box"><span class="tag-primary event-card__tag">販売中</span></div><div class="event-card__info"><h3 class="event-card__title">${title}</h3><p class="event-card__text event-card__text--date"><span class="event-card__date">日程</span> 2026年1月1日(金)<br>〜2026年1月3日(日) </p><p class="event-card__text"> <span class="event-card__place">会場</span> ${place} </p></div></a>`;
const page = (h1: string, cards: string, others = "", note = "") => `<html><h1 class="heading01">${h1}</h1><h2>受付・チケット情報</h2>${note ? `<p class="text-note event-detail-ticket-note">${note}</p>` : ""}${cards}${others ? `<section class="event-detail-other"><h2>同じ販売元のイベント</h2>${others}</section>` : ""}</html>`;

describe("受付枠（カード）の抽出", () => {
  it("(A) 1枠のページ: 枠のタイトル・状態・説明（実体参照を復号）・ページ注意書きを取り出す。店舗選択の記載が無いことも観察として残る", () => {
    const st = parseApplyPage(page("【テスト店A】抽選受付", card("商品X 抽選"), "", "このイベントは、お1人様1回のみ"));
    expect(st.recognized).toBe(true);
    expect(st.slots).toHaveLength(1);
    expect(st.slots[0]).toMatchObject({ title: "商品X 抽選", statusTags: ["販売中"] });
    expect(st.slots[0].description).toBe("説明A & 説明B");
    expect(st.pageNotes).toEqual(["このイベントは、お1人様1回のみ"]);
    expect(st.formChoices).toEqual([]);
    expect(structureToObservations(st).join("\n")).toContain("受付枠（カード）の数: 1件");
  });
  it("(B) 同一ページに複数店舗の枠: 枠ごとにタイトルを保持（枠の数・店舗ラベルはAIに渡す観察。判断はしない）", () => {
    const st = parseApplyPage(page("【系列】商品X", card("【系列甲店】商品X") + card("【系列乙店】商品X") + card("【系列丙店】商品X"), "", "お1人様1店舗のみ応募可能"));
    expect(st.slots.map((s) => bracketLabel(s.title))).toEqual(["系列甲店", "系列乙店", "系列丙店"]);
    const obs = structureToObservations(st);
    expect(obs.join("\n")).toContain("受付枠（カード）の数: 3件");
    expect(obs.join("\n")).toContain("お1人様1店舗のみ応募可能");
    expect(obs.join("\n")).not.toMatch(/店舗選択式|独立した応募/); // 結論を書かない
  });
  it("カードの宣言数と抽出数の食い違い・構造が無いページは欠落として申告する（無いとは言わない）", () => {
    const bad = parseApplyPage(`<html><h1>x</h1><h2>受付・チケット情報</h2><section class="event-detail-ticket-card"><div>壊れたカード</div></section></html>`);
    expect(bad.recognized).toBe(false);
    expect(bad.gaps.join(" ")).toContain("受付枠のカード");
    const none = parseApplyPage(`<html><title>店</title><body>画像だけ</body></html>`);
    expect(none.recognized).toBe(false);
    expect(structureToObservations(none).join("\n")).toContain("検出なし（無いとは限らない）");
  });
});

describe("同じ販売元のイベント（関連イベント）は受付枠と別の構造", () => {
  const st = parseApplyPage(page("【系列甲店】拡張パック商品X 1/1発売", card("拡張パック商品X"), related("【系列乙店】1/1(金)発売 拡張パック商品X 抽選受付", "系列乙店（愛知県）") + related("【系列丙店】別の拡張パック商品Y 抽選受付", "系列丙店（大阪府）")));
  it("関連イベントのタイトル・日程・会場・状態を、受付枠とは別に取り出す", () => {
    expect(st.slots).toHaveLength(1);
    expect(st.relatedEvents).toHaveLength(2);
    expect(st.relatedEvents[0]).toMatchObject({ status: "販売中", place: "系列乙店(愛知県)", href: "/e/abc" });
    expect(st.relatedEvents[0].dateText).toContain("2026年1月1日");
  });
  it("商品の言い回しの一致は観察にとどめる（別商品は一致しない）。関連の表示だけでは応募可否の根拠にしないと明記して渡す", () => {
    const rel = observeRelated(st);
    expect(rel.map((r) => r.samePhraseAsPage)).toEqual([true, false]);
    expect(rel[0].label).toBe("系列乙店");
    const o = structureToObservations(st).join("\n");
    expect(o).toContain("応募可否の根拠にはならない");
    expect(o).toContain("商品の言い回しがこのページと一致");
  });
  it("商品の言い回しの正規化: 括弧ラベル・日付・受付語を除く", () => {
    expect(productPhrase("【甲店】11/27(金)発売 ポケモン 「ABC」 抽選受付")).toBe(productPhrase("ポケモン「ABC」"));
  });
});

describe("フォームの選択肢（宣言だけを読む。送信しない）", () => {
  it("select と radio の選択肢を観察として取り出す。1択だけのラジオは選択欄とみなさない", () => {
    const st = parseApplyPage(`<form><select name="s"><option value="">選択してください</option><option>甲店</option><option>乙店</option></select><input type="radio" name="r" value="1"> A方式 <input type="radio" name="r" value="2"> B方式 <input type="radio" name="one" value="1"> ただ一つ</form>`);
    expect(st.formChoices.map((c) => [c.kind, c.options])).toEqual([["select", ["甲店", "乙店"]], ["radio", ["A方式", "B方式"]]]);
    expect(st.recognized).toBe(true);
  });
});

describe("公開Googleフォーム（設問データの読取。回答・送信はしない）", () => {
  const data = [null, [null, [[1, "お名前", null, 0, [[11, null, 1]]], [2, "抽選を希望する店舗", null, 2, [[12, [["甲店"], ["乙店"]], 1]]], [3, "注意事項", null, 4, [[13, [["確認しました"]], 1]]]], null, null, null, null, null, null, "テスト商品の抽選フォーム"]];
  const html = `<html><script>var FB_PUBLIC_LOAD_DATA_ = ${JSON.stringify(data)};</script></html>`;
  it("フォームの題名・設問・選択肢を取り出し、JS描画の欠落警告は出さない", () => {
    const st = parseApplyPage(html);
    expect(st.siteKind).toBe("google_form");
    expect(st.recognized).toBe(true);
    expect(st.title).toBe("テスト商品の抽選フォーム");
    expect(st.formQuestions.map((q) => [q.kind, q.options])).toEqual([["short_text", []], ["radio", ["甲店", "乙店"]], ["checkbox", ["確認しました"]]]);
    expect(st.gaps).toEqual([]);
    const o = structureToObservations(st).join("\n");
    expect(o).toContain("設問2（radio）「抽選を希望する店舗」 選択肢: 甲店 / 乙店");
    expect(o).toContain("回答・送信はしていない");
  });
  it("形式が想定と違えば、読めなかったと申告する（無いとは言わない）", () => {
    const st = parseApplyPage(`<html><script>var FB_PUBLIC_LOAD_DATA_ = [1,2];</script></html>`);
    expect(st.recognized).toBe(false);
    expect(st.gaps.join(" ")).toContain("読めなかった");
  });
});
