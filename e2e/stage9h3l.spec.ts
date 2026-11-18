import { expect, test } from "@playwright/test";

/** Stage 9H-3L: 抽選詳細の一次情報リンク（390px）。上部に出る・横スクロールが出ない・外部リンクとして開く設定になっている */
test("抽選詳細の上部に一次情報リンクが出る（390px・横スクロールなし）", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.addInitScript(() => {
    (window as unknown as { __tcgFlatTabs: boolean }).__tcgFlatTabs = true;
  });
  await page.goto("/lotteries");
  const cards = page.getByTestId("lottery-card");
  await expect(cards.first()).toBeVisible();
  const n = await cards.count();
  let found = false;
  for (let i = 0; i < Math.min(n, 8) && !found; i++) {
    await cards.nth(i).click();
    const detail = page.getByTestId("lottery-detail").last();
    await expect(detail).toBeVisible();
    if ((await detail.getByTestId("primary-links").count()) > 0) {
      found = true;
      const links = detail.getByTestId("primary-link");
      await expect(links.first()).toBeVisible();
      const a = links.first();
      expect(await a.getAttribute("target")).toBe("_blank");
      expect(await a.getAttribute("rel")).toContain("noopener");
      const text = (await a.textContent()) ?? "";
      expect(text).toContain("｜");
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1);
      expect(overflow, "横スクロールが出ている").toBe(false);
      await detail.screenshot({ path: "test-results/9h3l-detail-390.png" });
    } else {
      await page.keyboard.press("Escape");
    }
  }
  expect(found, "一次情報リンクのある抽選が見つからない").toBe(true);
});
