import { expect, test } from "@playwright/test";

/** Stage UI-1: 下部ナビゲーション（390px）。長押しクイックメニュー・全機能メニュー・設定画面の表示確認（画面キャプチャ） */
test("390px: 長押しクイックメニュー・メニュー画面・ナビ設定に横スクロールがなく、操作できる", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.addInitScript(() => {
    (window as unknown as { __tcgFlatTabs: boolean }).__tcgFlatTabs = true;
  });
  await page.goto("/lotteries");
  const noOverflow = () => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1);
  const btn = page.getByTestId("nav-more");
  await expect(btn).toBeVisible();
  const b = (await btn.boundingBox())!;
  await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2);
  await page.mouse.down();
  await page.waitForTimeout(600);
  await expect(page.getByTestId("quick-menu")).toBeVisible();
  const first = page.getByTestId("quick-menu").locator("[data-quick]").first();
  const fb = (await first.boundingBox())!;
  await page.mouse.move(fb.x + fb.width / 2, fb.y + fb.height / 2, { steps: 5 });
  expect(await noOverflow()).toBe(true);
  await page.screenshot({ path: "test-results/ui1-quick-390.png" });
  await page.mouse.move(20, 100, { steps: 4 });
  await page.mouse.up();
  await expect(page.getByTestId("quick-menu")).toHaveCount(0);
  await btn.click();
  await expect(page.getByTestId("nav-grid")).toBeVisible();
  expect(await noOverflow()).toBe(true);
  await page.screenshot({ path: "test-results/ui1-menu-390.png" });
  await page.keyboard.press("Escape");
  await page.goto("/settings/display");
  await expect(page.getByTestId("nav-settings")).toBeVisible();
  expect(await noOverflow()).toBe(true);
  await page.getByTestId("nav-settings").screenshot({ path: "test-results/ui1-navsettings-390.png" });
});
