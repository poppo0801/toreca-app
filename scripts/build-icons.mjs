// アプリアイコンの書き出し。原本 public/icons/toremane_icon.jpg（ユーザー提供のデザイン）から、用途別のPNGを作る。
// 原本を再描画・再解釈しない（縮小・拡大・余白の追加のみ）。原本は180×180なので、192/512は拡大になる（高解像度の原本があれば差し替えて再実行）。
// 出力先は public/icons/v2/（旧ファイル名と分け、ブラウザ・PWAのキャッシュに残った旧アイコンを参照しないようにする）。
import { mkdirSync } from "node:fs";
import sharp from "sharp";

const SRC = "public/icons/toremane_icon.jpg";
const OUT = "public/icons/v2";
mkdirSync(OUT, { recursive: true });

// 原本の四隅の色（ほぼ単色の背景）。maskable の余白に使う
const { data, info } = await sharp(SRC).removeAlpha().raw().toBuffer({ resolveWithObject: true });
const corner = [data[0], data[1], data[2]];
const bg = { r: corner[0], g: corner[1], b: corner[2] };

const plain = [
  ["favicon-16.png", 16],
  ["favicon-32.png", 32],
  ["favicon-48.png", 48],
  ["apple-touch-icon.png", 180],
  ["icon-192.png", 192],
  ["icon-512.png", 512],
  ["mark-96.png", 96], // アプリ内のロゴ表示（2倍密度）
];
for (const [file, size] of plain) {
  await sharp(SRC).resize(size, size, { kernel: "lanczos3" }).png({ compressionLevel: 9 }).toFile(`${OUT}/${file}`);
}
// maskable: 端末が丸・角丸に切り抜くので、原本を80%に縮めて中央に置き、周囲は原本の背景色で埋める（安全領域）
const inner = Math.round(512 * 0.8);
const pad = Math.round((512 - inner) / 2);
await sharp(SRC)
  .resize(inner, inner, { kernel: "lanczos3" })
  .extend({ top: pad, bottom: 512 - inner - pad, left: pad, right: 512 - inner - pad, background: bg })
  .png({ compressionLevel: 9 })
  .toFile(`${OUT}/maskable-512.png`);
console.log(`原本 ${info.width}x${info.height} から ${plain.length + 1} 個を ${OUT} に出力（背景色 rgb(${corner.join(",")})）`);
