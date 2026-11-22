// 151図鑑のポケモン公式絵を、配信用の小さなWebP（192px）に変換して private-assets/zukan/NNN.webp に置く。
//   node scripts/build-zukan-images.mjs "<公式絵PNGのフォルダ>"
// ファイル名は `【公式絵No.0001】フシギダネ.png`。同番号に括弧付きの派生形（（キョダイマックスのすがた）等）やメガ等の別名ファイルがある場合は、
// **番号と日本語名が完全一致する通常版だけ**を使い、派生形は無視する。見つからない番号は作らない（画面はプレースホルダーを出す）。
// 画像は配信ルート /api/zukan-image/[no]（ログイン必須）からだけ配信し、公開フォルダには置かない。
import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";

const require = createRequire(import.meta.url);
const sharp = require("sharp");
const NAMES = (await import("node:fs")).readFileSync("src/lib/zukan/pokemon151.ts", "utf8").match(/"[^"]+"/g)?.map((s) => s.slice(1, -1)) ?? [];
const src = process.argv[2];
if (!src || !existsSync(src)) {
  console.error('使い方: node scripts/build-zukan-images.mjs "<フォルダ>"');
  process.exit(2);
}
const out = "private-assets/zukan";
mkdirSync(out, { recursive: true });
const files = new Set(readdirSync(src));
const missing = [];
let bytes = 0;
for (let no = 1; no <= 151; no++) {
  const name = NAMES[no - 1];
  const file = `【公式絵No.${String(no).padStart(4, "0")}】${name}.png`;
  if (!files.has(file)) {
    missing.push(no);
    continue;
  }
  const buf = await sharp(join(src, file)).resize(192, 192, { fit: "inside", withoutEnlargement: true }).webp({ quality: 82 }).toBuffer();
  writeFileSync(join(out, `${String(no).padStart(3, "0")}.webp`), buf);
  bytes += buf.length;
}
console.log(JSON.stringify({ names: NAMES.length, written: 151 - missing.length, missing, totalKB: Math.round(bytes / 1024) }));
