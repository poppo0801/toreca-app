// iPhone のホーム画面アプリ用「起動画面」(apple-touch-startup-image) の書き出し。
// iOS は起動してから最初のHTMLが届くまで（サーバーの起動待ち・通信を含む数秒）、起動画面を表示する。これが無いと黒（または白）の画面になる。
// アプリのロード画面と同じ見た目（背景=テーマの背景色、中央にロゴ）の画像を、機種ごとの画面サイズで作る。ライト/ダークの2種類。
// 原本は public/icons/v2/mark-96.png 系のロゴ（原本を再描画せず、拡大・配置のみ）。出力先は public/startup/。
import { mkdirSync } from "node:fs";
import sharp from "sharp";

const OUT = "public/startup";
mkdirSync(OUT, { recursive: true });

// 機種ごとの画面サイズ: [CSSの幅, CSSの高さ, 密度]。media 条件は src/lib/startup-images.ts と同じ並び
export const DEVICES = [
  [440, 956, 3], // iPhone 16 Pro Max
  [402, 874, 3], // iPhone 16 Pro
  [430, 932, 3], // iPhone 14 Pro Max / 15 Plus / 15 Pro Max / 16 Plus
  [393, 852, 3], // iPhone 14 Pro / 15 / 15 Pro / 16
  [428, 926, 3], // iPhone 12/13 Pro Max / 14 Plus
  [390, 844, 3], // iPhone 12/13/14 (Pro)
  [375, 812, 3], // iPhone X/XS/11 Pro / 12・13 mini
  [414, 896, 3], // iPhone XS Max / 11 Pro Max
  [414, 896, 2], // iPhone XR / 11
  [414, 736, 3], // iPhone 8 Plus
  [375, 667, 2], // iPhone SE (2/3) / 8
];
const SCHEMES = [
  ["light", { r: 244, g: 244, b: 245 }],
  ["dark", { r: 8, g: 8, b: 10 }],
];

const mark = "public/icons/v2/icon-512.png";
let n = 0;
for (const [w, h, ratio] of DEVICES) {
  const W = w * ratio;
  const H = h * ratio;
  // ロゴはロード画面（size-20 = 80px）と同じ大きさ・同じ位置（中央。ロード画面の文字・スピナー分だけ少し上）
  const size = Math.round(80 * ratio);
  const logo = await sharp(mark).resize(size, size, { kernel: "lanczos3" }).composite([{ input: Buffer.from(`<svg width="${size}" height="${size}"><rect width="${size}" height="${size}" rx="${Math.round(size * 0.22)}" fill="#fff"/></svg>`), blend: "dest-in" }]).png().toBuffer();
  for (const [scheme, bg] of SCHEMES) {
    await sharp({ create: { width: W, height: H, channels: 3, background: bg } })
      .composite([{ input: logo, left: Math.round((W - size) / 2), top: Math.round((H - size) / 2 - 24 * ratio) }])
      .png({ compressionLevel: 9, palette: true })
      .toFile(`${OUT}/${W}x${H}-${scheme}.png`);
    n++;
  }
}
console.log(`${n}枚を ${OUT} に出力しました`);
