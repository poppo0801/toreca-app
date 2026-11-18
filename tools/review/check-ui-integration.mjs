// 評価画面の「統合の根拠」表示の動作確認（Stage 9H-3F。Playwright。ローカルHTMLを file:// で開く。通信なし）。
//   node tools/review/check-ui-integration.mjs <事例集.json>   例: backups/eval-9h3e/review-set-9h3e.json
import { chromium } from "playwright";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { mkdirSync } from "node:fs";

const setPath = resolve(process.argv[2] ?? "backups/eval-9h3e/review-set-9h3e.json");
const html = pathToFileURL(resolve("tools/review/index.html")).href;
mkdirSync("test-results", { recursive: true });
const fails = [];
const check = (ok, msg) => { console.log(`${ok ? "OK  " : "NG  "}${msg}`); if (!ok) fails.push(msg); };
let browser;
try { browser = await chromium.launch(); } catch { browser = await chromium.launch({ channel: "msedge" }); }
const page = await (await browser.newContext({ viewport: { width: 390, height: 900 } })).newPage();
const errors = [];
const reqs = [];
page.on("pageerror", (e) => errors.push(String(e)));
page.on("request", (r) => { if (!r.url().startsWith("file:") && !r.url().startsWith("data:")) reqs.push(r.url()); });
await page.goto(html);
await page.setInputFiles("#fileSet2", setPath);
const txt = async () => page.textContent("body");
await page.waitForTimeout(500);
let t = await txt();
console.log("AI欄:", (await page.textContent("#ai")).slice(0, 120).replace(/s+/g, " "));
check(t.includes("統合の根拠"), "「統合の根拠」の見出しが表示される");
for (const w of ["統合に使用した情報源", "採用した情報と採用理由", "採用しなかった情報と理由", "未確認・矛盾が残る項目", "重複・店舗選択式の判断"]) check(t.includes(w), `「${w}」が表示される`);
const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1);
check(!overflow, "390px幅で横スクロールが出ない");
await page.screenshot({ path: "test-results/review-integration-390.png", fullPage: false });
check(errors.length === 0, `ページのエラーなし ${errors.slice(0, 1).join("")}`);
check(reqs.length === 0, `外部への通信なし ${reqs.slice(0, 1).join("")}`);
await browser.close();
if (fails.length) { console.log(`失敗 ${fails.length}件`); process.exit(1); }
console.log("すべて合格");
