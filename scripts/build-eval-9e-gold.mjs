// Stage 9E: ページ判定の正解データ（gold-pages.json）の作成。正解は、AIや分類器の出力ではなく、
//   (a) 実在の抽選の情報源ページ（本番の有効な抽選の情報源として利用者が管理していたもの。8F評価データ）＝抽選の告知、
//   (b) 取得したページの本文を人（作業者）が読んで決めた種類
// から作る。分類器の出力に合わせて変更しない。凍結: 作成後は eval/investigation-9e/frozen-hashes.json の整合性を検査する。
//   node scripts/build-eval-9e-gold.mjs
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";

const read = (f) => JSON.parse(readFileSync(f, "utf8"));
const real = new Map();
for (const f of ["pages", "pages-8f3", "pages-8f4"]) for (const v of read(`eval/lottery-grouping-real/${f}.json`).pages) if (!real.has(v.url)) real.set(v.url, v);
const live1 = read("eval/investigation-9e/pages-live.json").pages;
const live2 = read("eval/investigation-9e/pages-live-2.json").pages;

const gold = [];
// (a) 実在の抽選の情報源（フリマ形式の出品 card.luruna.jp は、店舗の抽選か個人の出品か判断が分かれるため採点から除く）
for (const [url] of real) {
  if (url.includes("card.luruna.jp")) gold.push({ url, set: "real", kind: null, actionable: null, ambiguous: true, basis: "フリマ形式の出品。店舗の抽選告知か個人の出品かの判断が分かれるため採点しない" });
  else gold.push({ url, set: "real", kind: "lottery_announcement", actionable: true, basis: "本番で有効な抽選の情報源として管理されていたページ（8F評価データ）" });
}
// (b) 取得したページを読んで決めた種類
const L1 = {
  "https://www.pokemon-card.com/": ["general", "公式トップ。新着欄に抽選結果発表の延期（イベント参加の抽選）が1件あるだけ"],
  "https://www.pokemon-card.com/products/": ["general", "商品情報の一覧"],
  "https://www.pokemon-card.com/info/": ["announcement_index", "ニュース一覧（抽選関連の見出しを含むが、ページ自体は一覧）"],
  "https://www.kiddyland.co.jp/": ["general", "公式トップ"],
  "https://www.kiddyland.co.jp/news/": ["general", "ニュース（抽選の記載なし）"],
  "https://www.c-labo.jp/": ["announcement_index", "店舗ブログの新着一覧（抽選販売の告知の見出しが多数）"],
  "https://www.c-labo.jp/shop/tsudanuma/": ["announcement_index", "店舗ページの新着一覧"],
  "https://www.bookoff.co.jp/": ["general", "公式トップ"],
  "https://geo-online.co.jp/": ["announcement_index", "トップのお知らせ一覧（抽選販売受付のお知らせの見出しを含む）"],
  "https://books.rakuten.co.jp/": ["general", "公式トップ"],
  "https://www.toysrus.co.jp/": ["general", "公式トップ"],
  "https://www.yamada-denki.jp/": ["general", "公式トップ"],
  "https://www.suruga-ya.jp/": ["general", "公式トップ"],
  "https://www.hmv.co.jp/": ["general", "公式トップ。商品名に『抽選特典』の語が1回あるだけ"],
  "https://www.pokemon.co.jp/": ["general", "公式トップ"],
  "https://www.pokemon-card.com/rules/": ["general", "ルール説明"],
  "https://www.pokemon-card.com/card-search/": ["general", "カード検索"],
  "https://www.pokemon-card.com/howtoplay/": ["general", "遊び方の説明"],
};
for (const p of live1) {
  const g = L1[p.url];
  if (!g) throw new Error(`正解が未定義: ${p.url}`);
  gold.push({ url: p.url, set: "live1", kind: g[0], actionable: false, basis: g[1] });
}
const L2 = {
  "https://www.c-labo.jp/shop/nagoyaekimae/blog/624574/": ["lottery_announcement", "抽選販売のお知らせ（ONE PIECE Heroines Edition vol.2）"],
  "https://www.c-labo.jp/shop/kokura/blog/624560/": ["lottery_announcement", "再販抽選販売のお知らせ"],
  "https://www.c-labo.jp/shop/nipponbashi/blog/624555/": ["lottery_announcement", "抽選予約のお知らせ（ハドウシーカー）"],
  "https://www.c-labo.jp/shop/nipponbashi/blog/624550/": ["lottery_announcement", "再抽選販売のお知らせ"],
  "https://www.c-labo.jp/shop/takasaki/blog/624548/": ["lottery_announcement", "抽選予約のお知らせ（ハドウシーカー）"],
  "https://www.c-labo.jp/shop/kagoshima/blog/624542/": ["lottery_announcement", "再販抽選販売のお知らせ"],
  "https://www.c-labo.jp/shop/otaro/blog/624536/": ["lottery_announcement", "再販抽選販売のお知らせ"],
  "https://www.c-labo.jp/shop/okayamanishi/blog/624532/": ["lottery_announcement", "再販抽選販売のお知らせ（応募期間つき）"],
  "https://www.c-labo.jp/shop/niigata/blog/624529/": ["lottery_announcement", "抽選予約のお知らせ（ハドウシーカー）"],
  "https://www.c-labo.jp/shop/tsudanuma/blog/623696/": ["lottery_announcement", "抽選予約販売のお知らせ（スペシャルデッキセット）"],
  "https://www.c-labo.jp/shop/tsudanuma/blog/581202/": ["general", "買取情報の記事（抽選の告知ではない。サイドバーに他の記事の見出しがある）"],
  "https://www.c-labo.jp/information/620246/": ["general", "臨時休業のお知らせ"],
  "https://www.c-labo.jp/information/612840/": ["past_lottery", "抽選作業は完了済み。当選者への手続き・問い合わせの案内（新たに応募できる抽選ではない）"],
  "https://geo-online.co.jp/news/788": ["lottery_announcement", "抽選販売受付のお知らせ（ONE PIECE 神の支配）"],
  "https://geo-online.co.jp/news/791": ["general", "メンテナンス終了のお知らせ（抽選の告知ではない。サイドバーに他の見出しがある）"],
  "https://www.c-labo.jp/blog/": ["announcement_index", "店舗ブログの一覧"],
  "https://www.c-labo.jp/information/": ["announcement_index", "お知らせの一覧"],
  "https://geo-online.co.jp/news/": ["announcement_index", "お知らせの一覧"],
};
for (const p of live2) {
  const g = L2[p.url];
  if (!g) throw new Error(`正解が未定義: ${p.url}`);
  gold.push({ url: p.url, set: "live2", kind: g[0], actionable: g[0] === "lottery_announcement", basis: g[1] });
}
writeFileSync("eval/investigation-9e/gold-pages.json", JSON.stringify({ version: 1, note: "ページの種類の正解。AI・分類器の出力に合わせて変更しない。set: real=実在の抽選の情報源／live1・live2=取得して本文を読んで決めたもの", pages: gold }, null, 1));

// 凍結: 評価で使うページの本文のハッシュ（評価データの整合性が崩れたら評価を止める）
const sha = (s) => createHash("sha256").update(s).digest("hex");
const hashes = {};
for (const g of gold) {
  const p = real.get(g.url) ?? live1.find((x) => x.url === g.url) ?? live2.find((x) => x.url === g.url);
  hashes[g.url] = sha(`${p.title}\n${p.text}`);
}
writeFileSync("eval/investigation-9e/frozen-hashes.json", JSON.stringify({ version: 1, frozenAt: new Date().toISOString(), hashes }, null, 1));
console.log(`gold ${gold.length}件（real ${gold.filter((g) => g.set === "real").length} / live1 ${live1.length} / live2 ${live2.length}）。凍結ハッシュ ${Object.keys(hashes).length}件`);
