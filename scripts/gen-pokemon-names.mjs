// 全ポケモン（全国図鑑No.1〜）の日本語名の一覧を、公式絵のファイル名（`【公式絵No.0001】フシギダネ.png`）から作る（名称だけ。画像は含めない）。
//   node scripts/gen-pokemon-names.mjs "<公式絵PNGのフォルダ>"   → src/lib/zukan/pokemon-names.ts
// 番号ごとの名称: 括弧なしの候補のうち最も短いもの（メガ・リージョン等の別名ファイルより基本形）。括弧付きしか無い番号は、括弧より前の部分（例: デオキシス）。
import { readdirSync, writeFileSync } from "node:fs";

const dir = process.argv[2];
if (!dir) {
  console.error('使い方: node scripts/gen-pokemon-names.mjs "<フォルダ>"');
  process.exit(2);
}
const by = new Map();
for (const f of readdirSync(dir)) {
  const m = /^【公式絵No\.(\d{4})】(.+)\.png$/.exec(f);
  if (!m) continue;
  const no = Number(m[1]);
  const list = by.get(no) ?? [];
  list.push(m[2]);
  by.set(no, list);
}
const max = Math.max(...by.keys());
const names = [];
const ambiguous = [];
for (let n = 1; n <= max; n++) {
  const c = by.get(n) ?? [];
  const plain = c.filter((x) => !/[（(]/.test(x)).sort((a, b) => a.length - b.length);
  const name = plain[0] ?? (c[0] ? c[0].replace(/[（(].*$/, "") : "");
  if (!name) throw new Error(`No.${n} の名称が決まりません`);
  if (plain.length > 1) ambiguous.push(n);
  names.push(name);
}
const body = `/**
 * 全ポケモン（全国図鑑No.1〜${max}）の日本語名（添字 = 番号-1）。\`scripts/gen-pokemon-names.mjs\` で公式絵のファイル名から生成した**名称だけ**のデータ（画像は含まない）。
 * 番号→画像の対応（\`official/0001.webp\` 形式）の根拠。カード名からポケモンを特定する照合（pokemon-match.ts）に使う。
 */
export const ALL_POKEMON_NAMES: readonly string[] = ${JSON.stringify(names)};
`;
writeFileSync("src/lib/zukan/pokemon-names.ts", body);
console.log(JSON.stringify({ count: names.length, ambiguousNumbers: ambiguous.length }));
