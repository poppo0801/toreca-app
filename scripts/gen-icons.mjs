// PWAアイコン生成（一度だけ実行してコミットする）。Playwright(chromium)でSVGをPNGに描画する。
import { chromium } from "@playwright/test";
import { mkdirSync } from "node:fs";

const svg = (size, padding) => `
<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 512 512">
  <rect width="512" height="512" fill="#0b0b0b"/>
  <g transform="translate(${padding} ${padding}) scale(${(512 - padding * 2) / 512})">
    <rect x="96" y="136" width="320" height="240" rx="36" fill="none" stroke="#f2f2f2" stroke-width="22"/>
    <circle cx="96" cy="256" r="34" fill="#0b0b0b"/><circle cx="416" cy="256" r="34" fill="#0b0b0b"/>
    <polygon points="256,176 280,236 344,240 294,282 311,344 256,310 201,344 218,282 168,240 232,236" fill="#fb923c"/>
  </g>
</svg>`;

const targets = [
  { file: "public/icons/icon-192.png", size: 192, padding: 0 },
  { file: "public/icons/icon-512.png", size: 512, padding: 0 },
  { file: "public/icons/maskable-512.png", size: 512, padding: 64 }, // セーフゾーン確保
  { file: "public/icons/apple-touch-icon.png", size: 180, padding: 0 },
];

mkdirSync("public/icons", { recursive: true });
const browser = await chromium.launch();
for (const t of targets) {
  const page = await browser.newPage({ viewport: { width: t.size, height: t.size } });
  await page.setContent(`<html><body style="margin:0">${svg(t.size, t.padding)}</body></html>`);
  await page.screenshot({ path: t.file, omitBackground: false });
  await page.close();
}
await browser.close();
console.log("icons generated");
