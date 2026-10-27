import { expect, test, type Page } from "@playwright/test";

test.beforeEach(async ({ page }) => {
  await page.goto("/lotteries");
  await expect(page.getByTestId("lottery-card").first()).toBeVisible();
});

async function switchProfile(page: Page, label: string) {
  await page.getByRole("button", { name: /ユーザー切り替え/ }).click();
  await page.getByRole("radio", { name: `プロフィール ${label}` }).click();
}

test("★OFFは確認ダイアログを挟み、キャンセルでは状態が変わらない", async ({ page }) => {
  const tab = page.getByRole("tab", { name: /★管理対象/ });
  const before = await tab.innerText();
  const card = page.locator('[data-lottery-id="L1"]');
  await card.getByRole("button", { name: /管理対象（★）をOFF/ }).click();
  await expect(page.getByRole("dialog")).toContainText("履歴は消えません");
  await page.getByRole("button", { name: "キャンセル" }).click();
  await expect(card).toBeVisible();
  expect(await tab.innerText()).toBe(before);

  await card.getByRole("button", { name: /管理対象（★）をOFF/ }).click();
  await page.getByRole("button", { name: "★をOFFにする" }).click();
  await expect(card).toHaveCount(0);
  // 全情報には残り、★に戻せる
  await page.getByRole("tab", { name: /全情報/ }).click();
  await expect(page.locator('[data-lottery-id="L1"]')).toBeVisible();
});

test("ヘッダーは現在のユーザーだけを表示し、タップで切り替え。選択は端末に保存される", async ({ page }) => {
  const header = page.locator("header");
  await expect(header).not.toContainText("操作中");
  await expect(header.getByTestId("current-profile")).toHaveText("A");
  // 丸アイコンが横並びになっていない（切り替え用のラジオはダイアログを開くまで存在しない）
  await expect(page.getByRole("radio", { name: /プロフィール/ })).toHaveCount(0);

  await switchProfile(page, "B");
  await expect(header.getByTestId("current-profile")).toHaveText("B");
  await page.reload();
  await expect(page.locator("header").getByTestId("current-profile")).toHaveText("B");
});

test("見出しと登録ボタンは1行。説明文は無く、タブは 全情報→★管理対象→応募済み→当選 の順で初期は★管理対象", async ({ page }) => {
  await expect(page.getByText("家族共通の抽選情報です。")).toHaveCount(0);
  const tabs = page.getByRole("tab");
  const names = (await tabs.allInnerTexts()).map((t) => t.replace(/\s*\d+\s*$/, "").trim());
  expect(names).toEqual(["全情報", "★管理対象", "応募済み", "当選"]);
  await expect(page.getByRole("tab", { name: /★管理対象/ })).toHaveAttribute("aria-selected", "true");
  // モックでは登録ボタンの代わりにデモ表示。見出しと同じ行にある
  const h1 = page.getByRole("heading", { name: "抽選管理" });
  const note = page.getByText("デモデータ（保存されません）");
  const [a, b] = [await h1.boundingBox(), await note.boundingBox()];
  expect(Math.abs((a!.y + a!.height / 2) - (b!.y + b!.height / 2))).toBeLessThan(12);
});

test("検索は1行、主要フィルターは横1行。縦幅が大きく広がらない", async ({ page }) => {
  const search = page.getByRole("searchbox");
  const filters = page.getByRole("group", { name: "主要フィルター" });
  const s = (await search.boundingBox())!;
  const f = (await filters.boundingBox())!;
  expect(s.height).toBeLessThan(48);
  expect(f.height).toBeLessThan(48);
  // 検索欄＋主要フィルター＋タブ＋見出しの合計が画面高の半分に収まる
  const firstCard = (await page.getByTestId("lottery-card").first().boundingBox())!;
  const vp = page.viewportSize()!;
  expect(firstCard.y).toBeLessThan(vp.height * 0.45);
  // 詳細フィルターは展開式
  await expect(page.getByRole("group", { name: "詳細フィルター" })).toHaveCount(0);
  await page.getByRole("button", { name: "詳細フィルターを開く" }).click();
  await expect(page.getByRole("group", { name: "詳細フィルター" })).toBeVisible();
});

test("スルー表示フィルター: 通常は自分のスルーを除き、含む/のみで切り替えられる。他のユーザーには影響しない", async ({ page }) => {
  // Aは s5(ダミー書店) をスルー中（モック）。L10 などは★管理外のため、★対象のスルー対象を確認する
  const skipSelect = page.getByLabel("スルー表示");
  await expect(skipSelect).toHaveValue("normal");
  const countOf = async () => Number((await page.getByRole("tab", { name: /★管理対象/ }).innerText()).match(/(\d+)\s*$/)![1]);
  const normal = await page.getByTestId("lottery-card").count();
  await skipSelect.selectOption("include");
  const include = await page.getByTestId("lottery-card").count();
  expect(include).toBeGreaterThanOrEqual(normal);
  await skipSelect.selectOption("only");
  const only = await page.getByTestId("lottery-card").count();
  expect(only).toBe(include - normal);
  void countOf;
  // Bに切り替えるとBのスルー（なし）が基準になる
  await switchProfile(page, "B");
  await page.getByLabel("スルー表示").selectOption("only");
  await expect(page.getByTestId("lottery-card")).toHaveCount(0);
});

test("通知はベルに集約。縦に並ぶアラート表示は無く、件数バッジと一覧から該当抽選へ移動できる", async ({ page }) => {
  await expect(page.getByTestId("alerts-bar")).toHaveCount(0);
  const bell = page.getByTestId("notification-bell");
  const badge = page.getByTestId("notification-badge");
  await expect(bell).toBeVisible();
  await expect(badge).toBeVisible();
  const n = Number(await badge.innerText());
  expect(n).toBeGreaterThan(0);
  // バッジはベルに重なる
  const [bb, gb] = [(await bell.boundingBox())!, (await badge.boundingBox())!];
  expect(gb.x).toBeGreaterThan(bb.x);
  expect(gb.x + gb.width).toBeLessThanOrEqual(bb.x + bb.width + 2);
  expect(gb.y).toBeGreaterThanOrEqual(bb.y - 2);

  await bell.click();
  const list = page.getByTestId("alerts-list");
  await expect(list.getByRole("link")).toHaveCount(n);
  await list.getByRole("link").first().click();
  await expect(page).toHaveURL(/\/lotteries\?focus=/);
  const id = new URL(page.url()).searchParams.get("focus")!;
  await expect(page.locator(`[data-lottery-id="${id}"]`)).toBeVisible();
});

test("ヘッダーを増高させない: 通知・ユーザー表示を含めても低い", async ({ page }) => {
  const h = (await page.locator("header").boundingBox())!;
  expect(h.height).toBeLessThanOrEqual(48);
  const bell = (await page.getByTestId("notification-bell").boundingBox())!;
  expect(bell.width).toBeGreaterThanOrEqual(40);
  expect(bell.height).toBeGreaterThanOrEqual(40);
});

test("タブ・詳細・マトリクスを切り替えられる", async ({ page }) => {
  await page.getByRole("tab", { name: /応募済み/ }).click();
  await expect(page.getByTestId("lottery-card").first()).toContainText("結果未登録");
  await page.getByRole("tab", { name: /当選/ }).click();
  await expect(page.getByRole("button", { name: "購入済み" }).first()).toBeVisible();
  await page.getByRole("tab", { name: /★管理対象/ }).click();
  await page.getByRole("button", { name: "詳細表示にする" }).click();
  await expect(page.getByTestId("lottery-detail").first()).toBeVisible();
  await page.getByRole("button", { name: "応募マトリクスにする" }).click();
  await expect(page.getByTestId("matrix")).toBeVisible();
});

test("複数商品の抽選は、シンプル表示では「＋他N商品」、詳細表示では全商品と方式を確認できる", async ({ page }) => {
  const card = page.locator('[data-lottery-id="L3"]');
  await expect(card.getByTestId("lottery-items").getByRole("listitem")).toHaveCount(2); // 先頭商品 + 「＋他1商品」
  await expect(card).toContainText("＋他1商品");
  await expect(card).toContainText("商品ごとに当落");
  await card.getByRole("button", { name: "詳細" }).click();
  await expect(card.getByTestId("lottery-items").getByRole("listitem")).toHaveCount(2);
  await expect(card).not.toContainText("＋他1商品");
  await expect(card.getByTestId("lottery-items")).toContainText("ほしぞら");
});

test("応募済み・当選タブの赤丸は、未対応がある場合に表示される", async ({ page }) => {
  await expect(page.getByTestId("tab-dot-won")).toBeVisible(); // Aは当選済みで購入未完了（L7）
});

test("日付のみの締切には残り時間バッジを出さない", async ({ page }) => {
  await expect(page.locator('[data-lottery-id="L3"]')).toContainText("時刻未確認");
  await expect(page.locator('[data-lottery-id="L3"]')).not.toContainText("あと");
});

test("収支ページ: 当月表示・月移動・タブ切替・分析ページへのリンク", async ({ page }) => {
  await page.getByRole("link", { name: "収支" }).first().click();
  await expect(page).toHaveURL(/\/finance$/);
  const label = page.getByTestId("month-label");
  const now = new Date();
  await expect(label).toContainText(`${now.getFullYear()}年`);
  const before = await label.innerText();
  await page.getByRole("button", { name: "前の月" }).click();
  expect(await label.innerText()).not.toBe(before);
  await page.getByRole("button", { name: "次の月" }).click();
  expect(await label.innerText()).toBe(before);
  for (const t of ["すべて", "支出", "収入"]) await page.getByRole("tab", { name: t }).click();
  // 収入タブには売却名義人の絞り込み
  await expect(page.getByRole("group", { name: "売却名義人で絞り込み" })).toBeVisible();
  await page.getByRole("link", { name: "年間売却実績・収益分析" }).click();
  await expect(page).toHaveURL(/\/finance\/analysis$/);
  await expect(page.getByTestId("annual-total")).toContainText("家族全体の合計");
  await expect(page.getByTestId("annual-seller")).toHaveCount(3);
  // メインナビには分析ページを常設しない
  await expect(page.getByRole("navigation", { name: "メイン" }).first().getByRole("link")).toHaveCount(3);
});

test.describe("レイアウト（Safe Area・固定メニュー）", () => {
  test("viewport-fit=cover と Safe Area の余白指定があり、下部ナビはコンテンツを隠さない", async ({ page }) => {
    await expect(page.locator('meta[name="viewport"]')).toHaveAttribute("content", /viewport-fit=cover/);
    const css = await page.evaluate(() =>
      [...document.styleSheets].flatMap((s) => [...s.cssRules]).map((r) => r.cssText).join("\n"),
    );
    expect(css).toContain("env(safe-area-inset-bottom)");
    expect(css).toContain("env(safe-area-inset-top)");

    const vp = page.viewportSize()!;
    if (vp.width >= 768) return; // 下部ナビはモバイルのみ
    const nav = page.locator("nav[aria-label='メイン']").last();
    // ナビの操作行（3.25rem）は余白を除いてコンパクト
    const row = (await nav.locator("> div").boundingBox())!;
    expect(row.height).toBeLessThanOrEqual(56);
    // 最下部までスクロールしたとき、最後のカードがナビの下に隠れない
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    const navBox = (await nav.boundingBox())!;
    const last = (await page.getByTestId("lottery-card").last().boundingBox())!;
    expect(last.y + last.height).toBeLessThanOrEqual(navBox.y + 1);
  });
});

test("ダークモード: 背景 < ヘッダー < カード < 入力欄 の順に明るく、境界が判別できる", async ({ page }) => {
  await page.emulateMedia({ colorScheme: "dark" });
  await page.goto("/lotteries");
  await expect(page.getByTestId("lottery-card").first()).toBeVisible();
  const lum = (rgb: string) => {
    const [r, g, b] = rgb.match(/\d+/g)!.map(Number);
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  };
  const bg = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
  const header = await page.locator("header").evaluate((e) => getComputedStyle(e).backgroundColor);
  const card = await page.getByTestId("lottery-card").first().evaluate((e) => getComputedStyle(e).backgroundColor);
  const input = await page.getByRole("searchbox").evaluate((e) => getComputedStyle(e).backgroundColor);
  expect(lum(bg)).toBeLessThan(lum(header));
  expect(lum(header)).toBeLessThan(lum(card));
  expect(lum(card)).toBeLessThan(lum(input));
  expect(lum(bg)).toBeLessThan(20); // ほぼ黒
  const text = await page.getByRole("heading", { name: "抽選管理" }).evaluate((e) => getComputedStyle(e).color);
  expect(lum(text)).toBeGreaterThan(220);
});

for (const scheme of ["light", "dark"] as const) {
  test(`スクリーンショット (${scheme})`, async ({ page }, info) => {
    await page.emulateMedia({ colorScheme: scheme });
    await page.goto("/lotteries");
    await expect(page.getByTestId("lottery-card").first()).toBeVisible();
    await page.screenshot({ path: `docs/screenshots/${info.project.name}-${scheme}.png` });
  });
}
