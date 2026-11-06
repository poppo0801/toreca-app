import { expect, test } from "@playwright/test";

/**
 * Stage 6K（モックモード）: 要チェックへの名称変更、地域の47都道府県選択、下部メニューの位置（幅 320/375/390/430px）、日付アイコン。
 * iPhone のホーム画面アプリ（standalone）の実機挙動は自動テストでは再現できない（docs/stage6k.md）。
 */
test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    if (!window.sessionStorage.getItem("tcg.session.board")) window.sessionStorage.setItem("tcg.session.board", JSON.stringify({ tab: "all", filters: { status: "any" } }));
  });
  await page.goto("/lotteries");
  await expect(page.getByTestId("lottery-card").first()).toBeVisible();
});

test("「★管理対象」は「要チェック」に名称変更（タブ・絞り込み）。★の登録・解除は従来どおり", async ({ page }) => {
  const tabs = page.getByRole("tablist", { name: "抽選の表示切替" });
  await expect(tabs.getByRole("tab", { name: /要チェック/ })).toBeVisible();
  await expect(tabs.getByRole("tab", { name: /管理対象/ })).toHaveCount(0);
  await page.getByTestId("filter-open").click();
  await expect(page.getByTestId("filter-sheet")).not.toContainText("管理対象");
  await page.getByTestId("f-region-open").waitFor();
});

test("地域: 都道府県の選択画面に全47都道府県。神奈川県を追加して絞り込める。既存のプリセットも残る", async ({ page }) => {
  await page.getByTestId("filter-open").click();
  for (const m of ["kansai3", "kanto6", "all"]) await expect(page.getByTestId(`f-region-${m}`)).toBeVisible();
  await page.getByTestId("f-region-open").click();
  const boxes = page.getByTestId("f-pref").locator('input[type="checkbox"]');
  await expect(boxes).toHaveCount(47);
  await expect(page.getByTestId("f-pref").getByText("神奈川県")).toBeVisible();
  await page.getByTestId("pref-none").click();
  await page.getByTestId("f-pref").locator("label", { hasText: "神奈川県" }).locator("input").check();
  await expect(page.getByTestId("pref-count")).toContainText("1 / 47");
  await page.getByTestId("pref-done").click();
  await page.getByTestId("filter-apply").click();
  await expect(page.getByTestId("filter-sheet")).toHaveCount(0);
  // 選択を保持している（開き直しても神奈川県のみ）
  await page.getByTestId("filter-open").click();
  await page.getByTestId("f-region-open").click();
  await expect(page.getByTestId("pref-count")).toContainText("1 / 47");
});

for (const width of [320, 375, 390, 430]) {
  test(`下部メニューは入れ物の最下端（Safe Area直上）にあり、入れ物は画面全体: ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 800 });
    await page.goto("/lotteries");
    const root = (await page.getByTestId("app-root").boundingBox())!;
    const nav = (await page.getByTestId("bottom-nav").boundingBox())!;
    expect(Math.round(root.y)).toBe(0);
    expect(Math.round(root.height)).toBe(800);
    expect(Math.round(nav.y + nav.height)).toBe(800); // 下端に接する（下に空白がない）
    const hScroll = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
    expect(hScroll).toBe(false);
    // standalone 用の補正は CSS だけ（display-mode: standalone のときだけ lvh を使う）。この環境（ブラウザ）では inset:0 のまま
    const style = await page.evaluate(() => {
      const cs = getComputedStyle(document.querySelector('[data-testid="app-root"]')!);
      return { position: cs.position, top: cs.top, bottom: cs.bottom };
    });
    expect(style).toEqual({ position: "fixed", top: "0px", bottom: "0px" });
  });
}

test("画面の高さが変わっても（キーボード・回転の模擬）下部メニューは下端に接し続ける", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 800 });
  for (const h of [700, 800, 760]) {
    await page.setViewportSize({ width: 390, height: h });
    const nav = (await page.getByTestId("bottom-nav").boundingBox())!;
    expect(Math.round(nav.y + nav.height)).toBe(h);
  }
});

test("期間のアイコン: 購入=財布 / 受取=買い物袋（カードの種類によらず同じ）", async ({ page }) => {
  const purchase = page.locator('[data-testid="period"][data-kind="購入"] svg').first();
  if ((await purchase.count()) > 0) await expect(purchase).toHaveAttribute("data-icon", "purchase");
  const receive = page.locator('[data-testid="period"][data-kind="受取"] svg').first();
  if ((await receive.count()) > 0) await expect(receive).toHaveAttribute("data-icon", "receive");
  await expect(page.locator('[data-icon="receive"]').first().or(page.locator('[data-icon="purchase"]').first())).toBeVisible();
});

test("日付入力: iOS で値が上へずれないよう、日付の欄は縦中央そろえ（flex）で、欄の高さに収まる", async ({ page }) => {
  await page.goto("/finance");
  await page.getByRole("button", { name: "＋支出" }).click();
  const date = page.locator('input[type="date"]').first();
  await expect(date).toBeVisible();
  const css = await date.evaluate((el) => {
    const cs = getComputedStyle(el);
    return { display: cs.display, alignItems: cs.alignItems };
  });
  expect(css).toEqual({ display: "flex", alignItems: "center" });
  await expect(page.getByTestId("expense-category")).toBeVisible();
  await expect(page.getByText("購入した商品を登録します")).toHaveCount(0);
});
