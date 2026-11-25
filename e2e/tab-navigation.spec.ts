import { expect, test } from "@playwright/test";

/** 「要チェック」から他のタブへ移れること（遷移障害の再現確認）。既定の分類（タブが重ならない通常画面）で、全タブを往復する */
test("要チェックから他の全タブへ移動でき、往復しても選択が正しく切り替わる（コンソールエラーなし）", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto("/lotteries");
  const tab = (name: RegExp) => page.getByRole("tab", { name });
  await expect(tab(/要チェック/)).toHaveAttribute("aria-selected", "true");
  for (const name of [/応募済み/, /当選/, /全情報/, /要チェック/, /全情報/, /応募済み/, /要チェック/]) {
    await tab(name).click();
    await expect(tab(name)).toHaveAttribute("aria-selected", "true");
    await expect(page.getByTestId("board-content")).toBeVisible();
  }
  expect(errors, errors.join("\n")).toEqual([]);
});
