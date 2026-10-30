import { expect, test, type Page } from "@playwright/test";

test.beforeEach(async ({ page }) => {
  await page.goto("/lotteries");
  await expect(page.getByTestId("lottery-card").first()).toBeVisible();
});

/** 詳細フィルターを開く（既に開いていれば何もしない） */
async function openFilters(page: Page) {
  const btn = page.getByRole("button", { name: "詳細フィルターを開く" });
  if ((await btn.getAttribute("aria-pressed")) !== "true") await btn.click();
  await expect(page.getByRole("group", { name: "詳細フィルター" })).toBeVisible();
}

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

test("検索は1行でコンパクト。詳細フィルターは初期状態で非表示、フィルターボタンで展開し、適用中は件数で示す", async ({ page }) => {
  const search = page.getByRole("searchbox");
  const s = (await search.boundingBox())!;
  expect(s.height).toBeLessThan(48);
  // 「系列: すべて」などは初期状態では出ていない
  await expect(page.getByRole("group", { name: "詳細フィルター" })).toHaveCount(0);
  await expect(page.getByLabel("系列")).toHaveCount(0);
  // 見出し・タブ・検索を含めても、最初のカードが画面の上半分に入る
  const firstCard = (await page.getByTestId("lottery-card").first().boundingBox())!;
  const vp = page.viewportSize()!;
  expect(firstCard.y).toBeLessThan(vp.height * 0.4);
  await openFilters(page);
  await expect(page.getByTestId("filter-count")).toHaveCount(0);
  await page.getByRole("group", { name: "詳細フィルター" }).getByLabel("受取方法").selectOption("store");
  await expect(page.getByTestId("filter-count")).toHaveText("1");
});

test("見出しとタブは固定され、その下だけがスクロールする。フィルター状態は再読込後も保持される", async ({ page }) => {
  const tabs = page.getByRole("tablist", { name: "抽選の表示切替" });
  const header = (await page.locator("header").boundingBox())!;
  await page.evaluate(() => window.scrollTo(0, 400));
  const t = (await tabs.boundingBox())!;
  // スクロールしてもタブはヘッダーの直下に留まる
  expect(t.y).toBeGreaterThanOrEqual(header.y + header.height - 2);
  expect(t.y).toBeLessThan(header.y + header.height + 60);
  // 見出し＋タブの固定領域は画面を占有しすぎない
  const vp = page.viewportSize()!;
  expect(t.y + t.height - header.y).toBeLessThan(vp.height * 0.3);

  await page.getByRole("tab", { name: /全情報/ }).click();
  await page.getByRole("searchbox").fill("ほしぞら");
  await page.reload();
  await expect(page.getByRole("tab", { name: /全情報/ })).toHaveAttribute("aria-selected", "true");
  await expect(page.getByRole("searchbox")).toHaveValue("ほしぞら");
});

test("スルー表示フィルター: 通常は自分のスルーを除き、含む/のみで切り替えられる。他のユーザーには影響しない", async ({ page }) => {
  // Aは s5(ダミー書店) をスルー中（モック）。L10 などは★管理外のため、★対象のスルー対象を確認する
  await openFilters(page);
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
  await openFilters(page);
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
  // 既定は詳細表示。シンプルにするとコンパクトな1行カード（★・小さな画像・店名・商品名・自分の応募状態）になる
  await expect(page.getByTestId("card-simple")).toHaveCount(0);
  await page.getByRole("button", { name: "シンプル表示にする" }).click();
  await expect(page.getByRole("button", { name: "詳細表示にする" })).toBeVisible();
  await expect(page.getByTestId("card-simple").first()).toBeVisible();
  await page.getByRole("button", { name: "詳細表示にする" }).click();
  await expect(page.getByTestId("card-simple")).toHaveCount(0);
  await page.getByRole("button", { name: "応募マトリクスにする" }).click();
  await expect(page.getByTestId("matrix")).toBeVisible();
});

test("カードは商品画像を左に大きく表示し、タップで詳細（下から開くパネル）が開く。閉じるとスクロール位置が戻る", async ({ page }) => {
  const card = page.locator('[data-lottery-id="L1"]');
  const img = (await card.getByTestId("card-image").boundingBox())!;
  expect(img.width).toBeGreaterThanOrEqual(72);
  expect(img.height).toBeGreaterThanOrEqual(88);
  // 画像は左端、テキストはその右
  const box = (await card.boundingBox())!;
  expect(img.x - box.x).toBeLessThan(24);

  await page.evaluate(() => window.scrollTo(0, 120));
  const y0 = await page.evaluate(() => window.scrollY);
  await card.getByRole("button", { name: /の詳細を開く/ }).click();
  const sheet = page.getByTestId("lottery-detail-sheet");
  await expect(sheet).toBeVisible();
  await expect(page.getByTestId("lottery-detail")).toContainText("応募締切");
  await expect(page.getByTestId("lottery-detail")).toContainText("ユーザー別の応募状況・当落");
  const vp = page.viewportSize()!;
  if (vp.width < 768) {
    // スマホでは画面下から開く（下端が画面の下端に揃う）
    await expect
      .poll(async () => {
        const sb = (await sheet.boundingBox())!;
        return Math.abs(sb.y + sb.height - vp.height);
      })
      .toBeLessThan(2); // 開くアニメーションの完了を待つ
  }
  // 右上の閉じるボタンは無い。上部のハンドルのタップ（スマホ）／Esc・背景タップで閉じる
  await expect(sheet.getByRole("button", { name: "閉じる", exact: true })).toHaveCount(0);
  if (vp.width < 768) await sheet.getByTestId("sheet-handle").click();
  else await page.keyboard.press("Escape");
  await expect(sheet).toHaveCount(0);
  await expect.poll(async () => Math.abs((await page.evaluate(() => window.scrollY)) - y0)).toBeLessThan(4);
});

test("応募状態のアイコンは意味を画面内で確認できる（凡例）。「？」だけの表示は使わない", async ({ page }) => {
  await page.getByRole("button", { name: "アイコンの意味を表示" }).click();
  const legend = page.getByTestId("legend");
  await expect(legend).toContainText("要確認");
  await expect(legend).toContainText("未応募");
  await expect(page.getByTestId("lottery-card").first().getByText("？")).toHaveCount(0);
});

test("応募マトリクス: A/B/C が横スクロールなしで同時に見え、状態はアイコンで示す", async ({ page }) => {
  await page.getByRole("button", { name: "応募マトリクスにする" }).click();
  const matrix = page.getByTestId("matrix");
  await expect(matrix).toBeVisible();
  const table = matrix.locator("table");
  const dims = await table.evaluate((e) => ({ sw: e.scrollWidth, cw: (e.parentElement as HTMLElement).clientWidth }));
  expect(dims.sw).toBeLessThanOrEqual(dims.cw + 1);
  await expect(matrix.locator("thead th")).toHaveCount(4); // 抽選 + A/B/C
  await expect(matrix.locator("tbody tr").first().locator("[data-status]").first()).toBeVisible();
  // 系列と店舗は別行（補助文字）
  await expect(matrix.locator("tbody th").first().locator("span")).toHaveCount(2);
  await matrix.getByRole("button", { name: "アイコンの意味", exact: true }).click();
  await expect(page.getByTestId("matrix-legend")).toBeVisible();
});

test("名称はトレマネ。ヘッダー・ページタイトル・PWAの表示名に反映され、旧名称は残っていない", async ({ page, request }) => {
  await expect(page.locator("header").getByTestId("brand")).toContainText("トレマネ");
  await expect(page).toHaveTitle(/トレマネ/);
  const res = await request.get("/manifest.webmanifest");
  const m = await res.json();
  expect(m.short_name).toBe("トレマネ");
  expect(m.name).toContain("トレマネ");
  expect(m.name).toContain("TCG manager");
  expect(m.icons.map((i: { src: string }) => i.src)).toContain("/icons/v2/icon-512.png");
  await expect(page.locator("body")).not.toContainText("トレカ抽選管理");
  for (const path of ["/icons/v2/icon-192.png", "/icons/v2/apple-touch-icon.png", "/icons/v2/maskable-512.png", "/icons/v2/favicon-32.png", "/icons/v2/favicon-16.png"]) {
    expect((await request.get(path)).status()).toBe(200);
  }
});

test("複数商品の抽選は、詳細表示では全商品、シンプル表示では「＋他N商品」。詳細パネルでも全商品と方式を確認できる", async ({ page }) => {
  const card = page.locator('[data-lottery-id="L3"]');
  // 既定の詳細表示: カード上に全商品が並ぶ
  await expect(card).not.toContainText("＋他1商品");
  await expect(card.getByTestId("lottery-items")).toContainText("ほしぞら");
  await card.getByRole("button", { name: /の詳細を開く/ }).click();
  const detail = page.getByTestId("lottery-detail");
  await expect(detail.getByTestId("lottery-items").getByRole("listitem")).toHaveCount(2);
  await expect(detail.getByTestId("lottery-items")).toContainText("ほしぞら");
  await expect(detail).toContainText("商品ごとに当落");
  await page.keyboard.press("Escape");
  // シンプル表示に切り替えると、代表商品と「＋他N商品」だけになる
  await page.getByRole("button", { name: "シンプル表示にする" }).click();
  await expect(card).toContainText("＋他1商品");
  await expect(card).not.toContainText("ほしぞら");
});

test("応募済み・当選タブの赤丸は、未対応がある場合に表示される", async ({ page }) => {
  await expect(page.getByTestId("tab-dot-won")).toBeVisible(); // Aは当選済みで購入未完了（L7）
});

test("日付のみの締切には残り時間バッジを出さない", async ({ page }) => {
  const card = page.locator('[data-lottery-id="L3"]');
  await expect(card).not.toContainText("あと");
  // 一覧では時刻を出さず日付だけ（「—」でも0:00でもない）。詳細では「時刻未確認」と明示する
  await expect(card.getByLabel(/応募締切 .*時刻未確認/)).toBeVisible();
  await card.getByRole("button", { name: /の詳細を開く/ }).click();
  await expect(page.getByTestId("lottery-detail")).toContainText("時刻未確認");
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
  await expect(page.getByRole("navigation", { name: "メイン" }).first().getByRole("link")).toHaveCount(page.viewportSize()!.width >= 768 ? 5 : 5); // 隠れる機能が1つだけなら「その他」を出さず直接表示する（5枠）
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

test("購入記録: 下部メニューから開け、履歴と商品別の累計・期間・絞り込みが使える。金額未入力は0円としない", async ({ page }) => {
  await page.getByRole("navigation", { name: "メイン" }).last().getByRole("link", { name: "購入記録" }).click();
  await expect(page).toHaveURL(/\/purchases$/);
  await expect(page.getByRole("heading", { name: "購入記録" })).toBeVisible();
  // 全期間にすると、モックの購入が一覧に出る
  await page.getByTestId("period-label").click();
  await page.getByTestId("period-picker").getByRole("tab", { name: "全期間" }).click();
  const rows = page.getByTestId("purchase-row");
  await expect(rows.first()).toBeVisible();
  const n = await rows.count();
  await expect(page.getByTestId("purchase-count")).toHaveText(`${n}件`);
  // 商品別の累計
  await page.getByRole("tab", { name: "商品別の累計" }).click();
  await expect(page.getByTestId("product-total-row").first()).toBeVisible();
  // 期間（月）と前後移動
  await page.getByTestId("period-label").click();
  await page.getByTestId("period-picker").getByRole("tab", { name: "月", exact: true }).click();
  await page.getByTestId("period-picker").getByRole("button", { name: "12月" }).click();
  const label = page.getByTestId("period-label");
  await expect(label).toContainText("12月");
  const before = await label.innerText();
  await page.getByRole("button", { name: "前の期間" }).click();
  expect(await label.innerText()).not.toBe(before);
  // 4項目のナビで、現在地が分かる
  await expect(page.getByRole("navigation", { name: "メイン" }).last().getByRole("link", { name: "購入記録" })).toHaveAttribute("aria-current", "page");
});

test("応募実績・当選率: 抽選管理から開け、期間・ユーザー別に切り替えられる。未確認・中止は母数に入れない説明がある", async ({ page }) => {
  await page.getByRole("link", { name: "応募実績・当選率を見る" }).click();
  await expect(page).toHaveURL(/\/records$/);
  await expect(page.getByTestId("win-overall")).toContainText("当落が確定した応募");
  await expect(page.getByTestId("win-overall")).toContainText("未確認は当落が未登録の応募");
  await expect(page.getByTestId("win-by-chain").getByTestId("rate-row").first()).toBeVisible();
  await expect(page.getByTestId("win-by-profile")).toBeVisible();
  await page.getByRole("group", { name: "対象ユーザー" }).getByRole("button", { name: "B", exact: true }).click();
  await expect(page.getByTestId("win-by-profile")).toHaveCount(0); // ユーザーを選ぶとユーザー別の表は出さない
  await page.getByRole("tab", { name: "年間" }).click();
  await expect(page.getByTestId("period-label")).toContainText("年");
  // 横にはみ出さない
  const w = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(w).toBeLessThanOrEqual(1);
});

test("対戦記録: 設定から開ける。モックでは保存できない旨を表示し、画面は壊れない", async ({ page }) => {
  await page.goto("/battles");
  await expect(page.getByRole("heading", { name: "対戦記録" })).toBeVisible();
  await expect(page.getByText("マイグレーション")).toBeVisible();
});

test("抽選カード右上は受取方法で決まる（店頭=受取店舗の都道府県、発送=通販）。カードに距離は出さず、詳細パネルには残る", async ({ page }) => {
  await page.getByRole("tab", { name: /全情報/ }).click();
  // 店頭受取（三宮店・自宅の近く）: 都道府県。距離はカードに出さない
  const near = page.getByTestId("lottery-card").filter({ hasText: "三宮店" }).first();
  await expect(near.getByTestId("card-place")).toContainText("兵庫県");
  await expect(near.getByTestId("card-place")).not.toContainText("通販");
  await expect(page.getByTestId("card-distance")).toHaveCount(0);
  // 受取方法が発送の抽選（L4）は、店舗が登録されていても「通販」
  const ship = page.locator('[data-lottery-id="L4"]');
  await expect(ship.getByTestId("card-place")).toHaveText("通販");
  // 東京の店舗（店頭受取）は都道府県
  const tokyo = page.getByTestId("lottery-card").filter({ hasText: "本店" }).first();
  await expect(tokyo.getByTestId("card-place")).toContainText("東京都");
  // 詳細パネルでは位置情報（直線距離・交通費）を引き続き確認できる（道路距離と混同しない表記）
  await tokyo.getByRole("button", { name: /の詳細を開く/ }).click();
  await expect(page.getByTestId("lottery-detail")).toContainText("直線");
  await expect(page.getByTestId("lottery-detail")).toContainText("往復交通費");
  await page.keyboard.press("Escape");
  // 受取場所ラベルは商品画像と重ならない
  const [img, pl] = [(await tokyo.getByTestId("card-image").boundingBox())!, (await tokyo.getByTestId("card-place").boundingBox())!];
  expect(pl.x).toBeGreaterThan(img.x + img.width);
});

test.describe("起動時のロード画面", () => {
  test("最初のHTMLにロゴ・名称・スピナー・読み込み中...が含まれ、JavaScriptやデータを待つ間も黒い画面にならない", async ({ request }) => {
    const html = await (await request.get("/lotteries")).text();
    expect(html).toContain('data-testid="splash"');
    expect(html).toContain("トレマネ");
    expect(html).toContain("TCG manager");
    expect(html).toContain("読み込み中...");
    expect(html).toContain("animate-spin");
  });

  test("JavaScriptが動く前でも、ロゴと「読み込み中...」がテーマの背景色で表示される（ライト）", async ({ browser }) => {
    const ctx = await browser.newContext({ javaScriptEnabled: false, colorScheme: "light" });
    const page = await ctx.newPage();
    await page.goto("/lotteries");
    const splash = page.getByTestId("splash");
    await expect(splash).toBeVisible();
    await expect(splash).toContainText("読み込み中...");
    await expect(splash.locator("img").first()).toBeVisible(); // ロゴ（原本画像から生成したアイコン）
    const bg = await splash.evaluate((e) => getComputedStyle(e).backgroundColor);
    expect(bg).toBe("rgb(244, 244, 245)"); // ライトの背景。黒ではない
    await page.screenshot({ path: `docs/screenshots/stage45-splash-light.png` });
    await ctx.close();
  });

  test("ダーク: 起動の準備中はダークの背景でロゴと読み込み中を表示し、準備ができたら自動で通常画面になる。固定秒数は待たない", async ({ browser }) => {
    const ctx = await browser.newContext({ colorScheme: "dark" });
    const page = await ctx.newPage();
    // アプリのスクリプトの到着を遅らせ、準備中の画面を確認する（テーマ設定のインラインスクリプトは遅れない）
    await page.route(/\/_next\/static\/.*\.js/, async (route) => {
      await new Promise((r) => setTimeout(r, 1500));
      await route.continue();
    });
    const t0 = Date.now();
    await page.goto("/lotteries", { waitUntil: "commit" });
    const splash = page.getByTestId("splash");
    await expect(splash).toBeVisible();
    await expect(page.locator("html")).toHaveClass(/dark/);
    const bg = await splash.evaluate((e) => getComputedStyle(e).backgroundColor);
    expect(bg).toBe("rgb(8, 8, 10)"); // アプリのダーク背景（スクリプト待ちの間も表示される）
    await expect(splash).toContainText("TCG manager");
    await page.screenshot({ path: `docs/screenshots/stage45-splash-dark.png` });
    await page.unroute(/\/_next\/static\/.*\.js/);
    await expect(page.getByTestId("lottery-card").first()).toBeVisible({ timeout: 15000 });
    await expect(page.getByTestId("splash")).toHaveCount(0);
    expect(Date.now() - t0).toBeLessThan(15000);
    await ctx.close();
  });

  test("起動後のページ移動・データ更新では、全面のロード画面を出さない", async ({ page }) => {
    await page.goto("/lotteries");
    await expect(page.getByTestId("lottery-card").first()).toBeVisible();
    await page.evaluate(() => {
      (window as unknown as { __splashSeen: number }).__splashSeen = 0;
      new MutationObserver(() => {
        if (document.querySelector('[data-testid="splash"]')) (window as unknown as { __splashSeen: number }).__splashSeen++;
      }).observe(document.body, { childList: true, subtree: true });
    });
    const nav = page.getByRole("navigation", { name: "メイン" }).last();
    await nav.getByRole("link", { name: "購入記録" }).click();
    await expect(page).toHaveURL(/\/purchases$/);
    await nav.getByRole("link", { name: "収支" }).click();
    await expect(page).toHaveURL(/\/finance$/);
    await nav.getByRole("link", { name: "抽選管理" }).click();
    await expect(page.getByTestId("lottery-card").first()).toBeVisible();
    await page.getByRole("tab", { name: /全情報/ }).click();
    expect(await page.evaluate(() => (window as unknown as { __splashSeen: number }).__splashSeen)).toBe(0);
  });
});

// ------------------------------------------------------------------ Stage 5D/5E: ヘッダーの設定・下部メニューのカスタマイズ・設定の一覧・設定のコピー
test("共有から登録: X投稿のURLだけ受け付け、標準の形にそろえて表示する。不正なURLは理由を出して解析を始められない", async ({ page }) => {
  await page.goto("/share?url=" + encodeURIComponent("https://twitter.com/shop_e2e/status/1234567890123?s=20&t=abc"));
  await expect(page.getByTestId("share-url")).toHaveText("https://x.com/shop_e2e/status/1234567890123");
  await expect(page.getByTestId("share-start")).toBeEnabled();
  // 文章付きの共有（本文＋URL）からもURLを取り出す
  await page.goto("/share?text=" + encodeURIComponent("【抽選】応募は明日まで https://x.com/shop_e2e/status/9876543210?s=46"));
  await expect(page.getByTestId("share-url")).toHaveText("https://x.com/shop_e2e/status/9876543210");
  for (const bad of ["https://example.com/a/status/1234567890", "javascript:alert(1)", "https://x.com/home", ""]) {
    await page.goto("/share?url=" + encodeURIComponent(bad));
    await expect(page.getByTestId("share-invalid")).toBeVisible();
    await expect(page.getByTestId("share-start")).toHaveCount(0);
  }
});

test.describe("設定とナビゲーション", () => {
  test("設定はヘッダーの歯車から開く。下部メニューには設定が無く、重ならずに押せる", async ({ page }) => {
    const gear = page.getByTestId("header-settings");
    await expect(gear).toBeVisible();
    const g = (await gear.boundingBox())!;
    expect(g.width).toBeGreaterThanOrEqual(40);
    expect(g.height).toBeGreaterThanOrEqual(40);
    const [bell, chip] = [(await page.getByTestId("notification-bell").boundingBox())!, (await page.getByTestId("current-profile").boundingBox())!];
    // 右側の並びは 設定 → 通知 → ユーザー名（重ならない）
    expect(g.x + g.width).toBeLessThanOrEqual(bell.x + 1);
    expect(bell.x + bell.width).toBeLessThanOrEqual(chip.x + 1);
    // 下部メニュー（スマホ）/左ナビ（PC）に「設定」は無い
    await expect(page.getByRole("navigation", { name: "メイン" }).getByRole("link", { name: "設定" })).toHaveCount(0);
    await gear.click();
    await expect(page).toHaveURL(/\/settings$/);
    await expect(page.getByTestId("settings-menu")).toBeVisible();
    // どの主要ページからも開ける
    await page.goto("/finance");
    await page.getByTestId("header-settings").click();
    await expect(page).toHaveURL(/\/settings$/);
  });

  test("設定は見出しの一覧。小さな項目はアコーディオンで開き、大きな項目は別ページ。以前の項目へ辿れる", async ({ page }) => {
    await page.goto("/settings");
    const menu = page.getByTestId("settings-menu");
    for (const t of ["ユーザー管理", "メニュー・表示設定", "記録・分析", "データ管理・バックアップ", "アプリについて・ログアウト"]) await expect(menu).toContainText(t);
    // アコーディオン: 開くまで中身は描画されない
    const acc = page.getByTestId("acc-records");
    await expect(acc.getByRole("link", { name: "応募実績・当選率" })).toHaveCount(0);
    await acc.getByRole("button", { name: /記録・分析/ }).click();
    await expect(acc.getByRole("link", { name: "応募実績・当選率" })).toBeVisible();
    await expect(acc.getByRole("button", { name: /記録・分析/ })).toHaveAttribute("aria-expanded", "true");
    // 別ページへ: 戻るリンクで一覧へ
    await page.getByTestId("menu-display").click();
    await expect(page).toHaveURL(/\/settings\/display$/);
    await expect(page.getByTestId("display-settings")).toBeVisible();
    await page.getByRole("link", { name: "← 設定" }).click();
    await expect(page).toHaveURL(/\/settings$/);
    await page.getByTestId("menu-users").click();
    await expect(page.getByRole("heading", { name: "ユーザー管理" })).toBeVisible();
    await expect(page.getByTestId("settings-copy")).toBeVisible();
  });

  test("動きを減らす設定では、ページ移動のアニメーションが実質無効になる", async ({ browser }) => {
    const ctx = await browser.newContext({ reducedMotion: "reduce" });
    const page = await ctx.newPage();
    await page.goto("/settings/display");
    await expect(page.getByTestId("display-settings")).toBeVisible();
    const d = await page.getByTestId("display-settings").evaluate((e) => getComputedStyle(e.parentElement!).animationDuration);
    expect(parseFloat(d)).toBeLessThan(0.05);
    await ctx.close();
  });

  test("下部メニュー: 項目の非表示・並び替え・「その他」。設定はユーザーごとで、ユーザーを切り替えると変わる", async ({ page, isMobile }) => {
    await page.goto("/settings/display");
    const order = page.getByTestId("nav-order");
    await expect(order.locator("li")).toHaveCount(5);
    await order.getByRole("button", { name: "収支を上へ" }).click();
    await expect(order.locator("li").nth(1)).toContainText("収支");
    // 2つ非表示にすると「その他」ができる（隠れた機能へ辿れる）
    await order.getByRole("button", { name: "対戦記録を表示しない" }).click();
    await order.getByRole("button", { name: "購入記録を表示しない" }).click();
    await expect(page.getByTestId("nav-hidden")).toContainText("対戦記録");
    if (isMobile) {
      const nav = page.getByTestId("bottom-nav");
      await expect(nav.getByRole("link")).toHaveCount(3);
      await expect(nav.getByTestId("nav-more")).toBeVisible();
      await nav.getByTestId("nav-more").click();
      const more = page.getByTestId("more-sheet");
      await expect(more.getByRole("link", { name: "対戦記録" })).toBeVisible();
      await more.getByRole("link", { name: "対戦記録" }).click();
      await expect(page).toHaveURL(/\/battles$/);
    }
    // 別のユーザーは影響を受けない
    await switchProfile(page, "B");
    await page.goto("/settings/display");
    await expect(page.getByTestId("nav-order").locator("li")).toHaveCount(5);
    await switchProfile(page, "A");
    await page.goto("/settings/display");
    await expect(page.getByTestId("nav-order").locator("li")).toHaveCount(3);
    // 表示していない機能を戻せる。初期の並びにも戻せる
    await page.getByTestId("nav-hidden").getByRole("button", { name: "対戦記録を表示する" }).click();
    await expect(page.getByTestId("nav-order").locator("li")).toHaveCount(4);
    await page.getByRole("button", { name: "初期の並びに戻す" }).click();
    await expect(page.getByTestId("nav-order").locator("li").nth(1)).toContainText("購入記録");
  });

  test("コレクション: 初期は下部メニューに直接表示され（「その他」は出ない）、下部メニューに直接表示することもできる（メニューが壊れない）", async ({ page, isMobile }) => {
    await page.goto("/settings/display");
    await expect(page.getByTestId("nav-order").locator("li")).toHaveCount(5);
    await expect(page.getByTestId("nav-order")).toContainText("コレクション");
    if (isMobile) {
      // 隠れる機能がコレクションだけなら「その他」は出さず、直接表示する
      await expect(page.getByTestId("nav-more")).toHaveCount(0);
      await expect(page.getByTestId("bottom-nav").getByRole("link", { name: "コレクション" })).toBeVisible();
    }
    // 外すと、隠れた機能が1つだけなので「その他」は出ずに直接表示のまま。もう1つ外すと「その他」ができる
    await page.getByTestId("nav-order").getByRole("button", { name: "コレクションを表示しない" }).click();
    await page.getByTestId("nav-order").getByRole("button", { name: "対戦記録を表示しない" }).click();
    await expect(page.getByTestId("nav-hidden")).toContainText("コレクション");
    if (isMobile) await expect(page.getByTestId("nav-more")).toBeVisible();
    await page.getByRole("button", { name: "初期の並びに戻す" }).click();
    await expect(page.getByTestId("nav-order").locator("li")).toHaveCount(5);
  });

  test("設定のコピー: 確認ダイアログのあと、選んだ項目だけがコピーされる（コピーしない項目の説明あり）", async ({ page, isMobile }) => {
    await page.goto("/settings/display");
    await page.getByTestId("nav-order").getByRole("button", { name: "対戦記録を表示しない" }).click();
    await page.getByTestId("nav-order").getByRole("button", { name: "購入記録を表示しない" }).click();
    await page.getByRole("radio", { name: "シンプル", exact: true }).click();
    await page.goto("/settings/users");
    const copy = page.getByTestId("settings-copy");
    await expect(copy).toContainText("プロフィール名・アイコン・応募/当落/スルーの履歴");
    await copy.getByLabel("コピー先のプロフィール").selectOption({ label: "B" });
    await copy.getByRole("radio", { name: "項目を選んでコピー" }).check();
    await expect(copy.getByTestId("copy-start")).toBeDisabled(); // 項目を選ぶまで押せない
    await copy.getByRole("checkbox", { name: /下部メニュー/ }).check();
    await copy.getByTestId("copy-start").click();
    const dlg = page.getByTestId("copy-confirm");
    await expect(dlg).toContainText("Bの現在の設定は上書きされます");
    await expect(dlg).toContainText("下部メニューの表示項目・並び順");
    await expect(dlg).not.toContainText("抽選カードのシンプル／詳細表示");
    await dlg.getByRole("button", { name: "キャンセル" }).click();
    // キャンセルでは何も変わらない
    await switchProfile(page, "B");
    await page.goto("/settings/display");
    await expect(page.getByTestId("nav-order").locator("li")).toHaveCount(5);
    await switchProfile(page, "A");
    await page.goto("/settings/users");
    await copy.getByLabel("コピー先のプロフィール").selectOption({ label: "B" });
    await copy.getByRole("radio", { name: "項目を選んでコピー" }).check();
    await copy.getByRole("checkbox", { name: /下部メニュー/ }).check();
    await copy.getByTestId("copy-start").click();
    await page.getByTestId("copy-confirm-ok").click();
    await expect(page.getByTestId("copy-result")).toContainText("コピーしました");
    // B: メニューはコピーされ、カードの表示（選ばなかった項目）は変わらない
    await switchProfile(page, "B");
    await page.goto("/settings/display");
    await expect(page.getByTestId("nav-order").locator("li")).toHaveCount(3);
    await expect(page.getByRole("radio", { name: "詳細", exact: true })).toHaveAttribute("aria-checked", "true");
    if (isMobile) await expect(page.getByTestId("nav-more")).toBeVisible();
  });

  test("カードのシンプル／詳細はユーザーごと。Aをシンプルにしても、Bは詳細のまま", async ({ page }) => {
    await page.getByRole("button", { name: "シンプル表示にする" }).click();
    await expect(page.getByTestId("card-simple").first()).toBeVisible();
    await switchProfile(page, "B");
    await expect(page.getByRole("button", { name: "シンプル表示にする" })).toBeVisible();
    await expect(page.getByTestId("card-simple")).toHaveCount(0);
    await switchProfile(page, "A");
    await expect(page.getByTestId("card-simple").first()).toBeVisible();
  });

  test("シンプル表示のカード: 低く、★・小さな画像・店名・商品名・現在のユーザーの状態だけ。応募の操作も使える", async ({ page }) => {
    await page.getByRole("button", { name: "シンプル表示にする" }).click();
    const card = page.locator('[data-lottery-id="L1"]');
    await expect(card.getByTestId("card-simple")).toBeVisible();
    const h = (await card.boundingBox())!.height;
    expect(h).toBeLessThan(90);
    const img = (await card.getByTestId("card-image").boundingBox())!;
    expect(img.height).toBeLessThanOrEqual(65);
    await expect(card.getByLabel("応募アカウントの状態")).toHaveCount(0); // 全員分の状態は出さない
    await expect(card.locator("[data-status]")).toHaveCount(1); // 現在のユーザーのみ
    await expect(card.getByRole("button", { name: /管理対象（★）をOFF/ })).toBeVisible();
  });
});

test.describe("表示診断（下部メニューの位置ずれの調査用）", () => {
  test("通常は表示されない。?diag=1 で診断モードになり、寸法・Safe Area・最初のタッチ前後が記録されてコピーできる。?diag=off で解除", async ({ page, isMobile, context }) => {
    test.skip(!isMobile, "下部メニューはスマホ幅のみ");
    await context.grantPermissions(["clipboard-read", "clipboard-write"]).catch(() => undefined);
    await expect(page.getByTestId("layout-diag")).toHaveCount(0); // 通常の画面には出ない
    await page.goto("/lotteries?diag=1");
    const diag = page.getByTestId("layout-diag");
    await expect(diag).toBeVisible();
    const text = diag.getByLabel("診断結果");
    await expect(text).toHaveValue(/\[mount\]/);
    await expect(text).toHaveValue(/safe\(t\/r\/b\/l\)=/);
    await expect(text).toHaveValue(/gapBottom=/);
    await expect(text).toHaveValue(/unit\(vh\/dvh\/svh\/lvh\)=/);
    // 診断パネルが下部メニューの位置を変えない
    const nav = (await page.getByTestId("bottom-nav").boundingBox())!;
    const vp = page.viewportSize()!;
    expect(Math.abs(nav.y + nav.height - vp.height)).toBeLessThan(2);
    // 最初のタッチの前後が残る
    await page.touchscreen.tap(vp.width / 2, 1); // ヘッダーの上端（何も開かない場所）
    await expect(text).toHaveValue(/touchstart\(1回目・直前\)/);
    await expect(text).toHaveValue(/touchstart\+1frame/);
    await diag.getByTestId("diag-copy").click();
    await expect(diag).toContainText(/コピーしました|コピーできませんでした/);
    // 状態は端末に保存され、ページ移動後も続く。個人情報・URLのクエリは含まない
    await page.goto("/finance");
    await expect(page.getByTestId("layout-diag")).toBeVisible();
    const report = await page.getByTestId("layout-diag").getByLabel("診断結果").inputValue();
    expect(report).not.toContain("diag=1");
    await page.goto("/lotteries?diag=off");
    await expect(page.getByTestId("layout-diag")).toHaveCount(0);
  });
});
