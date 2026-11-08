import { expect, test, type Page } from "@playwright/test";

test.beforeEach(async ({ page }, testInfo) => {
  // 抽選カードの表示を確かめる既存のテストは、旧仕様（タブが重なる）で同じ抽選を全タブから開く。タブの分類は e2e/stage6l.spec.ts で確認する
  await page.addInitScript(() => { (window as unknown as { __tcgFlatTabs: boolean }).__tcgFlatTabs = true; });
  // 既存のテストは応募済み・受付終了のカードも一覧で確認するため、状態の絞り込みを「すべて」にしておく（Stage 5M・5Pのテストは既定のまま）
  const keepDefault = (t: string) => t.includes("Stage 5M") || t.includes("Stage 5P");
  if (!testInfo.title.includes("検索は1行") && !keepDefault(testInfo.title) && !testInfo.titlePath.some(keepDefault)) {
    await page.addInitScript(() => { if (!window.sessionStorage.getItem("tcg.session.board")) window.sessionStorage.setItem("tcg.session.board", JSON.stringify({ tab: "managed", filters: { status: "any" } })); });
  }
  await page.goto("/lotteries");
  await expect(page.getByTestId("lottery-card").first()).toBeVisible();
});

/** 状態の絞り込みを「すべて」にする（既定は受付中・未応募。受付終了・応募済みのカードも見たいテスト用） */
async function showAllStatus(page: Page) {
  await openFilters(page);
  await pickFilter(page, "状態", "any");
}

/** 絞り込みシートを開く（既に開いていれば何もしない） */
async function openFilters(page: Page) {
  // 連続タップ防止（300ms）で直前の操作の直後のタップが無視されることがあるので、開くまで押し直す
  await expect(async () => {
    if (!(await page.getByTestId("filter-sheet").isVisible())) await page.getByTestId("filter-open").click();
    await expect(page.getByTestId("filter-sheet")).toBeVisible({ timeout: 1000 });
  }).toPass({ timeout: 8000 });
}

/** 絞り込みを1項目変えて「適用」する（シートが閉じていれば開く） */
async function pickFilter(page: Page, label: string, value: string | { label: string }) {
  await openFilters(page);
  await page.getByTestId("filter-sheet").getByLabel(label).selectOption(value);
  await page.getByTestId("filter-apply").click();
  await expect(page.getByTestId("filter-sheet")).toHaveCount(0);
}

async function switchProfile(page: Page, label: string) {
  await page.getByRole("button", { name: /ユーザー切り替え/ }).click();
  await page.getByRole("radio", { name: `プロフィール ${label}` }).click();
}

test("★OFFは確認ダイアログを挟み、キャンセルでは状態が変わらない", async ({ page }) => {
  const tab = page.getByRole("tab", { name: /要チェック/ });
  const before = await tab.innerText();
  const card = page.locator('[data-lottery-id="L1"]');
  await card.getByRole("button", { name: /要チェック（★）をOFF/ }).click();
  await expect(page.getByRole("dialog")).toContainText("履歴は消えません");
  await page.getByRole("button", { name: "キャンセル" }).click();
  await expect(card).toBeVisible();
  expect(await tab.innerText()).toBe(before);

  await card.getByRole("button", { name: /要チェック（★）をOFF/ }).click();
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

test("見出しと登録ボタンは1行。説明文は無く、タブは 全情報→要チェック→応募済み→当選 の順で初期は要チェック", async ({ page }) => {
  await expect(page.getByText("家族共通の抽選情報です。")).toHaveCount(0);
  const tabs = page.getByRole("tab");
  const names = (await tabs.allInnerTexts()).map((t) => t.replace(/\s*\d+(\s+\d+)?\s*$/, "").trim());
  expect(names).toEqual(["全情報", "要チェック", "応募済み", "当選"]);
  await expect(page.getByRole("tab", { name: /要チェック/ })).toHaveAttribute("aria-selected", "true");
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
  await expect(page.getByTestId("filter-sheet")).toHaveCount(0);
  await expect(page.getByLabel("系列")).toHaveCount(0);
  // 見出し・タブ・検索を含めても、最初のカードが画面の上半分に入る
  const firstCard = (await page.getByTestId("lottery-card").first().boundingBox())!;
  const vp = page.viewportSize()!;
  expect(firstCard.y).toBeLessThan(vp.height * 0.4);
  await openFilters(page);
  await expect(page.getByTestId("filter-count")).toHaveCount(0);
  await pickFilter(page, "受取方法", "store");
  await expect(page.getByTestId("filter-count")).toHaveText("1");
});

test("見出しとタブは固定され、その下だけがスクロールする。フィルター状態は再読込後も保持される", async ({ page }) => {
  const tabs = page.getByRole("tablist", { name: "抽選の表示切替" });
  const header = (await page.locator("header").boundingBox())!;
  await page.evaluate(() => document.getElementById("app-scroll")!.scrollTo(0, 400));
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
  await page.keyboard.press("Escape");
  const countOf = async () => Number((await page.getByRole("tab", { name: /要チェック/ }).innerText()).match(/(\d+)\s*$/)![1]);
  const normal = await page.getByTestId("lottery-card").count();
  await pickFilter(page, "スルー表示", "include");
  const include = await page.getByTestId("lottery-card").count();
  expect(include).toBeGreaterThanOrEqual(normal);
  await pickFilter(page, "スルー表示", "only");
  const only = await page.getByTestId("lottery-card").count();
  expect(only).toBe(include - normal);
  void countOf;
  // Bに切り替えるとBのスルー（なし）が基準になる
  await switchProfile(page, "B");
  await openFilters(page);
  await pickFilter(page, "スルー表示", "only");
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
  await expect(page.getByTestId("lottery-card").first()).toContainText("結果未確認");
  await page.getByRole("tab", { name: /当選/ }).click();
  await expect(page.getByRole("button", { name: "受取を記録" }).first()).toBeVisible();
  await page.getByRole("tab", { name: /要チェック/ }).click();
  // 既定は詳細表示。シンプルにするとコンパクトな1行カード（★・小さな画像・店名・商品名・自分の応募状態）になる
  await expect(page.getByTestId("card-simple")).toHaveCount(0);
  await page.getByRole("button", { name: "シンプル表示にする" }).click();
  await expect(page.getByRole("button", { name: "詳細表示にする" })).toBeVisible();
  await expect(page.getByTestId("card-simple").first()).toBeVisible();
  await page.waitForTimeout(350); // 表示切替は誤った連続発火を300msだけ無視する（人の操作の間隔では影響しない）
  await page.getByRole("button", { name: "詳細表示にする" }).click();
  await expect(page.getByTestId("card-simple")).toHaveCount(0);
  await page.waitForTimeout(350);
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

  // 状態の既定を「すべて」にしているため、L1は受付終了の抽選より下にある。先に表示位置へ動かしてから、その位置を基準にする
  await card.scrollIntoViewIfNeeded();
  await page.evaluate(() => document.getElementById("app-scroll")!.scrollBy(0, 120));
  const y0 = await page.evaluate(() => document.getElementById("app-scroll")!.scrollTop);
  await card.getByRole("button", { name: /の詳細を開く/ }).click();
  const sheet = page.getByTestId("lottery-detail-sheet");
  await expect(sheet).toBeVisible();
  await expect(page.getByTestId("lottery-detail")).toContainText("応募締切");
  await expect(page.getByTestId("user-section")).toBeVisible(); // 応募状況（アイコン＋状態マーク、応募操作）
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
  await expect.poll(async () => Math.abs((await page.evaluate(() => document.getElementById("app-scroll")!.scrollTop)) - y0)).toBeLessThan(4);
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

test("複数商品の抽選は、一覧では先頭1種類＋「＋他N種」に集約し、詳細パネルで全商品と方式を確認できる", async ({ page }) => {
  const card = page.locator('[data-lottery-id="L3"]');
  // 既定の詳細表示でも、カード上は先頭の商品だけ。残りは「＋他1種」
  await expect(card.getByTestId("extra-kinds")).toHaveText("＋他1種");
  await expect(card.getByTestId("lottery-items")).not.toContainText("ほしぞら");
  await expect(card.getByTestId("product-name")).toHaveCount(1);
  await card.getByRole("button", { name: /の詳細を開く/ }).click();
  const detail = page.getByTestId("lottery-detail");
  await expect(detail.getByTestId("lottery-items").getByRole("listitem")).toHaveCount(2);
  await expect(detail.getByTestId("lottery-items")).toContainText("ほしぞら");
  await expect(detail).toContainText("商品ごとに当落");
  await page.keyboard.press("Escape");
  // シンプル表示でも同じ（先頭1種類＋「＋他N種」）
  await page.getByRole("button", { name: "シンプル表示にする" }).click();
  await expect(card.getByTestId("extra-kinds")).toHaveText("＋他1種");
  await expect(card).not.toContainText("ほしぞら");
});

test("応募済み・当選タブの赤丸は、未対応がある場合に表示される", async ({ page }) => {
  await expect(page.getByTestId("tab-dot-won")).toBeVisible(); // Aは当選済みで購入未完了（L7）
});

test("日付のみの締切は、23:59などの時刻を補わず、日付の差だけでバッジを出す", async ({ page }) => {
  const card = page.locator('[data-lottery-id="L3"]');
  await expect(card.getByTestId("deadline-badge")).toHaveText("あと2日");
  await expect(card.getByTestId("deadline-badge")).toHaveAttribute("data-tone", "warn"); // 3日未満はオレンジ
  await expect(card.getByTestId("deadline-badge")).toHaveAttribute("title", /時刻は未確認/);
  await expect(card).not.toContainText("23:59");
  // 一覧では時刻を出さず日付だけ（「—」でも0:00でもない）。詳細にも「時刻未確認」は出さない（内部では時刻不明のまま保持）
  await expect(card.getByLabel(/応募締切 .*時刻未確認/)).toBeVisible();
  await card.getByRole("button", { name: /の詳細を開く/ }).click();
  await expect(page.getByTestId("lottery-detail")).not.toContainText("時刻未確認");
  await expect(page.getByTestId("lottery-detail")).toContainText(/\d+\/\d+/);
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
  // 収入タブには売却名義人の絞り込み（行ではなく、絞り込みアイコンの画面の中）
  await expect(page.getByRole("group", { name: "売却名義人で絞り込み" })).toHaveCount(0);
  await page.getByTestId("finance-filter-open").click();
  await expect(page.getByRole("group", { name: "売却名義人で絞り込み" })).toBeVisible();
  await page.getByTestId("finance-filter-done").click();
  // 収入・支出・すべてを切り替えても、収支ページに文字リンク・購入履歴のアイコンは無い
  await expect(page.getByTestId("to-purchases")).toHaveCount(0);
  await expect(page.getByRole("navigation", { name: "関連ページ" })).toHaveCount(0);
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
    if (vp.width >= 768) {
      // PC（Stage 6P）: 左サイドメニューは無く、モバイルと同じ入れ物の最下段に下部メニューを置く。アイコン＋名称で全機能を並べ、コンテンツを隠さない
      await expect(page.locator("aside")).toHaveCount(0);
      await expect(page.getByTestId("bottom-nav")).toBeHidden();
      const pc = page.getByTestId("bottom-nav-pc");
      await expect(pc).toBeVisible();
      const links = pc.getByRole("link");
      expect(await links.count()).toBeGreaterThanOrEqual(5);
      expect(await links.count()).toBeLessThanOrEqual(8);
      for (const l of await links.all()) {
        await expect(l.locator("svg")).toHaveCount(1);
        expect(((await l.textContent()) ?? "").trim().length).toBeGreaterThan(0);
      }
      const box = (await pc.boundingBox())!;
      expect(Math.abs(box.y + box.height - vp.height)).toBeLessThanOrEqual(1); // 画面の下端に接する
      await page.evaluate(() => { const s = document.getElementById("app-scroll")!; s.scrollTo(0, s.scrollHeight); });
      const lastCard = (await page.getByTestId("lottery-card").last().boundingBox())!;
      expect(lastCard.y + lastCard.height).toBeLessThanOrEqual(box.y + 1);
      return;
    }
    const nav = page.getByTestId("bottom-nav");
    // ナビの操作行（3.25rem）は余白を除いてコンパクト
    const row = (await nav.locator("> div").boundingBox())!;
    expect(row.height).toBeLessThanOrEqual(56);
    // 最下部までスクロールしたとき、最後のカードがナビの下に隠れない
    await page.evaluate(() => { const s = document.getElementById("app-scroll")!; s.scrollTo(0, s.scrollHeight); });
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
  // 初期表示は商品別の累計（左のタブ）。上部は BOX・パック・その他商品・総額の4項目（Stage 7E）
  await expect(page.getByRole("tab", { name: "商品別の累計" })).toHaveAttribute("aria-selected", "true");
  await expect(page.getByTestId("product-total-row").first()).toBeVisible();
  await expect(page.getByTestId("purchase-summary").locator("dt")).toHaveText(["BOX", "パック", "その他商品", "総額"]);
  // 購入履歴（右のタブ）。日付見出しは無く、1件ごとのカードに購入日がある
  await page.getByRole("tab", { name: "購入履歴" }).click();
  const rows = page.getByTestId("purchase-row");
  await expect(rows.first()).toBeVisible();
  await expect(rows.first().getByTestId("purchase-date")).toBeVisible();
  await expect(page.getByTestId("to-collection")).toHaveCount(0);
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

test("抽選カード右上は受取方法で決まる（店頭=受取店舗の都道府県、発送=通販）。距離は店舗名の右（通販は出さない）", async ({ page }) => {
  await page.getByRole("tab", { name: /全情報/ }).click();
  // 地域の既定は関西3県。東京の店舗も確認するため、地域を「すべて」にする（通販・所在地不明は地域では除外されない）
  await page.getByTestId("filter-open").click();
  await page.getByTestId("f-region-all").click();
  await page.getByTestId("filter-apply").click();
  await expect(page.getByTestId("filter-sheet")).toHaveCount(0);
  // 店頭受取（三宮店・自宅の近く）: 都道府県。距離はカードに出さない
  const near = page.getByTestId("lottery-card").filter({ hasText: "三宮店" }).first();
  await expect(near.getByTestId("place-chip")).toContainText("兵庫県");
  await expect(near.getByTestId("place-chip")).not.toContainText("通販");
  // 通販（L4）は距離を出さない
  await expect(page.locator('[data-lottery-id="L4"]').getByTestId("distance")).toHaveCount(0);
  // 受取方法が発送の抽選（L4）は、店舗が登録されていても「通販」
  const ship = page.locator('[data-lottery-id="L4"]');
  await expect(ship.getByTestId("place-chip")).toHaveText("通販");
  // 東京の店舗（店頭受取）は都道府県
  const tokyo = page.getByTestId("lottery-card").filter({ hasText: "本店" }).first();
  await expect(tokyo.getByTestId("place-chip")).toContainText("東京都");
  // 店舗名 → 都道府県 → 距離 の順（同じ行か、狭いときは次の行）
  await expect(tokyo.getByTestId("distance")).toContainText("km");
  const [sn, pc, ds] = [(await tokyo.getByTestId("store-name").boundingBox())!, (await tokyo.getByTestId("place-chip").boundingBox())!, (await tokyo.getByTestId("distance").boundingBox())!];
  expect(pc.y > sn.y + sn.height / 2 || pc.x >= sn.x + sn.width - 1).toBe(true);
  expect(ds.y > pc.y + pc.height / 2 || ds.x >= pc.x + pc.width - 1).toBe(true);
  // 詳細パネルでは位置情報（直線距離・交通費）を引き続き確認できる（道路距離と混同しない表記）
  await tokyo.getByRole("button", { name: /の詳細を開く/ }).click();
  await expect(page.getByTestId("lottery-detail")).toContainText("直線");
  await expect(page.getByTestId("lottery-detail")).toContainText("往復交通費");
  await page.keyboard.press("Escape");
  // 受取場所ラベルは商品画像と重ならない
  const [img, pl] = [(await tokyo.getByTestId("card-image").boundingBox())!, (await tokyo.getByTestId("place-chip").boundingBox())!];
  const overlap = pl.x < img.x + img.width && img.x < pl.x + pl.width && pl.y < img.y + img.height && img.y < pl.y + pl.height;
  expect(overlap).toBe(false);
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
    await expect(card.getByLabel("ユーザー別の応募状況")).toHaveCount(0); // 全員分の状態は出さない
    await expect(card.getByTestId("my-apply")).toHaveCount(1); // 現在のユーザーの応募操作だけ
    await expect(card.getByTestId("card-deadline")).toBeVisible(); // 締切は一覧でも出す
    await expect(card.getByRole("button", { name: /要チェック（★）をOFF/ })).toBeVisible();
  });
});

test.describe("Stage 5I: 抽選カードの整理（締切バッジ・応募状況・応募操作）", () => {
  test("締切までの残り時間は下段の応募ボタンのすぐ左のバッジ。段階（3日未満=オレンジ／24時間未満=赤）が色と文言で分かる。商品名は最大2行", async ({ page }) => {
    const card = page.locator('[data-lottery-id="L1"]'); // 締切まで約5時間
    const badge = card.getByTestId("deadline-badge");
    await expect(badge).toHaveText(/^あと\d+時間$/);
    await expect(badge).toHaveAttribute("data-tone", "danger");
    // 右側: カードの右半分で、下段（操作ボタンの行）にあり、ボタンのすぐ左。ボタンとは重ならず、同じ行に並ぶ
    const cb = (await card.boundingBox())!;
    const bb = (await badge.boundingBox())!;
    const btn = (await card.getByTestId("my-apply").boundingBox())!;
    expect(bb.x + bb.width / 2).toBeGreaterThan(cb.x + cb.width / 2);
    expect(bb.x + bb.width).toBeLessThanOrEqual(btn.x + 1);
    expect(Math.abs(bb.y + bb.height / 2 - (btn.y + btn.height / 2))).toBeLessThanOrEqual(btn.height / 2);
    const sep = (await card.getByTestId("card-bottom").boundingBox())!;
    expect(bb.y).toBeGreaterThanOrEqual(sep.y - 1);
    expect(btn.height).toBeGreaterThanOrEqual(32); // ボタンは押しやすい高さのまま
    // 商品名は最大2行（line-clamp）
    const name = (await card.getByTestId("product-name").boundingBox())!;
    expect(name.height).toBeLessThanOrEqual(2 * 22);
    // 3日未満・3日以上
    await expect(page.locator('[data-lottery-id="L3"]').getByTestId("deadline-badge")).toHaveAttribute("data-tone", "warn");
  });

  test("プロフィール別の応募状況は表示専用（押しても変わらない）。応募操作は現在のプロフィール専用で、解除は確認つき", async ({ page }) => {
    const card = page.locator('[data-lottery-id="L4"]'); // A・Bとも未応募
    const status = card.getByTestId("apply-status");
    await expect(status).toBeVisible();
    // 表示専用: ボタンではない
    await expect(status.getByRole("button")).toHaveCount(0);
    const aMark = status.locator('[data-account="a-c3"]');
    const bMark = status.locator('[data-account="b-c3"]');
    await expect(aMark).toHaveAttribute("data-status", "eligible_unapplied");
    await expect(bMark).toHaveAttribute("data-status", "eligible_unapplied");
    await bMark.click(); // カードの一部なので詳細が開くだけ。応募状態は変わらない
    await expect(page.getByTestId("lottery-detail")).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.getByTestId("lottery-detail")).toHaveCount(0);
    await expect(bMark).toHaveAttribute("data-status", "eligible_unapplied");

    // 現在のプロフィール(A)だけが応募済みになる
    const mine = card.getByTestId("my-apply");
    await expect(mine).toHaveAttribute("data-account", "a-c3");
    await mine.click();
    await expect(aMark).toHaveAttribute("data-status", "applied");
    await expect(bMark).toHaveAttribute("data-status", "eligible_unapplied");
    await expect(mine).toHaveAttribute("data-state", "applied");

    // 解除は確認つき。キャンセルでは変わらない
    await mine.click();
    await expect(page.getByRole("dialog")).toContainText("応募済みを解除しますか");
    await page.getByRole("button", { name: "キャンセル" }).click();
    await expect(aMark).toHaveAttribute("data-status", "applied");
    await mine.click();
    await page.getByRole("button", { name: "解除する" }).click();
    await expect(aMark).toHaveAttribute("data-status", "eligible_unapplied");

    // Bに切り替えると、操作対象はBのアカウントだけ
    await switchProfile(page, "B");
    await expect(card.getByTestId("my-apply")).toHaveAttribute("data-account", "b-c3");
    await card.getByTestId("my-apply").click();
    await expect(card.getByTestId("apply-status").locator('[data-account="b-c3"]')).toHaveAttribute("data-status", "applied");
    await expect(card.getByTestId("apply-status").locator('[data-account="a-c3"]')).toHaveAttribute("data-status", "eligible_unapplied");
  });

  test("発表前の応募済みに『未確認』は出さない。商品ごとのプロフィール・未確認の表示を一覧に繰り返さない", async ({ page }) => {
    await page.getByRole("tab", { name: /全情報/ }).click();
    const card = page.locator('[data-lottery-id="L3"]'); // 複数商品（発表前）
    await expect(card).not.toContainText("未確認");
    await expect(card.getByTestId("item-result-tag")).toHaveCount(0);
    await expect(card.getByTestId("apply-status")).toHaveCount(1); // 抽選単位に1行
  });

  test("シンプル表示にも締切と残り時間を出し、商品名は2行まで。高さは詳細表示より低い", async ({ page }) => {
    const detailH = (await page.locator('[data-lottery-id="L1"]').boundingBox())!.height;
    await page.getByRole("button", { name: "シンプル表示にする" }).click();
    const card = page.locator('[data-lottery-id="L1"]');
    await expect(card.getByTestId("card-deadline")).toContainText(/\d+\/\d+/);
    await expect(card.getByTestId("deadline-badge")).toHaveText(/^あと/);
    const simpleH = (await card.boundingBox())!.height;
    expect(simpleH).toBeLessThan(detailH);
    expect(simpleH).toBeLessThan(100);
    const name = (await card.getByTestId("product-name").boundingBox())!;
    expect(name.height).toBeLessThanOrEqual(2 * 22);
  });
});

test("Stage 5I: 詳細カードの応募状況の行と右下の応募ボタンは重ならず、カードの外にはみ出さない", async ({ page }) => {
  for (const id of ["L1", "L3", "L4"]) {
    const card = page.locator(`[data-lottery-id="${id}"]`);
    const c = (await card.boundingBox())!;
    // 行の枠は右の余白(応募ボタンの場所)を含むので、実際に並ぶ丸いマークの範囲で比べる
    const marks = await card.getByTestId("apply-status").locator("[data-account]").evaluateAll((els) => els.map((e) => { const r = e.getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height }; }));
    const s = { x: Math.min(...marks.map((m) => m.x)), y: Math.min(...marks.map((m) => m.y)), width: Math.max(...marks.map((m) => m.x + m.width)) - Math.min(...marks.map((m) => m.x)), height: Math.max(...marks.map((m) => m.y + m.height)) - Math.min(...marks.map((m) => m.y)) };
    const b = (await card.getByTestId("my-apply").boundingBox())!;
    // 横に重ならない（同じ高さの帯にあるときは左右に分かれている）
    const sameBand = s.y < b.y + b.height && b.y < s.y + s.height;
    if (sameBand) expect(s.x + s.width).toBeLessThanOrEqual(b.x + 1);
    // カードの中に収まる
    expect(b.x + b.width).toBeLessThanOrEqual(c.x + c.width);
    expect(b.y + b.height).toBeLessThanOrEqual(c.y + c.height + 1);
  }
  await page.evaluate(() => { const n = document.querySelector('[data-testid="bottom-nav"]') as HTMLElement | null; if (n) n.style.display = "none"; }); // 撮影のときだけ下部メニューを隠す
  await page.locator('[data-lottery-id="L3"]').screenshot({ path: "e2e/.results/stage5i-card-detail.png" });
  await page.getByRole("button", { name: "シンプル表示にする" }).click();
  await page.locator('[data-lottery-id="L3"]').screenshot({ path: "e2e/.results/stage5i-card-simple.png" });
});

test("Stage 5N: 当選タブのカードはコンパクト。下段は1行で、次の期限と現在のユーザー用の「受取を記録」だけ（応募ボタンは出ない）", async ({ page }) => {
  await page.getByRole("tab", { name: /当選/ }).click();
  const card = page.getByTestId("lottery-card").first();
  await expect(card.getByTestId("my-apply")).toHaveCount(0);
  const row = card.getByTestId("won-row");
  await expect(row).toBeVisible();
  const box = (await row.boundingBox())!;
  expect(box.height).toBeLessThanOrEqual(60); // 縦に並ぶ操作ボタンで高くならない
  const label = (await row.getByTestId("won-label").boundingBox())!;
  const btn = (await row.getByRole("button", { name: "受取を記録" }).boundingBox())!;
  const overlap = label.x < btn.x + btn.width && btn.x < label.x + label.width && label.y < btn.y + btn.height && btn.y < label.y + label.height;
  expect(overlap).toBe(false);
  await row.getByRole("button", { name: "受取を記録" }).click({ trial: true }); // 他の要素に遮られていない
  const id = await card.getAttribute("data-lottery-id");
  await row.getByRole("button", { name: "受取を記録" }).click();
  // 受取が済んだ当選は当選タブの一覧から外れる（Stage 7B。記録は残る）
  await expect(page.locator(`[data-lottery-id="${id}"]`)).toHaveCount(0);
});

test("Stage 5N: 応募済みタブは発表日基準。「応募済み」ボタンの代わりに当選/落選ボタンがあり、発表日を示す（日付は太字にしない）", async ({ page }) => {
  await page.getByRole("tab", { name: /応募済み/ }).click();
  const card = page.getByTestId("lottery-card").first();
  await expect(card.getByTestId("my-apply")).toHaveCount(0);
  await expect(card.getByTestId("result-won")).toBeVisible();
  await expect(card.getByTestId("result-lost")).toBeVisible();
  await expect(card.getByTestId("result-day")).toBeVisible();
  const weight = await card.getByTestId("result-day").evaluate((el) => Number(getComputedStyle(el).fontWeight));
  expect(weight).toBeLessThan(700); // 日付は太字にしない（締切警告のバッジは別）
  const id = await card.getAttribute("data-lottery-id");
  await card.getByTestId("result-lost").click();
  // 記録した本人の結果は「落選」表示になる（他のユーザーが結果待ちなら残り、全員確定なら応募済み(結果待ち)から外れる）
  const same = page.locator(`[data-lottery-id="${id}"]`);
  await expect.poll(async () => (await same.count()) === 0 || (await same.getByTestId("my-result").first().innerText()).includes("落選")).toBe(true);
});

test.describe("表示領域・固定配置・多重反応（iPhone不具合の修正の回帰）", () => {
  const vpBottom = (page: Page) => page.evaluate(() => (window.visualViewport ? window.visualViewport.offsetTop + window.visualViewport.height : window.innerHeight));

  test("下部メニューは表示領域の下端に接し、下側の点を別の要素が覆っていない（ライト・ダーク）", async ({ page, isMobile }) => {
    test.skip(!isMobile, "下部メニューはスマホ幅のみ");
    for (const theme of ["light", "dark"] as const) {
      await page.emulateMedia({ colorScheme: theme });
      await page.reload();
      await expect(page.getByTestId("bottom-nav")).toBeVisible();
      const nav = (await page.getByTestId("bottom-nav").boundingBox())!;
      expect(Math.abs(nav.y + nav.height - (await vpBottom(page)))).toBeLessThan(1.5);
      // 下側（下端の6px上）をいちばん手前で受けるのはメニュー自身
      const covered = await page.evaluate(() => {
        const n = document.querySelector('[data-testid="bottom-nav"]')!;
        const r = n.getBoundingClientRect();
        const hit = document.elementFromPoint(r.left + r.width / 2, Math.min(r.bottom, window.innerHeight) - 6);
        return hit ? !n.contains(hit) : true;
      });
      expect(covered).toBe(false);
    }
  });

  test("下部メニューは測定に依存しない: 補正用の変数が残っていても、表示領域の高さが変わっても、常に表示領域の下端に接する", async ({ page, isMobile }) => {
    test.skip(!isMobile, "下部メニューはスマホ幅のみ");
    // 古い仕組みの補正値が残っていた状態を再現しても、メニューは動かない（位置は補正値ではなくレイアウトで決まる）
    await page.evaluate(() => {
      document.documentElement.style.setProperty("--vp-gap", "59px");
      document.documentElement.style.setProperty("--vv-shift", "-40px");
    });
    const check = async () => {
      const nav = (await page.getByTestId("bottom-nav").boundingBox())!;
      expect(Math.abs(nav.y + nav.height - (await vpBottom(page)))).toBeLessThan(1.5);
    };
    await check();
    // 表示領域が変わる（起動直後の低い状態→通常、キーボード、向き）。メニューは追従して下端に接し続ける
    const vp = page.viewportSize()!;
    for (const h of [vp.height - 59, vp.height - 300, vp.height]) {
      await page.setViewportSize({ width: vp.width, height: h });
      await page.waitForTimeout(80);
      await check();
    }
  });

  test("ページ全体はスクロールしない。スクロールするのは中身だけで、動かしてもヘッダー・下部メニューの位置は変わらない（バウンスがメニューへ伝わらない構造）", async ({ page, isMobile }) => {
    test.skip(!isMobile, "下部メニューはスマホ幅のみ");
    const before = {
      nav: (await page.getByTestId("bottom-nav").boundingBox())!,
      header: (await page.locator("header").boundingBox())!,
    };
    const m = await page.evaluate(() => {
      const s = document.getElementById("app-scroll")!;
      const de = document.documentElement;
      return { docScrollable: de.scrollHeight > de.clientHeight + 1, bodyScrollable: document.body.scrollHeight > window.innerHeight + 1, inner: s.scrollHeight > s.clientHeight, overflowY: getComputedStyle(s).overflowY };
    });
    expect(m.docScrollable, "ページ全体（document）がスクロールしない").toBe(false);
    expect(m.inner).toBe(true);
    expect(m.overflowY).toBe("auto");
    await page.evaluate(() => { const s = document.getElementById("app-scroll")!; s.scrollTo(0, s.scrollHeight); });
    await page.waitForTimeout(100);
    const after = { nav: (await page.getByTestId("bottom-nav").boundingBox())!, header: (await page.locator("header").boundingBox())! };
    expect(after.nav).toEqual(before.nav);
    expect(after.header).toEqual(before.header);
    expect(await page.evaluate(() => window.scrollY)).toBe(0);
    expect(await page.evaluate(() => getComputedStyle(document.getElementById("app-scroll")!).overscrollBehaviorY)).toBe("contain");
  });

  test("ボトムシート: 最下部までスクロールしても最後の操作が表示領域内にあり、覆われない。キーボードが隠す分(--kb-inset)だけ上がり、閉じて開き直しても同じ", async ({ page, isMobile }) => {
    test.skip(!isMobile, "ボトムシートはスマホ幅");
    const card = page.locator('[data-lottery-id="L1"]');
    for (let round = 0; round < 2; round++) {
      await card.getByRole("button", { name: /の詳細を開く/ }).click();
      const sheet = page.getByTestId("lottery-detail-sheet");
      await expect(sheet).toBeVisible();
      await page.getByTestId("lottery-detail").evaluate((el) => el.scrollTo({ top: el.scrollHeight }));
      // 下端: シートは表示領域の下端に接する
      await expect
        .poll(async () => {
          const b = (await sheet.boundingBox())!; // 開くアニメーションが終わるまで待つ
          return Math.abs(b.y + b.height - (await vpBottom(page)));
        })
        .toBeLessThan(1.5);
      // 最後のボタンが表示領域内にあり、そこをタップすると、そのボタン自身が受ける
      const last = page.getByTestId("lottery-detail").getByRole("button").last();
      const lb = (await last.boundingBox())!;
      expect(lb.y + lb.height).toBeLessThanOrEqual((await vpBottom(page)) + 0.5);
      const ok = await last.evaluate((el) => {
        const r = el.getBoundingClientRect();
        const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
        return !!hit && el.contains(hit);
      });
      expect(ok).toBe(true);
      // キーボードが300px隠している状態: シートの下端が300px上がり、最後のボタンはその上に出る
      await page.waitForTimeout(4500); // 測り直しの期間が終わってから（測り直し中は実測値で上書きされる）
      await page.evaluate(() => document.documentElement.style.setProperty("--kb-inset", "300px"));
      await expect
        .poll(async () => {
          const b = (await sheet.boundingBox())!;
          return Math.round((await vpBottom(page)) - (b.y + b.height));
        })
        .toBe(300);
      await page.getByTestId("lottery-detail").evaluate((el) => el.scrollTo({ top: el.scrollHeight }));
      const lb2 = (await last.boundingBox())!;
      expect(lb2.y + lb2.height).toBeLessThanOrEqual((await vpBottom(page)) - 300 + 0.5);
      await page.evaluate(() => document.documentElement.style.removeProperty("--kb-inset"));
      await page.keyboard.press("Escape");
      await expect(sheet).toHaveCount(0);
    }
  });

  test("表示切替は1回のタップで1回だけ切り替わる。素早い二重タップでも二重に切り替わらない（300ms）", async ({ page }) => {
    const toggle = page.getByTestId("view-toggle");
    await expect(toggle).toHaveAttribute("aria-pressed", "true");
    await toggle.dblclick({ delay: 30 }); // 2回のタップが約30ms間隔
    await expect(toggle).toHaveAttribute("aria-pressed", "false"); // 1回分だけ切り替わる
    await page.waitForTimeout(400);
    await expect(toggle).toHaveAttribute("aria-pressed", "false");
    // 300ms以上あけたタップは通常どおり戻る
    await toggle.click();
    await expect(toggle).toHaveAttribute("aria-pressed", "true");
  });

  test("応募済みの二重タップで、意図せず解除されない（解除は確認ダイアログを経由する）", async ({ page }) => {
    const card = page.locator('[data-lottery-id="L4"]');
    const mine = card.getByTestId("my-apply");
    await mine.dblclick({ delay: 20 });
    await expect(mine).toHaveAttribute("data-state", "applied");
    await page.keyboard.press("Escape"); // 2回目のタップが開いた確認を閉じる
    await expect(mine).toHaveAttribute("data-state", "applied");
  });
});

test.describe("Stage 5J: カードの重なり・詳細の整理・ブランドカラー・入力時の拡大抑制", () => {
  type Box = { x: number; y: number; width: number; height: number };
  const overlap = (a: Box, b: Box) => a.x < b.x + b.width - 0.5 && b.x < a.x + a.width - 0.5 && a.y < b.y + b.height - 0.5 && b.y < a.y + a.height - 0.5;

  test("狭い画面(幅320)・長い店舗名/商品名でも、詳細カード内の要素は重ならず、横にはみ出さない", async ({ page }) => {
    await page.setViewportSize({ width: 320, height: 740 });
    await page.getByRole("tab", { name: /全情報/ }).click();
    // 店舗名・商品名を極端に長くして確認する（表示だけを書き換える）
    await page.evaluate(() => {
      document.querySelectorAll('[data-testid="card-place"] > span:first-child').forEach((e) => (e.textContent = "とても長い系列名のサンプル電機株式会社 超大型旗艦店 梅田本館"));
      document.querySelectorAll('[data-testid="product-name"]').forEach((e) => (e.textContent = "30th CELEBRATION カードセット フシギダネ・ヒトカゲ・ゼニガメ・ピカチュウ・イーブイ・ミュウ特別限定版"));
    });
    const cards = page.getByTestId("lottery-card");
    const n = await cards.count();
    expect(n).toBeGreaterThan(3);
    for (let i = 0; i < n; i++) {
      const c = cards.nth(i);
      const cb = (await c.boundingBox())!;
      const box = async (id: string) => ((await c.getByTestId(id).count()) > 0 ? c.getByTestId(id).first().boundingBox() : null);
      const parts: Record<string, Box | null> = {
        place: await box("card-place"),
        badge: await box("deadline-badge"),
        image: await box("card-image"),
        product: await box("lottery-items"),
        status: await box("apply-status"),
        mine: await box("my-apply"),
      };
      const entries = Object.entries(parts).filter(([, b]) => !!b) as [string, Box][];
      for (let a = 0; a < entries.length; a++) {
        for (let b = a + 1; b < entries.length; b++) {
          expect(overlap(entries[a][1], entries[b][1]), `カード${i}: ${entries[a][0]} と ${entries[b][0]} が重なっている`).toBe(false);
        }
        expect(entries[a][1].x + entries[a][1].width, `カード${i}: ${entries[a][0]} が右にはみ出している`).toBeLessThanOrEqual(cb.x + cb.width + 0.5);
        expect(entries[a][1].x, `カード${i}: ${entries[a][0]} が左にはみ出している`).toBeGreaterThanOrEqual(cb.x - 0.5);
      }
      expect(await c.evaluate((el) => el.scrollWidth <= el.clientWidth + 1)).toBe(true);
    }
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true); // ページ全体も横スクロールしない
  });

  test("プロフィール3人の応募状況は表示順どおりに並び、応募ボタンと同じ行に収まる", async ({ page }) => {
    const card = page.locator('[data-lottery-id="L1"]');
    const marks = card.getByTestId("apply-status").locator("[data-account]");
    expect(await marks.count()).toBe(3);
    const xs = await marks.evaluateAll((els) => els.map((e) => e.getBoundingClientRect().x));
    expect([...xs].sort((a, b) => a - b)).toEqual(xs); // 左から A, B, C
    const labels = await marks.evaluateAll((els) => els.map((e) => e.getAttribute("aria-label")?.slice(0, 1)));
    expect(labels).toEqual(["A", "B", "C"]);
    const bottom = (await card.getByTestId("card-bottom").boundingBox())!;
    const mine = (await card.getByTestId("my-apply").boundingBox())!;
    expect(mine.y).toBeGreaterThanOrEqual(bottom.y - 0.5);
    expect(mine.y + mine.height).toBeLessThanOrEqual(bottom.y + bottom.height + 0.5);
  });

  test("詳細: 常時の操作は［スルー］（と編集）だけ。その他は折りたたみで、中止は確認を挟む。応募状況は1行＋展開で、要確認は1つにまとめる", async ({ page }) => {
    const card = page.locator('[data-lottery-id="L1"]');
    await card.getByRole("button", { name: /の詳細を開く/ }).click();
    const sheet = page.getByTestId("lottery-detail");
    const main = sheet.getByTestId("main-ops");
    await expect(main.getByRole("button", { name: /スルー/ })).toBeVisible();
    const more = sheet.getByTestId("more-ops");
    await expect(more.getByRole("button", { name: "中止にする" })).toBeHidden(); // 折りたたみ
    await expect(more.getByRole("button", { name: "発表延期にする" })).toBeHidden();
    await more.locator("summary").click();
    await expect(more.getByRole("button", { name: "発表延期にする" })).toBeVisible();
    await more.getByRole("button", { name: "中止にする" }).click();
    await expect(page.getByRole("dialog").filter({ hasText: "中止にしますか" })).toBeVisible(); // 確認ダイアログ
    await page.getByRole("button", { name: "キャンセル" }).click();
    await expect(page.locator('[data-lottery-id="L1"]')).not.toContainText("中止");
    // 応募状況: 通常は1行。理由の一覧は展開
    const user = sheet.getByTestId("user-section");
    await expect(user.getByTestId("apply-status")).toBeVisible();
    await expect(user.getByTestId("judge-list")).toBeHidden();
    await user.getByTestId("user-details").locator("summary").click();
    await expect(user.getByTestId("judge-list")).toBeVisible();
    // 同じ要確認の理由を全ユーザー分繰り返さない
    const review = user.getByTestId("review-summary");
    if (await review.count()) {
      const text = (await review.innerText()).replace("要確認:", "");
      const parts = text.split("／").map((x) => x.trim()).filter(Boolean);
      expect(new Set(parts).size).toBe(parts.length);
    }
  });

  test("ブランドカラーはライト・ダークとも同じオレンジ系。警告の赤・成功の緑は別の色のまま", async ({ page }) => {
    const hue = async () =>
      page.evaluate(() => {
        const c = getComputedStyle(document.documentElement);
        const to = (v: string) => {
          const el = document.createElement("div");
          el.style.color = v;
          document.body.appendChild(el);
          const rgb = getComputedStyle(el).color.match(/\d+/g)!.map(Number);
          el.remove();
          const [r, g, b] = rgb;
          const max = Math.max(r, g, b), min = Math.min(r, g, b), d = max - min;
          const h = d === 0 ? 0 : max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
          return Math.round(((h * 60 + 360) % 360));
        };
        return { primary: to(c.getPropertyValue("--primary")), danger: to(c.getPropertyValue("--danger")), success: to(c.getPropertyValue("--success")) };
      });
    for (const scheme of ["light", "dark"] as const) {
      await page.emulateMedia({ colorScheme: scheme });
      await page.reload();
      const h = await hue();
      expect(h.primary, `${scheme}のプライマリ色相`).toBeGreaterThanOrEqual(15); // 赤茶(≈14°)ではなくオレンジ(≈20〜30°)
      expect(h.primary).toBeLessThanOrEqual(35);
      expect(Math.abs(h.primary - h.danger)).toBeGreaterThan(8); // 危険操作の赤とは区別できる
      expect(h.success).toBeGreaterThan(100);
    }
  });

  test("入力欄をタップしても自動で拡大されないよう、viewport で最大倍率を1に固定している", async ({ page }) => {
    const content = await page.locator('meta[name="viewport"]').getAttribute("content");
    expect(content).toContain("maximum-scale=1");
    expect(content).toContain("user-scalable=no");
    expect(content).toContain("viewport-fit=cover"); // Safe Areaの指定は変えていない
  });
});

test.describe("Stage 5K: カードの再配置・テーマカラー", () => {
  test("店舗名と商品名の左端が揃い、店舗名は最大2行。残り時間・距離・応募ボタンが重ならない（320px）", async ({ page }) => {
    await page.setViewportSize({ width: 320, height: 800 });
    await page.getByRole("tab", { name: /全情報/ }).click();
    const cards = page.getByTestId("lottery-card");
    const n = await cards.count();
    expect(n).toBeGreaterThan(0);
    const overlap = (a: { x: number; y: number; width: number; height: number }, b: typeof a) =>
      a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
    for (let i = 0; i < n; i++) {
      const c = cards.nth(i);
      const box = async (id: string) => ((await c.getByTestId(id).count()) ? await c.getByTestId(id).first().boundingBox() : null);
      const store = await box("store-name");
      const prod = await box("product-name");
      const badge = await box("deadline-badge");
      const btn = await box("my-apply");
      const dist = await box("distance");
      const chip = await box("place-chip");
      // 系列ロゴがあるときは、ロゴの左端が商品名の左端と揃う（店舗名はその右）
      const logo = await box("chain-logo");
      if (store && prod) expect(Math.abs((logo ?? store).x - prod.x)).toBeLessThanOrEqual(1);
      if (store) expect(store.height).toBeLessThanOrEqual(2 * 20);
      if (badge && btn) expect(overlap(badge, btn)).toBe(false);
      if (dist && chip) expect(overlap(dist, chip)).toBe(false);
      if (dist && prod) expect(overlap(dist, prod)).toBe(false);
      const cb = (await c.boundingBox())!;
      for (const b of [store, prod, badge, btn, dist, chip]) if (b) expect(b.x + b.width).toBeLessThanOrEqual(cb.x + cb.width + 1);
    }
  });

  test("ライトの主要色は黄寄りのオレンジ（塗り）＋白文字。文字・線用のオレンジは別変数で十分なコントラスト", async ({ page }) => {
    const v = await page.evaluate(() => {
      const cs = getComputedStyle(document.documentElement);
      return { p: cs.getPropertyValue("--primary").trim(), fg: cs.getPropertyValue("--primary-foreground").trim(), ink: cs.getPropertyValue("--primary-ink").trim() };
    });
    const rgb = (h: string) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
    const lum = ([r, g, b]: number[]) => {
      const f = (x: number) => ((x /= 255) <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4);
      return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
    };
    const cr = (a: string, b: string) => {
      const [x, y] = [lum(rgb(a)), lum(rgb(b))];
      return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
    };
    const [r, g] = rgb(v.p);
    expect(g / r).toBeGreaterThan(0.5); // 赤寄りではない（黄みが十分）
    expect(v.fg).toMatch(/^#f{3}(f{3})?$/i);
    expect(cr(v.p, "#ffffff")).toBeGreaterThanOrEqual(3.1); // 塗りの上の白文字（太字・大きめの文字の基準 3:1 以上。通常文字の 4.5:1 には届かない）
    expect(cr(v.ink, "#ffffff")).toBeGreaterThanOrEqual(4.5); // 白背景の上の文字・線
  });
});

test.describe("Stage 5K 追加: ライトの色の質感", () => {
  test("残り日数バッジ: 3日以上=ティール／3日未満=オレンジの枠＋文字（塗りは応募ボタン専用）／24時間未満=赤塗り＋白文字。★は縁取りなし", async ({ page }) => {
    const css = (loc: ReturnType<typeof page.locator>, k: "backgroundColor" | "color") => loc.evaluate((e, key) => getComputedStyle(e)[key as "color"], k);
    const L1 = page.locator('[data-lottery-id="L1"]').getByTestId("deadline-badge"); // danger
    const L3 = page.locator('[data-lottery-id="L3"]').getByTestId("deadline-badge"); // warn
    const varColor = (n: string) => page.evaluate((v) => { const d = document.createElement("i"); d.style.color = `var(${v})`; document.body.append(d); const c = getComputedStyle(d).color; d.remove(); return c; }, n);
    const mine = page.locator('[data-lottery-id="L4"]').getByTestId("my-apply");
    // 応募ボタン（未応募）はブランドの塗り。注意バッジはそれと同じ塗りにしない
    expect(await css(L3, "backgroundColor")).not.toBe(await varColor("--primary"));
    expect(await css(L3, "color")).toBe(await varColor("--primary-ink"));
    expect(await css(L1, "backgroundColor")).toBe(await varColor("--danger"));
    expect(await css(L1, "color")).toBe("rgb(255, 255, 255)");
    expect(await mine.count()).toBeGreaterThan(0);
    // 3日以上はティール
    const far = page.getByTestId("deadline-badge").filter({ hasText: /あと([3-9]|d{2,})日/ }).first();
    if (await far.count()) expect(await css(far, "color")).toBe(await varColor("--info"));
    // ★: 縁取りの色が塗りと同じ（別色の縁取りなし）
    const star = page.locator('[data-lottery-id="L1"]').getByRole("button", { name: /要チェック（★）/ }).locator("svg").first();
    const [f, s] = await star.evaluate((e) => [getComputedStyle(e).fill, getComputedStyle(e).stroke]);
    expect(f).toBe(s);
  });
});

test.describe("Stage 5L: 通販区分・標準分類の表示", () => {
  test("店頭・発送から選べる抽選は都道府県＋「発送可」。発送のみは「通販」で距離なし。店頭受取は都道府県（Web応募でも通販にしない）", async ({ page }) => {
    await page.getByRole("tab", { name: /全情報/ }).click();
    const either = page.locator('[data-lottery-id="L3"]'); // 受取方法=店頭・発送から選択
    await expect(either.getByTestId("place-chip")).not.toHaveText("通販");
    await expect(either.getByTestId("ship-chip")).toHaveText("発送可");
    const ship = page.locator('[data-lottery-id="L4"]'); // 発送のみ
    await expect(ship.getByTestId("place-chip")).toHaveText("通販");
    await expect(ship.getByTestId("distance")).toHaveCount(0);
    await expect(ship.getByTestId("ship-chip")).toHaveCount(0);
    const store = page.locator('[data-lottery-id="L1"]'); // 店頭受取（応募方法=Web）
    await expect(store.getByTestId("place-chip")).not.toHaveText("通販");
    await expect(store.getByTestId("ship-chip")).toHaveCount(0);
  });

  test("詳細: 分類が無い既存データは、発表方法・応募条件の文章をそのまま表示（元の文章を失わない）", async ({ page }) => {
    const card = page.locator('[data-lottery-id="L1"]');
    await card.getByRole("button", { name: /の詳細を開く/ }).click();
    const sheet = page.getByTestId("lottery-detail");
    await expect(sheet).toContainText("会員登録済みであること");
    await expect(sheet.getByTestId("requirement-label")).toHaveCount(0);
    await expect(sheet.getByTestId("announce-label")).toHaveCount(0);
  });
});

test.describe("Stage 5M: 抽選UI改善", () => {
  const card = (page: Page, id: string) => page.locator(`[data-lottery-id="${id}"]`);

  test("詳細: 発表方法は1つ（補足つき）、通常の本人確認は表示せず特殊な本人確認と会員証は表示、備考は箇条書き", async ({ page }) => {
    await page.getByRole("tab", { name: /全情報/ }).click();
    await showAllStatus(page);
    await card(page, "L2").getByRole("button", { name: /の詳細を開く/ }).click();
    const sheet = page.getByTestId("lottery-detail");
    await expect(sheet.getByTestId("announce-label")).toHaveCount(1);
    await expect(sheet.getByTestId("announce-label")).toHaveText("当落メール");
    await expect(sheet).toContainText("LivePocketのマイページでも確認可能");
    const labels = await sheet.getByTestId("requirement-label").allInnerTexts();
    expect(labels).toContain("会員証・ポイントカード");
    expect(labels).toContain("その他本人確認");
    expect(labels).not.toContain("身分証提示");
    expect(labels).not.toContain("顔写真付き身分証");
    // 元の文章（原文）は残っている
    await sheet.getByText("補足・原文").click();
    await expect(sheet).toContainText("顔写真付き身分証が必要");
    const items = sheet.getByTestId("notes-list").getByRole("listitem");
    await expect(items).toHaveCount(3);
    await expect(items.nth(1)).toHaveText("当選後のキャンセル不可");
  });

  test("未応募は「－」、応募済みはチェック。プロフィールの色（アバター）は維持される", async ({ page }) => {
    const row = card(page, "L4").getByTestId("apply-status");
    const mine = row.locator('[data-status="eligible_unapplied"]').first();
    await expect(mine.getByTestId("unapplied-mark")).toHaveCount(0); // 詳細カードの未応募は従来どおり「－」（丸の「未」はシンプル表示だけ）
    await expect(mine.locator("svg.lucide-minus")).toHaveCount(1);
    await expect(row.locator("svg.lucide-circle")).toHaveCount(0);
    await expect(mine.locator("span").first()).toBeVisible(); // プロフィールのアバター
  });

  test("要チェックは既定で「受付中・未応募」。応募直後は約0.6秒そのまま表示し、右へ約0.32秒でスライドしてから一覧が詰まる", async ({ page }) => {
    const c = card(page, "L4");
    await expect(c).toBeVisible();
    // 退出の段階（hold → sliding → collapsing）を記録する。待機約0.6秒 → スライド約0.32秒 → 約0.28秒で一覧が詰まる
    await page.evaluate(() => {
      const w = window as unknown as { __exits: string[] };
      w.__exits = [];
      new MutationObserver((ms) => ms.forEach((m) => w.__exits.push(`${(m.target as HTMLElement).dataset.exit ?? ""}`))).observe(document.body, { attributes: true, subtree: true, attributeFilter: ["data-exit"] });
    });
    const t0 = Date.now();
    await c.getByTestId("my-apply").click();
    await expect(c.getByTestId("my-apply")).toHaveAttribute("data-state", "applied");
    await page.waitForTimeout(250);
    await expect(c).toBeVisible();
    await expect(c.locator("xpath=ancestor::li[1]")).toHaveAttribute("data-exit", "hold");
    // スライド中: 高さは変えず、カードはまだ画面にあり、右へ動いている途中（残像が右端に残らない）
    // スライドは約0.32秒と短いので、フレームごとに監視して捉える
    await page.waitForFunction(() => document.querySelector('[data-lottery-id="L4"]')?.closest("li")?.getAttribute("data-exit") === "sliding", null, { polling: "raf", timeout: 3000 });
    const slideStart = Date.now();
    const li = c.locator("xpath=ancestor::li[1]");
    const h0 = (await li.boundingBox())!.height;
    await page.waitForTimeout(100);
    expect(Math.abs((await li.boundingBox())!.height - h0)).toBeLessThanOrEqual(1); // スライド中は一覧を詰めない
    const midX = (await c.boundingBox())!.x;
    expect(midX).toBeGreaterThan(0); // 少し動いている（移動中）
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true); // 横スクロールが出ない
    await expect(c).toHaveCount(0, { timeout: 4000 });
    expect(Date.now() - t0).toBeGreaterThanOrEqual(600 + 320); // 待機0.6秒＋スライド0.32秒のあとに消える
    expect(Date.now() - slideStart).toBeGreaterThanOrEqual(450); // スライド＋詰める時間（一瞬で消えない）
    expect(await page.evaluate(() => (window as unknown as { __exits: string[] }).__exits)).toEqual(expect.arrayContaining(["hold", "sliding", "collapsing"]));
    // 応募済みタブには表示される（他のタブの表示は変わらない）
    await page.getByRole("tab", { name: /応募済み/ }).click();
    await expect(card(page, "L4")).toBeVisible();
  });

  test("待機中に応募を解除すると退場せず、未応募のまま残る", async ({ page }) => {
    const c = card(page, "L4");
    await c.getByTestId("my-apply").click();
    await expect(c.getByTestId("my-apply")).toHaveAttribute("data-state", "applied");
    await c.getByTestId("my-apply").click();
    await page.getByRole("button", { name: "解除する" }).click();
    await expect(c.getByTestId("my-apply")).toHaveAttribute("data-state", "unapplied");
    await page.waitForTimeout(3300);
    await expect(c).toBeVisible();
    await expect(c.locator("xpath=ancestor::li[1]")).not.toHaveAttribute("data-exit", /.+/);
  });

  test("待機中にプロフィールを切り替えると、古いタイマーで別プロフィールのカードが消えない", async ({ page }) => {
    const c = card(page, "L4");
    await c.getByTestId("my-apply").click();
    await expect(c.getByTestId("my-apply")).toHaveAttribute("data-state", "applied");
    await switchProfile(page, "B");
    await expect(page.locator("header").getByTestId("current-profile")).toHaveText("B");
    await expect(c.getByTestId("my-apply")).toHaveAttribute("data-state", "unapplied");
    await page.waitForTimeout(3300);
    await expect(c).toBeVisible();
  });

  test("状態を「すべて」に切り替えると、応募済みのカードが退場せずに残る。設定は保持され、「受付中・未応募」に戻せる", async ({ page }) => {
    await openFilters(page);
    await pickFilter(page, "状態", "any");
    const c = card(page, "L4");
    await c.getByTestId("my-apply").click();
    await expect(c.getByTestId("my-apply")).toHaveAttribute("data-state", "applied");
    await page.waitForTimeout(3300);
    await expect(c).toBeVisible();
    // 「受付中・未応募」に戻すと、応募済みのカードは（待たずに）隠れる
    await pickFilter(page, "状態", "default");
    await expect(card(page, "L4")).toHaveCount(0);
    // 再読み込みしても設定は保持される
    await pickFilter(page, "状態", "any");
    await page.reload();
    await openFilters(page);
    await expect(page.getByTestId("filter-sheet").getByLabel("状態")).toHaveValue("any");
  });

  test("系列ロゴ: 店舗名の左に20px四方で表示し、カードの高さを増やさない。未登録の系列は従来表示。ダークでも白いタイルで識別できる", async ({ page }) => {
    await page.getByRole("tab", { name: /全情報/ }).click();
    await showAllStatus(page);
    const withLogo = card(page, "L1");
    const logo = withLogo.getByTestId("chain-logo");
    await expect(logo).toBeVisible();
    const box = (await logo.boundingBox())!;
    expect(Math.round(box.width)).toBe(20);
    expect(Math.round(box.height)).toBe(20);
    const nameBox = (await withLogo.getByTestId("store-name").boundingBox())!;
    expect(box.x + box.width).toBeLessThanOrEqual(nameBox.x + 1); // 店舗名の左
    await expect(card(page, "L3").getByTestId("chain-logo")).toHaveCount(0);
    // 場所の行の高さ（ロゴなしの行と同じ程度）
    const rowH = (await withLogo.getByTestId("card-place").boundingBox())!.height;
    const noLogoH = (await card(page, "L3").getByTestId("card-place").boundingBox())!.height;
    expect(rowH - noLogoH).toBeLessThanOrEqual(2);
    await page.emulateMedia({ colorScheme: "dark" });
    await expect(logo).toHaveCSS("background-color", "rgb(255, 255, 255)");
    expect(await logo.evaluate((el) => getComputedStyle(el).objectFit)).toBe("contain");
  });
});

test.describe("Stage 4C: NEW表示", () => {
  test("全情報タブに、まだ確認していない新着の件数が出る（トレマネが新規に把握した抽選が対象）", async ({ page }) => {
    // 新着(L5)はAがスルー中の店舗のため、通常表示ではAの一覧とバッジに含めない（スルー表示は全タブ共通）。スルーしていないBで確認する
    await switchProfile(page, "B");
    const badge = page.getByRole("tab", { name: /全情報/ }).getByTestId("tab-new");
    await expect(badge).toHaveText("新1"); // 「NEW」の文字は出さず、小さな件数バッジだけ
    await expect(page.getByRole("tab", { name: /全情報/ })).not.toContainText("NEW");
    // 新着の抽選のカードにはNEW。受付開始日ではなく、把握した日時で決まる印
    await page.getByRole("tab", { name: /全情報/ }).click();
    await expect(page.getByTestId("lottery-card").filter({ hasText: "NEW" }).first()).toBeVisible();
  });
});

test.describe("Stage 5P: 状態絞り込み・タブ・カード・サブユーザー", () => {
  const card = (page: Page, id: string) => page.locator(`[data-lottery-id="${id}"]`);
  const status = async (page: Page, value: string) => {
    await openFilters(page);
    await pickFilter(page, "状態", value);
  };

  test("全情報の既定は「受付中・未応募」。受付終了と応募済みは出ず、状態を変えると表示できる（応募済みは現在のプロフィール基準）", async ({ page }) => {
    await page.getByRole("tab", { name: /全情報/ }).click();
    await expect(card(page, "L4")).toBeVisible(); // 受付中・未応募
    await expect(card(page, "L6")).toHaveCount(0); // 受付終了
    await expect(card(page, "L2")).toHaveCount(0); // Aは応募済み
    await openFilters(page);
    // 状態は絞り込み項目の一番左
    await expect(page.getByTestId("filter-sheet").locator("select").first()).toHaveAccessibleName("状態");
    await pickFilter(page, "状態", "closed");
    await expect(card(page, "L6")).toBeVisible();
    await expect(card(page, "L4")).toHaveCount(0);
    await pickFilter(page, "状態", "applied");
    await expect(card(page, "L2")).toBeVisible();
    await pickFilter(page, "状態", "any");
    await expect(card(page, "L6")).toBeVisible();
    await expect(card(page, "L2")).toBeVisible();
    // プロフィールBでは、Aが応募済みのL2も未応募として既定の一覧に出る
    await pickFilter(page, "状態", "default");
    await expect(card(page, "L2")).toHaveCount(0);
    await switchProfile(page, "B");
    await expect(page.locator("header").getByTestId("current-profile")).toHaveText("B");
    await expect(card(page, "L2")).toBeVisible();
  });

  test("要チェックでは、★が付いていない抽選は状態を「すべて」にしても表示しない。系列など他の条件と組み合わせられる", async ({ page }) => {
    await page.getByRole("tab", { name: /要チェック/ }).click();
    await status(page, "any");
    await expect(card(page, "L5")).toHaveCount(0); // ★なし
    await expect(card(page, "L6")).toBeVisible(); // ★あり・受付終了
    await pickFilter(page, "系列", { label: "モデル家電" });
    await expect(card(page, "L6")).toHaveCount(0); // 別の系列
    await expect(card(page, "L3")).toBeVisible();
  });

  test("タブ: 「NEW」の文字は出さず小さな件数バッジ。赤丸はタブ名の左（文字に重ねない）", async ({ page }) => {
    await switchProfile(page, "B"); // 新着(L5)はAがスルー中の店舗のため、スルーしていないBで確認する
    const all = page.getByRole("tab", { name: /全情報/ });
    await expect(all).not.toContainText("NEW");
    await expect(all.getByTestId("tab-new")).toBeVisible();
    const tabBox = (await all.boundingBox())!;
    expect(tabBox.height).toBeLessThanOrEqual(40);
    const applied = page.getByRole("tab", { name: /応募済み/ });
    const dot = applied.getByTestId("tab-dot-applied");
    await expect(dot).toBeVisible();
    const t = (await applied.boundingBox())!;
    const d = (await dot.boundingBox())!;
    // タブ名の左側（同じ行）。文字・件数と重ならず、タブの左端からは離れる
    const row = (await applied.locator("span.inline-flex").first().boundingBox())!;
    const count = (await applied.getByTestId("tab-count-applied").boundingBox())!;
    expect(d.x).toBeGreaterThanOrEqual(t.x + 2);
    expect(d.x + d.width).toBeLessThanOrEqual(row.x + row.width / 2);
    expect(d.y + d.height).toBeLessThanOrEqual(count.y + 1);
    expect(Math.abs(d.y + d.height / 2 - (row.y + row.height / 2))).toBeLessThanOrEqual(3);
  });

  test("応募済みタブ: 左=発表日／右=購入期間（応募締切は出さない）。落選が左・当選（オレンジ）が右", async ({ page }) => {
    await page.getByRole("tab", { name: /応募済み/ }).click();
    const c = page.getByTestId("lottery-card").first();
    await expect(c.getByTestId("result-day")).toHaveText(/^\d+\/\d+\([日月火水木金土]\)|発表日未確認/); // 「発表」の文字は出さず、アイコンで示す
    // 「購入」「受取」の文字は出さず、小さなアイコンで示す（意味はタップ長押し/title と詳細で確認）
    await expect(c.getByTestId("period")).not.toContainText(/購入|受取/);
    await expect(c.getByTestId("period")).toHaveAttribute("data-kind", /^(購入|受取)$/);
    await expect(c.getByTestId("period").locator("svg")).toHaveCount(1);
    await expect(c.getByTestId("deadline-day")).toHaveCount(0);
    await expect(c).not.toContainText("締切");
    const day = (await c.getByTestId("result-day").boundingBox())!;
    const period = (await c.getByTestId("period").boundingBox())!;
    expect(Math.abs(period.y - day.y)).toBeLessThan(6); // 発表日と期間は同じ1行（左=発表日、右=期間）。日付は途中で折り返さない
    expect(period.x).toBeGreaterThan(day.x + day.width - 1);
    expect(day.height).toBeLessThan(22);
    expect(period.height).toBeLessThan(22);
    const lost = (await c.getByTestId("result-lost").boundingBox())!;
    const won = (await c.getByTestId("result-won").boundingBox())!;
    expect(lost.x + lost.width).toBeLessThanOrEqual(won.x + 1);
    await expect(c.getByTestId("result-won")).toHaveClass(/bg-primary/);
  });

  test("詳細カード: 日付は曜日つき。左=抽選締切／右=購入期間。★は左上の端、未応募は「－」", async ({ page }) => {
    await page.getByRole("tab", { name: /全情報/ }).click();
    const c = card(page, "L4");
    await expect(c.getByTestId("deadline-day")).toContainText(/\d+\/\d+\([日月火水木金土]\)/);
    const dl = (await c.getByTestId("deadline-day").boundingBox())!;
    const pe = (await c.getByTestId("period").boundingBox())!;
    expect(Math.abs(pe.y - dl.y)).toBeLessThan(6); // 抽選締切と購入期間は同じ1行（左=締切、右=期間）
    expect(pe.x).toBeGreaterThan(dl.x + dl.width - 1);
    expect(dl.height).toBeLessThan(22);
    expect(pe.height).toBeLessThan(22);
    await expect(c.getByTestId("apply-status").getByTestId("unapplied-mark")).toHaveCount(0); // 詳細カードの未応募は「－」
    await expect(c.getByTestId("apply-status").locator('[data-status="eligible_unapplied"] svg.lucide-minus').first()).toBeVisible();
    const cb = (await c.boundingBox())!;
    const star = (await c.getByTestId("card-star").boundingBox())!;
    expect(star.x - cb.x).toBeLessThan(8);
    expect(star.y - cb.y).toBeLessThan(8);
  });

  test("サブユーザー: C（対象系列=サンプル電機のみ）には対象系列の抽選だけ。他のユーザーの画面では、対象外の系列のカードにCのアイコンを出さない", async ({ page }) => {
    await page.getByRole("tab", { name: /全情報/ }).click();
    await status(page, "any");
    // メイン(A)から見る: サンプル電機(L1)にはA・B・C、モデル家電(L3)にはA・Bだけ
    await expect(card(page, "L1").getByTestId("apply-status").locator("[data-account]")).toHaveCount(3);
    await expect(card(page, "L3").getByTestId("apply-status").locator("[data-account]")).toHaveCount(2);
    await expect(card(page, "L3").getByTestId("apply-status").locator('[data-account^="c-"]')).toHaveCount(0);
    // サブ(C)に切り替える: 対象系列の抽選だけ表示される
    await switchProfile(page, "C");
    await expect(page.locator("header").getByTestId("current-profile")).toHaveText("C");
    await expect(card(page, "L1")).toBeVisible();
    await expect(card(page, "L3")).toHaveCount(0);
    const chains = await page.getByTestId("lottery-card").evaluateAll((els) => els.map((e) => e.getAttribute("data-lottery-id")));
    expect(chains.length).toBeGreaterThan(0);
    expect(chains).not.toContain("L3");
  });
});

test.describe("Stage 5Q: 見出し・収支の年月選択・シンプルカードの幅", () => {
  test("応募済みタブのシンプルカードは画面幅に収まり、横スクロールが出ない", async ({ page }) => {
    await page.getByRole("button", { name: "シンプル表示にする" }).click();
    await page.getByRole("tab", { name: /応募済み/ }).click();
    await expect(page.getByTestId("card-simple").first()).toBeVisible();
    const bad = await page.evaluate(() => {
      const w = document.documentElement.clientWidth;
      return { scroll: document.documentElement.scrollWidth > w + 1, over: [...document.querySelectorAll('[data-testid="lottery-card"]')].filter((c) => c.getBoundingClientRect().right > w + 1).length };
    });
    expect(bad).toEqual({ scroll: false, over: 0 });
  });

  test("ページ見出しは下部メニューと同じアイコン付きで、ページ間で同じ高さに表示される", async ({ page }) => {
    const top = async (path: string) => {
      await page.goto(path);
      const h = page.getByRole("heading", { level: 1 }).first();
      await expect(h.locator("svg")).toHaveCount(1);
      return Math.round((await h.boundingBox())!.y);
    };
    const a = await top("/lotteries");
    const b = await top("/purchases");
    const c = await top("/finance");
    expect(b).toBe(a);
    expect(c).toBe(a);
  });

  test("収支: 年月をタップして月を選ぶと、その月へ直接移動する。購入履歴へのアイコンリンクがあり、当選率の文字リンクはない", async ({ page }) => {
    await page.goto("/finance");
    await expect(page.getByTestId("month-label")).toBeVisible();
    await page.getByTestId("month-label").click();
    await page.getByRole("button", { name: "前の年" }).click();
    await page.getByRole("button", { name: "3月" }).click();
    const y = new Date().getFullYear() - 1;
    await expect(page.getByTestId("month-label")).toHaveText(`${y}年3月`);
    await expect(page.getByTestId("to-analysis")).toHaveAttribute("href", "/finance/analysis");
    await expect(page.getByRole("link", { name: /当選/ })).toHaveCount(0);
  });

  test("説明のⓘは「補足」の文字を出さない", async ({ page }) => {
    await expect(page.getByText("補足", { exact: true })).toHaveCount(0);
  });
});

// ---------------------------------------------------------------- Stage 5Z: 日付行は必ず1行（折り返し・はみ出しを成功扱いにしない）
test.describe("Stage 5Z 日付の1行表示", () => {
  const ids = ["date-row", "deadline-day", "period", "result-day", "simple-deadline"];
  let twoInRow = 0;
  /** 現在の画面の日付行を検査し、検査した行数を返す（twoInRow=2種類の日時が同じ行に並んだカード数） */
  async function checkRows(page: Page, label: string): Promise<number> {
    let checked = 0;
    twoInRow = 0;
    const cards = page.getByTestId("lottery-card");
    const n = await cards.count();
    for (let i = 0; i < n; i++) {
      const c = cards.nth(i);
      const cb = (await c.boundingBox())!;
      for (const id of ids) {
        const rows = c.getByTestId(id);
        for (let k = 0; k < (await rows.count()); k++) {
          const r = rows.nth(k);
          const b = (await r.boundingBox())!;
          const lh = await r.evaluate((e) => parseFloat(getComputedStyle(e).lineHeight) || parseFloat(getComputedStyle(e).fontSize) * 1.4);
          expect(b.height, `${label}/${id} 高さ`).toBeLessThan(lh * 1.6); // 折り返すと2行分以上になる
          expect(b.x + b.width, `${label}/${id} 右端`).toBeLessThanOrEqual(cb.x + cb.width + 0.5);
          expect(await r.evaluate((e) => e.scrollWidth <= e.clientWidth + 1), `${label}/${id} 内容幅`).toBe(true);
          checked++;
        }
      }
      // 合格条件: 詳細カードの日時情報（2種類）は同じ行にある（縦に分かれていない）
      const dr = c.getByTestId("date-row");
      if ((await dr.count()) > 0) {
        const items = dr.first().locator('[data-testid="deadline-day"], [data-testid="result-day"], [data-testid="period"]');
        const boxes = await items.evaluateAll((els) => els.map((e) => { const r = e.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height }; }));
        for (const b of boxes) expect(Math.abs(b.y - boxes[0].y), `${label} 日時が同じ行にない`).toBeLessThan(4);
        for (let k = 1; k < boxes.length; k++) expect(boxes[k].x, `${label} 日時が重なっている`).toBeGreaterThanOrEqual(boxes[k - 1].x + boxes[k - 1].w - 1);
        if (boxes.length >= 2) twoInRow++;
      }
    }
    return checked;
  }

  for (const width of [320, 375, 390, 430]) {
    test(`${width}px: 詳細・シンプルの全タブで、日付行が折り返さずカード幅からはみ出さない（長い店舗名でも）`, async ({ page }) => {
      await page.setViewportSize({ width, height: 800 });
      let total = 0;
      let pairs = 0;
      for (const detail of [true, false]) {
        const toggle = page.getByTestId("view-toggle");
        if ((await toggle.getAttribute("aria-pressed")) !== String(detail)) {
          await toggle.click();
          await expect(toggle).toHaveAttribute("aria-pressed", String(detail));
          await page.waitForTimeout(350);
        }
        for (const tab of [/全情報/, /要チェック/, /応募済み/, /当選/]) {
          await page.getByRole("tab", { name: tab }).click();
          await page.evaluate(() => {
            for (const e of document.querySelectorAll<HTMLElement>('[data-testid="store-name"]')) e.textContent = "とても長い系列名の長い長い店舗名 ○○駅前ショッピングセンター店 本館2階";
          });
          total += await checkRows(page, `${detail ? "詳細" : "シンプル"}/${tab}`);
          if (detail) pairs += twoInRow;
        }
      }
      expect(total, "検査した日付行が0件（空振り）").toBeGreaterThan(10);
      expect(pairs, "2種類の日時が同じ行に並んだカードが0件（空振り）").toBeGreaterThan(0);
    });
  }

  test("収まらない2種類の日時は、日付行全体の文字サイズが縮小されて同じ1行に収まる（一部だけ小さくならない）", async ({ page }) => {
    await page.setViewportSize({ width: 320, height: 800 });
    await page.getByRole("tab", { name: /全情報/ }).click();
    const row = page.getByTestId("date-row").filter({ has: page.locator('[data-testid="deadline-day"]') }).filter({ hasText: /\d+\/\d+.*\d+\/\d+/ }).first();
    const before = await row.evaluate((e) => parseFloat(getComputedStyle(e).fontSize));
    // 利用できる幅を狭めて（日付行の必要幅の8割に固定）、収まらない状況を作る。幅の変化で測り直される（日付の桁数で必要幅が変わるため固定値にしない）
    const needed = await row.evaluate((e) => e.scrollWidth);
    await row.evaluate((e, w) => { e.parentElement!.style.width = `${w}px`; }, Math.max(100, Math.floor(needed * 0.8)));
    await expect.poll(async () => row.evaluate((e) => e.scrollWidth <= e.parentElement!.clientWidth + 1)).toBe(true);
    const after = await row.evaluate((e) => parseFloat(getComputedStyle(e).fontSize));
    expect(after).toBeLessThan(before); // 日付行全体の文字サイズを縮小（アイコンは em 指定で同じ比率）
    expect(after).toBeGreaterThanOrEqual(8);
    expect((await row.boundingBox())!.height).toBeLessThan(after * 1.8); // 折り返していない
    const ys = await row.locator("[data-testid]").evaluateAll((els) => els.map((e) => e.getBoundingClientRect().y));
    for (const y of ys) expect(Math.abs(y - ys[0])).toBeLessThan(4); // 2種類の日時は同じ行のまま
  });
});

test.describe("優先収集メモの廃止（Stage 6L）", () => {
  test("メモのアイコンは無く、＋登録は抽選情報の登録を直接開く。320pxでもはみ出さない", async ({ page }) => {
    await page.setViewportSize({ width: 320, height: 740 });
    await expect(page.getByTestId("memo-open")).toHaveCount(0);
    await expect(page.getByLabel("優先収集メモを登録")).toHaveCount(0);
    const reg = page.getByTestId("register");
    // モックはデモデータ（保存されない）のため＋登録は出ない場合がある。出るときだけ動作を確認する
    if ((await reg.count()) === 0) {
      test.skip(true, "デモデータでは＋登録を表示しない");
      return;
    }
    const rb = (await reg.boundingBox())!;
    expect(rb.x + rb.width).toBeLessThanOrEqual(320);
    await reg.click();
    await expect(page.getByRole("dialog")).toBeVisible();
    await expect(page.getByTestId("register-chooser")).toHaveCount(0);
  });
});
