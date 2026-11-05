// エフェクトの色再現の検証（一時スクリプト）。静止時・操作時・旧方式の画面を描画し、元画像との平均色の差を測る。
import { chromium } from "@playwright/test";
import { readFileSync, writeFileSync } from "node:fs";
import sharp from "sharp";

const css = readFileSync(process.env.CSS || "src/app/globals.css", "utf8");
const start = css.indexOf(".card-shine {");
const end = css.indexOf("/* Undo通知の進捗バー");
const shineCss = css.slice(start, end);
// 色のある「カード画像」の代わり（赤→青→緑のグラデーションと暗い部分）
const art = `background: linear-gradient(160deg, #c0392b 0%, #e67e22 25%, #2c3e50 50%, #16a085 75%, #8e44ad 100%);`;
const html = (tier, extra = "") => `<!doctype html><meta charset=utf-8><style>${shineCss}
body{margin:0;background:#fff}
.card-shine{display:block;width:200px;height:280px;border:0;padding:0;border-radius:12px;overflow:hidden;${art}}
${extra}</style>
<button class="card-shine" data-tier="${tier}" id="c"></button>`;

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 400, height: 400 }, deviceScaleFactor: 1 });
const shot = async (name) => {
  const buf = await page.locator("#c").screenshot();
  writeFileSync(`.shine-${name}.png`, buf);
  const { data, info } = await sharp(buf).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  return { data, info };
};
const diff = (a, b) => {
  let sum = 0, bright = 0, n = a.info.width * a.info.height;
  for (let i = 0; i < n; i++) {
    for (let c = 0; c < 3; c++) sum += Math.abs(a.data[i * a.info.channels + c] - b.data[i * b.info.channels + c]);
    bright += (b.data[i * 4] + b.data[i * 4 + 1] + b.data[i * 4 + 2]) / 3 - (a.data[i * 4] + a.data[i * 4 + 1] + a.data[i * 4 + 2]) / 3;
  }
  return { meanAbsDiffPerChannel: +(sum / (n * 3)).toFixed(2), meanBrightnessShift: +(bright / n).toFixed(2) };
};
const out = {};
for (const tier of [1, 2, 3]) {
  // 基準: 光沢なし（クラスなし）
  await page.setContent(html(tier).replace('class="card-shine"', 'class="plain"').replace(".card-shine{", ".plain{"));
  await page.addStyleTag({ content: ".plain{display:block;width:200px;height:280px;border:0;padding:0;border-radius:12px;" + art + "}" });
  const base = await shot(`base-t${tier}`);
  await page.setContent(html(tier));
  await page.addStyleTag({ content: "*{animation-play-state:paused!important}" });
  await page.mouse.move(380, 380);
  await page.waitForTimeout(300);
  // 静止時はアニメーションの開始前（1.5s の遅延中）
  const rest = await shot(`rest-t${tier}`);
  const box = await page.locator("#c").boundingBox();
  await page.mouse.move(box.x + box.width * 0.5, box.y + box.height * 0.45);
  await page.waitForTimeout(400);
  const touch = await shot(`touch-t${tier}`);
  out[`tier${tier}`] = { rest: diff(base, rest), touch: diff(base, touch) };
}
console.log(JSON.stringify(out, null, 2));
await browser.close();
