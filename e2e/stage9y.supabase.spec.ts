import { expect, test, type Page } from "@playwright/test";

/**
 * Stage 9Y の画面確認（実Supabaseのテスト世帯・架空データ）:
 *   E2E_SPEC=stage9y.supabase.spec.ts npm run test:e2e:supabase
 *  - 情報源URL: 横に連続・1行に省略→「ほかN件」で展開・重複なし（390px と PC）
 *  - AIで情報を補完: 画像・文書・URLの3つの入力方法。不要な説明文は出さない
 *  - 当選発表: 終了日だけ入力でき、開始日の入力を要求しない
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

const URLS = [
  "https://x.com/example_store/status/1111111111111111111",
  "https://www.example-card-shop.co.jp/lottery/2026/pokemon-new-set",
  "https://livepocket.jp/e/abcdef",
  "https://news.example.org/article/1",
  "https://blog.example.net/post/2",
  "https://x.com/example_store/status/1111111111111111111", // 重複（表示しない）
];

for (const vp of [
  { name: "390", width: 390, height: 844 },
  { name: "desktop", width: 1280, height: 900 },
]) {
  test(`情報源URL: 横に連続・1行に省略→「ほかN件」で展開・重複なし（${vp.name}）`, async ({ page }) => {
    await page.setViewportSize({ width: vp.width, height: vp.height });
    await login(page);
    await page.getByRole("button", { name: "＋登録" }).click();
    const dialog = page.getByRole("dialog").first();
    await dialog.getByTestId("source-urls-input").fill(URLS.join("\n"));

    const list = dialog.getByTestId("form-source-links");
    await expect(list).toBeVisible();
    const links = list.getByTestId("primary-link");
    await expect(links).toHaveCount(5); // 重複は1つにまとまる
    // 1回の評価で同時に測る（スクロール中の位置ずれを避ける）
    const dy = await list.evaluate((ul) => { const a = ul.children[0].getBoundingClientRect(), b = ul.children[1].getBoundingClientRect(); return Math.abs(a.top - b.top); });
    expect(dy, "先頭の2件が同じ行にない（縦に並んでいる）").toBeLessThan(4);
    expect(await links.first().getAttribute("target")).toBe("_blank");
    expect(await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1)).toBe(false);

    const toggle = dialog.getByTestId("form-source-links-toggle");
    if (await toggle.count()) {
      await expect(list).toHaveAttribute("data-expanded", "false");
      expect((await list.boundingBox())!.height, "折りたたみ時は1行").toBeLessThan(40);
      await expect(toggle).toHaveText(/^ほか\d+件$/);
      await list.locator("..").screenshot({ path: `test-results/9y-links-collapsed-${vp.name}.png` });
      await toggle.click();
      await expect(list).toHaveAttribute("data-expanded", "true");
      expect((await list.boundingBox())!.height).toBeGreaterThan(30);
      await list.locator("..").screenshot({ path: `test-results/9y-links-expanded-${vp.name}.png` });
      await toggle.click();
      await expect(list).toHaveAttribute("data-expanded", "false");
    } else {
      await list.locator("..").screenshot({ path: `test-results/9y-links-all-${vp.name}.png` });
    }
  });
}

test("当選発表: 終了日だけ入力でき、開始日の入力を要求しない（390px）", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await login(page);
  await page.getByRole("button", { name: "＋登録" }).click();
  const dialog = page.getByRole("dialog").first();
  await dialog.getByLabel("期間で指定").check();
  await expect(dialog.getByText("開始日も入力してください")).toHaveCount(0);
  await expect(dialog.getByText("当選発表の終了日").first()).toBeVisible();
  await dialog.screenshot({ path: "test-results/9y-result-end-390.png" });
});
