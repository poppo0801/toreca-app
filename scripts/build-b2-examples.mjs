// 条件B2（AI自律発見）の評価例の生成（ローカル・無課金）。保存済みの実在の公開ページ（Stage 10Tで取得したLivePocket。Git管理外）から、
// 「応募URLを持たない項目の原文」を作る: 原文はページのタイトルから**店舗名と商品の部分**だけを取り出した短い文（URLなし）。独立した正解（gold）= そのページ自身（人が確認できる公開ページ）の店舗。
// 店舗名をタイトルから取り出せるページだけを例にする（取り出せないものは含めない）。**合成の原文**（実在のX投稿ではない）であることを記録に残す。
//   node scripts/build-b2-examples.mjs   → eval/real-data/xsource-10x-b2-examples.json（Git管理外）
import { existsSync, readFileSync, writeFileSync } from "node:fs";

const DIR = "eval/real-data/10t-html";
if (!existsSync(`${DIR}/index.json`)) {
  console.error("保存済みのページがありません");
  process.exit(1);
}
const index = JSON.parse(readFileSync(`${DIR}/index.json`, "utf8")).filter((x) => x.ok);
const text = (h) => h.replace(/<[^>]+>/g, " ").replace(/&[a-z#0-9]+;/gi, " ").replace(/\s+/g, " ").trim();
const examples = [];
for (const x of index) {
  const html = readFileSync(`${DIR}/lp-${x.n}.html`, "utf8");
  const title = text(/<h1[^>]*>([\s\S]*?)<\/h1>/.exec(html)?.[1] ?? "");
  const store = /^【([^】]{2,30}店)】/.exec(title)?.[1] ?? /^([^\s【】]{2,20}店)\s/.exec(title)?.[1] ?? null;
  if (!store) continue;
  const product = title.replace(/^【[^】]+】/, "").replace(new RegExp(`^${store}\s*`), "").slice(0, 60);
  examples.push({ id: `lp-${x.n}`, kind: "synthetic_from_public_page", post: { postId: `lp-${x.n}`, text: `《${store}（所在地は原文に無し）- 1件》 ・${product || "ポケモンカード 抽選"}`, links: [], recordedAt: null }, pages: { [x.url]: html }, gold: [{ itemNo: 1, store, source: "公開ページのタイトル（人が確認できる）" }] });
}
writeFileSync("eval/real-data/xsource-10x-b2-examples.json", JSON.stringify({ note: "合成の原文（実在のX投稿ではない）。正解=ページ自身の店舗。実評価の検索は実際のWeb", examples }, null, 1));
console.log(JSON.stringify({ pages: index.length, examples: examples.length }));
