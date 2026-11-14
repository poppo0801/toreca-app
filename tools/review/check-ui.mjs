// 正誤チェックツールの動作確認（Playwright。ローカルHTMLを file:// で開く。通信なし）。  node tools/review/check-ui.mjs
import { chromium } from "playwright";
import { readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const html = pathToFileURL(resolve("tools/review/index.html")).href;
const samplePath = resolve("tools/review/sample/sample-set.json");
const sample = JSON.parse(readFileSync(samplePath, "utf8"));
mkdirSync("test-results", { recursive: true });
const fails = [];
const check = (ok, msg) => { console.log(`${ok ? "OK  " : "NG  "}${msg}`); if (!ok) fails.push(msg); };

let browser;
try { browser = await chromium.launch(); } catch { browser = await chromium.launch({ channel: "msedge" }); }
const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 }, acceptDownloads: true });
const page = await ctx.newPage();
const dialogs = [];
const errors = [];
page.on("dialog", (d) => { dialogs.push(d.message()); d.dismiss(); });
page.on("pageerror", (e) => errors.push(String(e)));
const reqs = [];
page.on("request", (r) => { if (!r.url().startsWith("file:") && !r.url().startsWith("data:")) reqs.push(r.url()); });

await page.goto(html);
await page.setInputFiles("#fileSet2", samplePath);
check((await page.textContent("#stats")).includes("評価済み 0 / 5"), "事例集を読み込み、0/5と表示");

// 1件目: 正しい
await page.click(".vbtn.v-correct");
check((await page.textContent("#stats")).includes("評価済み 1 / 5"), "評価で件数が更新");
// 2件目: 特殊文字（注入）の事例を表示して、一部修正（系列を誤り）
await page.click("#next");
check((await page.textContent("#source")).includes("<img src=x onerror=alert(1)>"), "注入文字列は文字として表示される");
check((await page.locator("#source img").count()) === 0, "javascript: の画像URLは表示しない");
check((await page.title()) === "トレマネ 正誤チェック（開発専用）", "スクリプトでタイトルが変わらない");
await page.click(".vbtn.v-partial");
check((await page.textContent("#issues")).includes("誤りの項目を1つ以上"), "一部修正で項目未指定なら警告");
await page.selectOption("#fs-chain", "wrong");
await page.fill("#fv-chain", "正しい系列");
await page.selectOption("#fs-store", "unknown_only");
await page.fill("#comment", "コメント <b>テスト</b>");
check(!(await page.textContent("#issues")).includes("⚠"), "項目を指定すれば警告が消える");

// 3件目: 長文・画像エラー・店舗不明
await page.click("#next");
check((await page.locator(".imgwrap").count()) === 1, "画像の枠を表示");
await page.waitForFunction(() => document.getElementById("source").textContent.includes("画像を表示できませんでした"), null, { timeout: 8000 }).catch(() => {});
check((await page.textContent("#source")).includes("画像を表示できませんでした"), "画像が表示できないときは明示");
await page.click(".vbtn.v-unknown");

// 4件目: 本文なし
await page.click("#next");
check((await page.textContent("#source")).includes("本文は取得できていません"), "本文がない旨を明示");
check((await page.textContent("#ai")).includes("比較対象の登録済み抽選"), "重複の比較対象を表示");
// 5件目: 不正なURL
await page.click("#next");
check((await page.locator("#source a").count()) === 0, "不正なURLはリンクにしない");
check(await page.isDisabled("#next"), "最後の事例で次へは無効");

// 自動保存→再読み込み
await page.reload();
await page.setInputFiles("#fileSet2", samplePath);
check((await page.textContent("#stats")).includes("評価済み 3 / 5"), "再読み込み後も評価を復元");
await page.selectOption("#fVerdict", "partial");
check((await page.textContent("#pos")).startsWith("1 / 1"), "評価で絞り込み");
await page.selectOption("#fVerdict", "all");
await page.check("#fUnev");
check((await page.textContent("#pos")).startsWith("1 / 2"), "未評価だけ（残り2件）");
await page.uncheck("#fUnev");

// 書き出し
const [dl] = await Promise.all([page.waitForEvent("download"), page.click("#export")]);
const outPath = resolve("test-results/review-answers-check.json");
await dl.saveAs(outPath);
const out = JSON.parse(readFileSync(outPath, "utf8"));
check(out.format === "toremane-review-answers" && out.setId === sample.setId && out.results.length === 3, "JSONを書き出し（3件・setId一致）");
const r1 = out.results.find((r) => r.caseId === "c01");
check(JSON.stringify(r1.aiOriginal) === JSON.stringify(sample.cases[0].ai), "AIの元の判定は書き換えない");
check(r1.human.verdict === "correct" && r1.human.usableAsGold === true && r1.evaluationId.startsWith("ev-"), "人間の評価は別に保存・評価ID付き");
const r2 = out.results.find((r) => r.caseId === "c02");
check(r2.human.corrections[0].field === "chain" && r2.human.corrections[0].correctValue === "正しい系列" && r2.human.unknownOnlyFields.includes("store") && r2.human.comment.includes("<b>"), "修正項目・正しい値・不明なだけ・コメントを保存");
const r3 = out.results.find((r) => r.caseId === "c03");
check(r3.human.verdict === "unknown" && r3.human.usableAsGold === false, "「判断できない」は正解データに使わない");
check(!("human" in sample.cases[0]) && !JSON.stringify(sample).includes("usableAsGold"), "入力の事例集に評価は含まれない");

// 保存を消して、書き出したJSONから復元
await page.evaluate(() => localStorage.clear());
await page.reload();
await page.setInputFiles("#fileSet2", samplePath);
check((await page.textContent("#stats")).includes("評価済み 0 / 5"), "保存を消すと0件");
await page.setInputFiles("#fileAns", outPath);
await page.waitForTimeout(300);
check((await page.textContent("#stats")).includes("評価済み 3 / 5"), "書き出したJSONを再読み込みして復元");
// 別の事例集の評価結果は拒否
const other = { ...out, setId: "other-set" };
writeFileSync(resolve("test-results/review-answers-other.json"), JSON.stringify(other));
await page.setInputFiles("#fileAns", resolve("test-results/review-answers-other.json"));
await page.waitForTimeout(200);
check((await page.textContent("#toast")).includes("別の事例集"), "別の事例集の評価結果は取り込まない");

// スマートフォン幅
await page.setViewportSize({ width: 390, height: 844 });
await page.selectOption("#fVerdict", "all");
const over = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
check(over <= 1, `390px幅で横はみ出しなし（差 ${over}px）`);
await page.screenshot({ path: "test-results/9f2-review-390.png", fullPage: false });
await page.setViewportSize({ width: 1280, height: 900 });
await page.screenshot({ path: "test-results/9f2-review-1280.png", fullPage: false });

check(dialogs.length === 0, "スクリプトの実行（alert）は起きない");
check(errors.length === 0, `ページエラーなし ${errors.slice(0, 2).join(" | ")}`);
check(reqs.filter((u) => !u.includes("example.invalid")).length === 0, `外部への通信なし（画像URLのみ）${reqs.join(",")}`);
await browser.close();
console.log(fails.length ? `\n失敗 ${fails.length}件` : "\nすべて合格");
process.exit(fails.length ? 1 : 0);
