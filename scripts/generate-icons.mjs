// アプリアイコン（PWA・ホーム画面・favicon）の書き出し。ロゴ定義は src/lib/brand-svg.ts（提案ボード案1）。
//   node scripts/generate-icons.mjs
import { mkdirSync, writeFileSync } from "node:fs";
import sharp from "sharp";
import { appIconSvg, logoMarkSvg, LOGO_DARK, LOGO_LIGHT } from "../src/lib/brand-svg.ts";

const out = "public/icons";
mkdirSync(out, { recursive: true });

const targets = [
  { file: "icon-192.png", size: 192, rounded: true, scale: 0.92 },
  { file: "icon-512.png", size: 512, rounded: true, scale: 0.92 },
  // maskable: 端末が丸・角丸に切り抜くので、マークは中央の安全領域(約60%)に収める
  { file: "maskable-512.png", size: 512, rounded: false, scale: 0.7 },
  // iOS は自分で角丸にするので全面塗り
  { file: "apple-touch-icon.png", size: 180, rounded: false, scale: 0.84 },
  { file: "favicon-32.png", size: 32, rounded: true, scale: 1 },
  { file: "favicon-48.png", size: 48, rounded: true, scale: 1 },
];
for (const t of targets) {
  await sharp(Buffer.from(appIconSvg(t)), { density: 384 }).resize(t.size, t.size).png().toFile(`${out}/${t.file}`);
  console.log("書き出し:", `${out}/${t.file}`);
}
writeFileSync(`${out}/logo.svg`, appIconSvg({ size: 512, rounded: true, scale: 0.92 }));
writeFileSync(`${out}/mark-dark.svg`, logoMarkSvg(LOGO_DARK, 128));
writeFileSync(`${out}/mark-light.svg`, logoMarkSvg(LOGO_LIGHT, 128));
console.log("完了");
