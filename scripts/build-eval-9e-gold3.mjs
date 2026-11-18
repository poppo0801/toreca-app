// Stage 9E: ホールドアウト（バッチ3）のページ判定の正解。分類器の調整・バッチ1/2の正解作成のあとに取得した、見ていないページ。
// 正解は、取得したページの本文を作業者が読んで決めた（AI・分類器の出力は使っていない。この正解を作ったあとで分類器に通す）。
//   node scripts/build-eval-9e-gold3.mjs
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";

const pages = JSON.parse(readFileSync("eval/investigation-9e/pages-live-3.json", "utf8")).pages;
const G = {
  "https://www.c-labo.jp/shop/fukuokatenjin/blog/624514/": ["lottery_announcement", "再販抽選販売のお知らせ（応募期間 11/13〜11/15）"],
  "https://www.c-labo.jp/shop/tennouji/blog/624505/": ["lottery_announcement", "各種再販商品の抽選販売のご案内（4商品。応募期間 11/13〜11/15）"],
  "https://www.c-labo.jp/shop/hakatamarui/blog/624493/": ["lottery_announcement", "再販抽選販売のお知らせ（応募期間 11/13〜11/15）"],
  "https://www.c-labo.jp/shop/oita/blog/624460/": ["lottery_announcement", "再販抽選販売のお知らせ（応募期間 11/13〜11/15）"],
  "https://www.c-labo.jp/shop/tennouji/blog/624458/": ["lottery_announcement", "再販抽選販売のお知らせ（応募期間 11/13〜11/15）"],
  "https://www.c-labo.jp/shop/tennouji/blog/624454/": ["lottery_announcement", "抽選予約のご案内（応募期間 11/13〜11/15）"],
  "https://geo-online.co.jp/news/787": ["lottery_announcement", "抽選販売受付のお知らせ（応募期間 11/2〜11/5。日付上は終了済みだが、告知としては抽選の告知）"],
  "https://geo-online.co.jp/news/732": ["lottery_explainer", "『抽選販売』よくあるお問い合わせ（Pontaカード・ログイン等の説明。応募期間なし）"],
  "https://geo-online.co.jp/news/776": ["general", "なりすましアカウントへの注意（抽選の告知ではない）"],
  "https://geo-online.co.jp/news/723": ["general", "Ponta会員ID連携手続き中止のお知らせ（抽選の告知ではない）"],
  "https://www.pokemon-card.com/info/005629.html": [null, "イベント（シティリーグ）の事前抽選エントリー期間の延長。店舗の購入抽選ではなくイベント参加の抽選。登録対象かは利用者の方針による"],
  "https://www.pokemon-card.com/info/005612.html": [null, "イベント（チャンピオンズリーグ）のエントリー期間延長。店舗の購入抽選ではなくイベント参加の抽選。登録対象かは利用者の方針による"],
  "https://www.pokemoncenter-online.com/news/?id=20260929": ["lottery_announcement", "ポケモンセンターオンラインの追加抽選販売の案内（応募枠・応募のSTEPあり。期間の表は本文に出ていない）"],
};
const gold = [];
const hashes = {};
const sha = (s) => createHash("sha256").update(s).digest("hex");
for (const p of pages) {
  if (!G[p.url]) {
    // 本文が空（JavaScriptで表示されるページ）は、判定の対象にならない
    if (p.text.length === 0) continue;
    throw new Error(`正解が未定義: ${p.url}`);
  }
  const [kind, basis] = G[p.url];
  gold.push(kind === null ? { url: p.url, set: "live3", kind: null, actionable: null, ambiguous: true, basis } : { url: p.url, set: "live3", kind, actionable: kind === "lottery_announcement", basis });
  hashes[p.url] = sha(`${p.title}\n${p.text}`);
}
writeFileSync("eval/investigation-9e/gold-pages-3.json", JSON.stringify({ version: 1, note: "ホールドアウト（調整後に取得した見ていないページ）の正解", pages: gold }, null, 1));
writeFileSync("eval/investigation-9e/frozen-hashes-3.json", JSON.stringify({ version: 1, frozenAt: new Date().toISOString(), hashes }, null, 1));
console.log(`gold3 ${gold.length}件`);
