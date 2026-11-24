import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { expect, test, type Page } from "@playwright/test";

/**
 * 独立gold確認（開発専用）の画面確認（ローカルのSupabase・架空のページ・390pxとPC）。
 *   E2E_SPEC=gold-review.supabase.spec.ts npm run test:e2e:supabase
 * 確認のためのページは e2e/.gold-fixture（Git管理外）に作る架空のもの。保存先は e2e/.gold-review（Git管理外）。実データには触れない。
 */
const email = process.env.E2E_EMAIL!;
const password = process.env.E2E_PASSWORD!;
const PAGES = "e2e/.gold-fixture";
const STATE = "e2e/.gold-review";
const html = (shop: string, product: string, end: string) => `<html><body><h1 class="heading01">【${shop}】${product} 抽選</h1><h2>受付・チケット情報</h2><section class="event-detail-ticket-card"><h4 class="event-detail-ticket-card__title">${product} 1BOX</h4><p class="event-detail-ticket-card__text">応募締切 ：${end}まで。お一人様1回まで。</p></section></body></html>`;

/** モバイル幅で詳細が開いているときは、一覧へ戻る */
async function toList(page: Page) {
  if (await page.getByTestId("gold-back").isVisible().catch(() => false)) await page.getByTestId("gold-back").click();
}

async function login(page: Page) {
  await page.goto("/login");
  await page.getByLabel("メールアドレス").fill(email);
  await page.getByLabel("パスワード").fill(password);
  await page.getByRole("button", { name: "ログイン" }).click();
  await expect(page).toHaveURL(/\/lotteries$/);
}
const noOverflow = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1);

test("独立gold確認: JSON編集なしで、確認・除外・書き出しまで進められる（390px・PC）。一括承認はできない", async ({ page }) => {
  test.setTimeout(180_000);
  rmSync(STATE, { recursive: true, force: true });
  rmSync(PAGES, { recursive: true, force: true });
  mkdirSync(PAGES, { recursive: true });
  writeFileSync(`${PAGES}/lp-1.html`, html("新宿本店", "拡張パック", "11月30日"));
  writeFileSync(`${PAGES}/lp-2.html`, html("渋谷店", "拡張パック", "11月29日"));
  writeFileSync(`${PAGES}/index.json`, JSON.stringify([1, 2].map((n) => ({ n, url: `https://shop${n}.example.invalid/e/${n}`, ok: true, bytes: 1 }))));

  await page.setViewportSize({ width: 390, height: 844 });
  await login(page);
  await page.goto("/dev/gold-review");
  await expect(page.getByTestId("gold-dev-banner")).toBeVisible();
  await expect(page.getByTestId("gold-count-unreviewed")).toHaveText("未確認 2");
  await expect(page.getByTestId("gold-row-1")).toBeVisible();
  expect(await noOverflow(page)).toBe(true);
  await page.screenshot({ path: "test-results/gold-review-list-390.png" });

  // 1ページ目を開く（モバイルは一覧→詳細）。機械抽出の候補は「未確認」と明示される
  await page.getByTestId("gold-row-1").click();
  await expect(page.getByTestId("gold-detail")).toHaveAttribute("data-status", "unreviewed");
  await expect(page.getByTestId("gold-candidate")).toContainText("未確認・正解ではありません");
  await expect(page.getByTestId("gold-open-official")).toHaveAttribute("href", "https://shop1.example.invalid/e/1");
  await expect(page.getByTestId("gold-open-official")).toHaveAttribute("rel", /noopener/);
  await expect(page.getByTestId("gold-version")).toContainText("保存した版");
  expect(await noOverflow(page)).toBe(true);

  // 候補をコピーしても確認にはならない。チェック無しで確認しようとすると、項目ごとの指摘が出て、状態は変わらない
  await page.getByTestId("gold-copy-candidate").click();
  await expect(page.getByTestId("gold-store")).toHaveValue("新宿本店");
  await page.getByTestId("gold-basis").fill("公式ページを目視で確認");
  await page.getByTestId("gold-confirm").click();
  await expect(page.getByTestId("gold-problems")).toContainText("公式ページを開いて確認した");
  await expect(page.getByTestId("gold-problems")).toContainText("項目ごとに確認が必要");
  await expect(page.getByTestId("gold-status")).toHaveText("未確認");

  // 引用がページに無いと拒否される（リアルタイムの表示も）
  await page.getByTestId("gold-quote-0").fill("ページに存在しない引用の文章です");
  await expect(page.getByTestId("gold-quote-state-0")).toHaveAttribute("data-found", "false");
  await page.getByTestId("gold-quote-0").fill("【新宿本店】拡張パック 抽選");
  await expect(page.getByTestId("gold-quote-state-0")).toHaveAttribute("data-found", "true");
  await page.getByTestId("gold-applyEnd").fill("2026-11-30");
  await page.getByTestId("gold-applyEnd-time").fill("23:59");
  await page.screenshot({ path: "test-results/gold-review-detail-390.png", fullPage: true });

  // 項目ごとに確認して確認済みにする
  await page.getByTestId("gold-applyUnit").selectOption("one_form_one");
  for (const k of ["store", "product", "applyEnd", "applyUnit", "quotes"]) await page.getByTestId(`gold-check-${k}`).check();
  await page.getByTestId("gold-official-opened").check();
  await page.getByTestId("gold-save").click();
  await expect(page.getByTestId("gold-message")).toContainText("下書きを保存しました");
  await page.getByTestId("gold-confirm").click();
  await expect(page.getByTestId("gold-count-confirmed")).toHaveText("確認済み 1");
  await expect(page.getByTestId("gold-detail")).toHaveAttribute("data-page", "2"); // 確認のあとは、次の未確認のページが開く
  await toList(page);
  await page.getByTestId("gold-row-1").click();
  await expect(page.getByTestId("gold-status")).toHaveText("確認済み");
  await expect(page.getByTestId("gold-confirmed-info")).toContainText("確認者");
  await page.getByTestId("gold-history-toggle").click();
  await expect(page.getByTestId("gold-history")).toContainText("confirmed");

  // 未確認が残っている間は、R1用のgoldを書き出せない
  await expect(page.getByTestId("gold-write")).toBeDisabled();
  await expect(page.getByTestId("gold-incomplete")).toBeVisible();

  // 2ページ目は複数枠として除外（理由つき）。PC幅では一覧と詳細が並ぶ
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.getByTestId("gold-row-2").click();
  await expect(page.getByTestId("gold-list")).toBeVisible();
  await expect(page.getByTestId("gold-detail")).toBeVisible();
  await page.screenshot({ path: "test-results/gold-review-desktop.png" });
  await page.getByTestId("gold-exclude-reason").selectOption("multi_slot");
  await page.getByTestId("gold-exclude").click();
  await expect(page.getByTestId("gold-count-excluded")).toHaveText("除外 1");

  // 全て確認／除外 → 書き出し（r1-build が読む形式）
  await expect(page.getByTestId("gold-write")).toBeEnabled();
  await page.getByTestId("gold-write").click();
  await expect(page.getByTestId("gold-message")).toContainText("書き出しました");
  expect(existsSync(`${STATE}/r1-gold-pages.local.json`)).toBe(true);
  const gold = JSON.parse(readFileSync(`${STATE}/r1-gold-pages.local.json`, "utf8")) as { n: number; exclude?: boolean; verified: { by: string; basis: string } }[];
  expect(gold.find((g) => g.n === 1)?.verified.by).toBe("human");
  expect(gold.find((g) => g.n === 2)?.exclude).toBe(true);

  // 再確認にすると、書き出しはまた止まる
  await page.getByTestId("gold-row-1").click();
  await page.getByTestId("gold-reopen").click();
  await expect(page.getByTestId("gold-count-unreviewed")).toHaveText("未確認 1");
  await expect(page.getByTestId("gold-write")).toBeDisabled();

  // 390px でも詳細が横にはみ出さない
  await page.setViewportSize({ width: 390, height: 844 });
  await toList(page);
  await page.getByTestId("gold-row-1").click();
  expect(await noOverflow(page)).toBe(true);
  rmSync(STATE, { recursive: true, force: true });
  rmSync(PAGES, { recursive: true, force: true });
});

test("独立gold確認（実投稿のリンク先）: 出所・投稿の該当箇所・年を補わない候補・保留・同じ応募機会の印・案件goldの書き出し（390px）", async ({ page }) => {
  test.setTimeout(180_000);
  rmSync(STATE, { recursive: true, force: true });
  mkdirSync(STATE, { recursive: true });
  const crypto = await import("node:crypto");
  const caseId = `rp${crypto.createHash("sha256").update("post-e2e").digest("hex").slice(0, 8)}`;
  const t = (shop: string, end: string) => `【${shop}】拡張パック 抽選受付 応募締切 ：${end}まで お一人様1回まで。`;
  const cap = (order: number, short: string, url: string, text: string, hash: string) => ({ caseId, order, short, url, finalUrl: url, hops: 0, fetchedAt: "2026-11-24T00:00:00.000Z", status: 200, title: "", chars: text.length, textHash: hash, truncated: false, text, sameContentAs: null });
  const pagesJson = [cap(0, "https://t.co/a", "https://shop-a.example.invalid/e/1", t("新宿本店", "11月30日（月）23:59"), "a".repeat(16)), cap(1, "https://t.co/b", "https://shop-b.example.invalid/e/2", t("渋谷店", "2026年12月1日（火）"), "b".repeat(16))];
  writeFileSync(`${STATE}/real-pages.local.json`, JSON.stringify(pagesJson));
  writeFileSync(`${STATE}/real-post-candidates.local.json`, JSON.stringify([{ id: "post-e2e", postUrl: "https://x.com/official/status/1234567890123", text: "《新宿本店》 抽選 https://t.co/a 《渋谷店》 抽選 https://t.co/b", capturedAt: "x" }]));
  writeFileSync(`${STATE}/cases.real.local.json`, JSON.stringify([{ caseId, pages: pagesJson.map((p) => ({ url: p.url })) }]));

  await page.setViewportSize({ width: 390, height: 844 });
  await login(page);
  await page.goto("/dev/gold-review?set=real");
  await expect(page.getByTestId("gold-review")).toHaveAttribute("data-set", "real");
  await expect(page.getByTestId("gold-group")).toContainText("投稿 1（2ページ）");
  await expect(page.getByTestId("gold-count-unreviewed")).toHaveText("未確認 2");
  expect(await noOverflow(page)).toBe(true);
  await page.locator('[data-testid^="gold-row-"]').first().click();
  await expect(page.getByTestId("gold-source")).toContainText("https://t.co/a");
  await expect(page.getByTestId("gold-source")).toContainText("公式かどうかは自動では判断していません");
  await expect(page.getByTestId("gold-post-context")).toContainText("https://t.co/a");
  await expect(page.getByTestId("gold-candidate-end")).toContainText("年は書かれていません"); // 年を補わない
  await page.getByTestId("gold-copy-candidate").click();
  await expect(page.getByTestId("gold-applyEnd")).toHaveValue(""); // 年が無い締切は入力欄に入らない
  await page.getByTestId("gold-jump-candidate").click();
  await expect(page.getByTestId("gold-search")).not.toHaveValue("");
  await page.screenshot({ path: "test-results/gold-review-real-390.png", fullPage: true });

  // 公式ページを開けない → 保留（確認済みにならない）
  await page.getByTestId("gold-hold").click();
  await expect(page.getByTestId("gold-count-needs_recheck")).toHaveText("要再確認 1");
  // 保留のあとは、次の未確認のページ（2ページ目）が自動で開く
  await expect(page.getByTestId("gold-detail")).toBeVisible();
  await expect(page.getByTestId("gold-source")).toContainText("https://t.co/b");
  await expect(page.getByTestId("gold-candidate-end")).toContainText("2026年と書かれています"); // 年が書かれている候補は、年を示す
  expect(await noOverflow(page)).toBe(true);
  rmSync(STATE, { recursive: true, force: true });
});
