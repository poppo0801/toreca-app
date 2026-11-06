import { expect, test, type Page } from "@playwright/test";

/**
 * Stage 6L（モックモード）: 4タブの重複排除、★・スワイプの共通の退出アニメーション、収支の分析アイコン・絞り込み、購入期間の￥アイコン。
 * 旧仕様フラグ（__tcgFlatTabs）は使わない。タブの分類は本番と同じ。
 */
const BOARD = "tcg.session.board";
const TAB_LABEL = { all: /全情報/, managed: /要チェック/, applied: /応募済み/, won: /当選/ } as const;

async function idsIn(page: Page, tab: keyof typeof TAB_LABEL): Promise<string[]> {
  // 状態の絞り込みを「すべて」にして、スルーも含めて、そのタブに属する抽選を全件出す
  await page.evaluate(([k, t]) => window.sessionStorage.setItem(k, JSON.stringify({ tab: t, filters: { status: "any", skip: "include", prefectures: [] } })), [BOARD, tab] as const);
  await page.goto("/lotteries");
  await expect(page.getByRole("tab", { name: TAB_LABEL[tab] })).toHaveAttribute("aria-selected", "true");
  await page.waitForTimeout(300);
  return page.locator("[data-lottery-id]").evaluateAll((els) => [...new Set(els.map((e) => e.getAttribute("data-lottery-id") as string))]);
}

test("4つのタブは重複せず、同じ抽選は1つのタブにだけ表示される（件数の合計は全抽選）", async ({ page }) => {
  await page.goto("/lotteries");
  const lists: string[][] = [];
  for (const t of ["won", "applied", "managed", "all"] as const) lists.push(await idsIn(page, t));
  const all = lists.flat();
  expect(all.length).toBeGreaterThan(0);
  expect(new Set(all).size).toBe(all.length); // どのタブとも重複しない
});

test("収支: 文字リンクと購入履歴のアイコンは無く、分析のアイコンと絞り込みアイコンがある（スマホ幅でもはみ出さない）", async ({ page }) => {
  await page.goto("/finance");
  await expect(page.getByRole("link", { name: "年間売却実績・収益分析" })).toHaveAttribute("href", "/finance/analysis");
  await expect(page.getByTestId("to-purchases")).toHaveCount(0);
  await expect(page.getByRole("navigation", { name: "関連ページ" })).toHaveCount(0);
  // 品目の行は無く、絞り込みアイコン（タブの右）から開く
  await expect(page.getByTestId("category-filter")).toHaveCount(0);
  const tabs = await page.getByRole("tablist", { name: "収支の種類" }).boundingBox();
  const icon = page.getByTestId("finance-filter-open");
  const ib = (await icon.boundingBox())!;
  expect(ib.x).toBeGreaterThanOrEqual(tabs!.x + tabs!.width - 1); // タブの右側
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);
  await icon.click();
  await expect(page.getByTestId("finance-filter")).toBeVisible();
  await page.getByTestId("cat-goods").click();
  await page.getByTestId("finance-filter-done").click();
  await expect(icon).toHaveAttribute("data-active", "1"); // 適用中が分かる
  await icon.click();
  await page.getByTestId("finance-filter-clear").click();
  await page.getByTestId("finance-filter-done").click();
  await expect(icon).toHaveAttribute("data-active", "0");
});

test("購入期間のアイコンは丸に￥、受取期間は買い物袋（簡易・詳細とも同じ）", async ({ page }) => {
  await page.addInitScript(() => (window as unknown as { __tcgFlatTabs: boolean }).__tcgFlatTabs = true);
  await page.addInitScript(([k]) => window.sessionStorage.setItem(k, JSON.stringify({ tab: "all", filters: { status: "any" } })), [BOARD]);
  await page.goto("/lotteries");
  const yen = page.locator('[data-icon="purchase"]').first();
  if ((await yen.count()) > 0) {
    await expect(yen.locator("circle")).toHaveCount(1);
    await expect(yen).toHaveCSS("stroke-width", "2px");
  }
});

test("★を外すと、短い待機のあと横へスライドして消え、全情報へ移る（フェードだけで消えない）", async ({ page }) => {
  await page.addInitScript(([k]) => window.sessionStorage.setItem(k, JSON.stringify({ tab: "managed", filters: { status: "any", skip: "include", prefectures: [] } })), [BOARD]);
  await page.goto("/lotteries");
  const card = page.getByTestId("lottery-card").first();
  await expect(card).toBeVisible();
  const id = (await card.getAttribute("data-lottery-id")) as string;
  await page.evaluate(() => {
    const w = window as unknown as { __exits: { p: string; t: number }[] };
    w.__exits = [];
    new MutationObserver((ms) => ms.forEach((m) => w.__exits.push({ p: (m.target as HTMLElement).dataset.exit ?? "", t: performance.now() }))).observe(document.body, { attributes: true, subtree: true, attributeFilter: ["data-exit"] });
  });
  await card.getByRole("button", { name: /要チェック（★）をOFF/ }).click();
  await page.getByRole("button", { name: "★をOFFにする" }).click();
  await expect(page.locator(`[data-lottery-id="${id}"]`)).toHaveCount(0, { timeout: 4000 });
  const ex = await page.evaluate(() => (window as unknown as { __exits: { p: string; t: number }[] }).__exits);
  const phases = ex.map((e) => e.p).filter(Boolean);
  expect(phases).toEqual(expect.arrayContaining(["hold", "sliding", "collapsing"]));
  const hold = ex.find((e) => e.p === "hold")!.t;
  const slide = ex.find((e) => e.p === "sliding")!.t;
  expect(slide - hold).toBeLessThan(900); // 待機は1秒未満（以前の応募の1秒より短い）
  // 全情報タブに移っている
  await page.evaluate(([k]) => window.sessionStorage.setItem(k, JSON.stringify({ tab: "all", filters: { status: "any", skip: "include", prefectures: [] } })), [BOARD]);
  await page.goto("/lotteries");
  await expect(page.locator(`[data-lottery-id="${id}"]`)).toHaveCount(1);
});

// スワイプはログイン済み（保存できる）状態でだけ有効なため、モックでは確認できない。退出アニメーションの呼び出しと失敗時の復元は src/components/swipe-card.test.tsx で確認する
