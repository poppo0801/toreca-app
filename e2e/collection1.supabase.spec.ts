import { expect, test, type Page } from "@playwright/test";

/**
 * Stage Collection-1 の画面確認（実Supabaseのテスト世帯・架空データ・390px）。
 *   E2E_SPEC=collection1.supabase.spec.ts npm run test:e2e:supabase
 *  - 151図鑑: 一覧・カード登録（パック開封／単品購入0円）・集計・価格調査・「この価格で購入」（二重購入の防止）
 *  - 相場調査メモ: カードと価格の登録・比較・購入・購入済みの非表示
 *  - ナビゲーション: メニュー画面に両機能が出る
 */
const email = process.env.E2E_EMAIL!;
const password = process.env.E2E_PASSWORD!;

async function login(page: Page) {
  await page.goto("/login");
  await page.getByLabel("メールアドレス").fill(email);
  await page.getByLabel("パスワード").fill(password);
  await page.getByRole("button", { name: "ログイン" }).click();
  await expect(page).toHaveURL(/\/lotteries$/);
}
const noOverflow = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1);

test("151図鑑: 登録・集計・価格調査・購入（二重購入なし）", async ({ page }) => {
  test.setTimeout(120_000);
  await page.setViewportSize({ width: 390, height: 844 });
  await login(page);
  await page.goto("/zukan");
  await expect(page.getByTestId("zukan-item")).toHaveCount(151);
  await expect(page.getByTestId("zukan-count")).toHaveText("0 / 151");
  expect(await noOverflow(page)).toBe(true);
  await page.screenshot({ path: "test-results/c1-zukan-390.png" });

  // ピカチュウ（パック開封）と、ピカチュウの別カード（単品購入0円）。収集済みは1匹と数える
  await page.locator('[data-testid="zukan-item"][data-no="25"]').click();
  await page.getByTestId("card-add").click();
  await page.getByTestId("card-name").fill("ピカチュウ（テスト）");
  await page.getByTestId("card-submit").click();
  await expect(page.getByTestId("zukan-card")).toHaveCount(1);
  await expect(page.getByTestId("zukan-card-meta").first()).toContainText("パック開封");
  await page.getByTestId("card-add").click();
  await page.getByTestId("card-name").fill("ピカチュウV");
  await page.getByTestId("card-amount").fill("0");
  await page.getByTestId("card-submit").click();
  await expect(page.getByTestId("zukan-card")).toHaveCount(2);
  await expect(page.getByTestId("zukan-card-meta").nth(1)).toContainText("単品購入 0円/枚");

  // 価格調査 → この価格で購入（単品購入として登録され、金額の合計に加わる。二重購入はできない）
  await page.getByTestId("price-add").click();
  await page.getByTestId("price-chain").fill("テスト系列");
  await page.getByTestId("price-store").fill("テスト店");
  await page.getByTestId("price-yen").fill("1500"); // 状態は A が初期選択
  await page.screenshot({ path: "test-results/c1-price-form-390.png" });
  await page.getByTestId("price-submit").click();
  await expect(page.getByTestId("price-row")).toHaveCount(1);
  await expect(page.getByTestId("price-buy")).toHaveCount(0); // 一覧には購入・編集・削除が無い
  await page.getByTestId("price-row").click(); // 価格ブロックをタップ → 詳細
  await expect(page.getByTestId("price-detail")).toBeVisible();
  await page.screenshot({ path: "test-results/c1-price-detail-390.png" });
  await page.getByTestId("price-buy").click();
  await page.getByTestId("buy-ok").click();
  await expect(page.getByTestId("zukan-card")).toHaveCount(3);
  await expect(page.getByTestId("price-row")).toHaveCount(1); // 購入後も価格の記録は残る
  await expect(page.getByTestId("price-row")).toHaveAttribute("data-bought", "true");
  await page.getByTestId("price-row").click();
  await expect(page.getByTestId("price-buy")).toHaveText("購入済み");
  await expect(page.getByTestId("price-buy")).toBeDisabled();
  await page.keyboard.press("Escape");
  expect(await noOverflow(page)).toBe(true);
  await page.screenshot({ path: "test-results/c1-zukan-detail-390.png" });
  await page.keyboard.press("Escape");

  await page.getByTestId("zukan-summary-toggle").click();
  await expect(page.getByTestId("zukan-count")).toHaveText("1 / 151");
  await expect(page.getByTestId("zukan-cards")).toHaveText("3枚");
  await expect(page.getByTestId("zukan-total")).toHaveText("1,500円"); // パック開封と0円を除き、購入した1500円
  // リロードしても残る（保存されている）
  await page.reload();
  await expect(page.getByTestId("zukan-count")).toHaveText("1 / 151");
});

test("相場調査メモ: 登録・比較・購入・購入済みの非表示。メニューに両機能が出る", async ({ page }) => {
  test.setTimeout(120_000);
  await page.setViewportSize({ width: 390, height: 844 });
  await login(page);
  await page.goto("/market-memo");
  await page.getByTestId("market-add").click();
  await page.getByTestId("market-card-name").fill("テストカードex");
  await page.getByTestId("market-card-set").fill("テスト弾");
  await page.getByTestId("market-card-number").fill("001/100");
  await page.getByTestId("price-chain").fill("系列A");
  await page.getByTestId("price-store").fill("店A");
  await page.getByTestId("price-rank").getByRole("radio", { name: "B", exact: true }).click();
  await page.getByTestId("price-yen").fill("800");
  await page.getByTestId("price-submit").click();
  await expect(page.getByTestId("market-card")).toHaveCount(1);
  // 同じカード（セット・番号・レアリティが同じ）の別店舗の価格は、同じカードに追加される（カードが増えない）
  await page.getByTestId("market-add").click();
  await page.getByTestId("market-card-name").fill("テストカードex");
  await page.getByTestId("market-card-set").fill("テスト弾");
  await page.getByTestId("market-card-number").fill("001/100");
  await page.getByTestId("price-chain").fill("系列B");
  await page.getByTestId("price-store").fill("店B");
  await page.getByTestId("price-rank").getByRole("radio", { name: "A+", exact: true }).click();
  await page.getByTestId("price-yen").fill("1500");
  await page.getByTestId("price-submit").click();
  await expect(page.getByTestId("market-card")).toHaveCount(1);
  await page.getByTestId("market-card-open").click();
  await expect(page.getByTestId("price-row")).toHaveCount(2);
  expect(await page.getByTestId("price-rank-label").allTextContents()).toEqual(["A+", "B"]); // 状態優先
  expect(await noOverflow(page)).toBe(true);
  await page.screenshot({ path: "test-results/c1-market-390.png" });
  // 購入 → 購入済み（一覧から非表示・履歴は残る・二重購入不可）
  await page.getByTestId("price-row").first().click(); // 詳細から購入
  await page.getByTestId("price-buy").click();
  await page.getByTestId("buy-ok").click();
  await expect(page.getByTestId("price-row").first()).toHaveAttribute("data-bought", "true");
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("market-card")).toHaveCount(0);
  await page.getByTestId("market-show-bought").check();
  await expect(page.getByTestId("market-card")).toHaveCount(1);

  // メニュー画面に両機能
  await page.goto("/lotteries");
  await page.getByTestId("nav-more").click();
  const grid = page.getByTestId("nav-grid");
  await expect(grid.getByRole("link", { name: "151図鑑" })).toBeVisible();
  await expect(grid.getByRole("link", { name: "相場調査メモ" })).toBeVisible();
});
