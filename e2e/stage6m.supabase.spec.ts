import { createClient } from "@supabase/supabase-js";
import { expect, test, type Page } from "@playwright/test";

/**
 * Stage 6M の画面確認（実Supabaseのテスト世帯・架空データ）。
 *   E2E_SPEC=stage6m.supabase.spec.ts npm run test:e2e:supabase
 *  - コレクションのカード／BOX切替（タブ）と、BOXの手動登録・集計（購入=購入時点の市場相場／買取=現在の参考相場）・並び順
 *  - 購入記録（BOX）の登録で所有数が増え、収支の支出は実際の購入価格のまま
 *  - 開封済みにする・取り消し
 */
const email = process.env.E2E_EMAIL!;
const password = process.env.E2E_PASSWORD!;
const admin = () => createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false, autoRefreshToken: false } });

async function login(page: Page) {
  await page.goto("/login");
  await page.getByLabel("メールアドレス").fill(email);
  await page.getByLabel("パスワード").fill(password);
  await page.getByRole("button", { name: "ログイン" }).click();
  await expect(page).toHaveURL(/\/lotteries$/);
}

/** 左右スワイプ（タッチイベント）でカード／BOXを切り替える */
async function swipe(page: Page, dir: "left" | "right") {
  await page.getByTestId("collection-swipe").evaluate((el, d) => {
    const r = el.getBoundingClientRect();
    const y = r.top + 60;
    const [x0, x1] = d === "left" ? [r.left + r.width * 0.8, r.left + r.width * 0.3] : [r.left + r.width * 0.2, r.left + r.width * 0.7];
    const mk = (x: number) => new Touch({ identifier: 1, target: el, clientX: x, clientY: y });
    el.dispatchEvent(new TouchEvent("touchstart", { bubbles: true, cancelable: true, touches: [mk(x0)], changedTouches: [mk(x0)] }));
    el.dispatchEvent(new TouchEvent("touchend", { bubbles: true, cancelable: true, touches: [], changedTouches: [mk(x1)] }));
  }, dir);
}

async function household(): Promise<string> {
  const a = admin();
  const { data: list } = await a.auth.admin.listUsers({ perPage: 200 });
  const user = list?.users.find((u) => u.email === email);
  if (!user) throw new Error("test user not found");
  const { data: hm } = await a.from("household_members").select("household_id").eq("user_id", user.id).limit(1).maybeSingle();
  if (!hm) throw new Error("household not found");
  return hm.household_id;
}

test("コレクション: カード／BOXの切替。BOXの手動登録・集計・並び順・開封と取り消し", async ({ page }) => {
  test.setTimeout(120_000);
  await login(page);
  const hid = await household();
  const a = admin();
  const mk = async (name: string, release: string) => {
    const { data, error } = await a.from("products").insert({ household_id: hid, official_name: name, packs_per_box: 30, release_date: release }).select("id").single();
    expect(error).toBeNull();
    return data!.id as string;
  };
  const pA = await mk("6Mテラスタルフェスex", "2024-12-06");
  const pB = await mk("6Mステラミラクル", "2024-07-19");

  await page.goto("/collection");
  // 初期はカード。タブでBOXへ（BOXは空）
  await expect(page.getByTestId("collection-hub")).toHaveAttribute("data-tab", "card");
  await swipe(page, "left");
  await expect(page.getByTestId("collection-hub")).toHaveAttribute("data-tab", "box");
  await expect(page.getByTestId("box-empty")).toBeVisible();
  await expect(page.getByTestId("add-card")).toHaveText("＋登録");

  // 手動登録（シュリンクあり2BOX・実購入5,400円・購入時の市場相場12,000円）
  await page.getByTestId("add-card").click();
  const form = page.getByTestId("box-form");
  await expect(form.getByTestId("register-kind")).toBeVisible(); // 上部でカード／BOXを切り替えられる
  await form.getByLabel("BOXの商品").fill("6Mテラスタルフェスex");
  await form.getByRole("option", { name: /6Mテラスタルフェスex/ }).click();
  await form.getByLabel("シュリンク状態").selectOption("shrink");
  await form.getByLabel("BOXの数量").fill("2");
  await form.getByLabel("実際の購入価格").fill("5400");
  await form.locator("summary").click();
  await form.getByLabel("購入時点の市場相場").fill("12000");
  await form.getByLabel("市場相場の取得元").fill("E2E相場表");
  await form.getByLabel("市場相場の基準日").fill("2026-11-01");
  await form.getByTestId("box-dialog-save").click();
  await expect(form).toHaveCount(0);
  await expect(page.getByTestId("box-tile")).toHaveCount(1);
  await expect(page.getByTestId("box-tile-qty")).toHaveText("×2");
  // 購入=購入時点の市場相場×2（実購入価格ではない）。買取は相場が未取得なので「—」
  await expect(page.getByTestId("box-summary-line")).toContainText("購入 24,000円");
  await expect(page.getByTestId("box-summary-line")).toContainText("買取 —");
  await expect(page.getByTestId("box-summary-line")).toContainText("2BOX");

  // 2商品目: 状態未確認1BOX
  await page.getByTestId("add-card").click();
  const f2 = page.getByTestId("box-form");
  await f2.getByLabel("シュリンク状態").selectOption("unknown"); // 初期値は「シュリンクあり」（Stage 6P）
  await f2.getByLabel("BOXの商品").fill("6Mステラミラクル");
  await f2.getByRole("option", { name: /6Mステラミラクル/ }).click();
  await f2.getByLabel("実際の購入価格").fill("7000");
  await f2.getByTestId("box-dialog-save").click();
  await expect(page.getByTestId("box-tile")).toHaveCount(2);
  await expect(page.getByTestId("box-tile-unknown")).toHaveCount(1);

  // 相場を更新（手動）: 買取 = 10,000円×2 ＋ 5,000円×1
  await page.getByTestId("market-update-open").click();
  const prices = page.getByTestId("box-price-dialog");
  await prices.getByLabel("6Mテラスタルフェスexの相場").fill("10000");
  await prices.getByLabel("6Mステラミラクルの相場").fill("5000");
  await prices.getByTestId("box-dialog-save").click();
  await expect(prices).toHaveCount(0);
  await expect(page.getByTestId("box-summary-line")).toContainText("買取 25,000円");
  await expect(page.getByTestId("box-price-date")).toBeVisible();

  // 並び順は初期が価格の高い順。発売日の古い順に変える
  await expect(page.getByTestId("box-sort")).toHaveValue("priceDesc");
  const firstName = () => page.getByTestId("box-tile").first().getByRole("button").first().getAttribute("aria-label");
  expect(await firstName()).toContain("テラスタルフェスex");
  await page.getByTestId("box-sort").selectOption("releaseAsc");
  expect(await firstName()).toContain("ステラミラクル");
  // カードのページには影響しない
  await swipe(page, "right");
  await expect(page.getByTestId("collection-hub")).toHaveAttribute("data-tab", "card");
  await swipe(page, "left");
  await expect(page.getByTestId("box-sort")).toHaveValue("releaseAsc"); // ページごとに独立して保持される

  // 詳細: 状態別の数量と評価。シュリンクなしは基準×85%で評価（ここではシュリンクあり）
  await page.getByTestId("box-tile").filter({ hasText: "テラスタルフェスex" }).getByRole("button").first().click();
  const detail = page.getByTestId("box-detail");
  await expect(detail.getByTestId("state-shrink")).toContainText("2BOX");
  await expect(detail.getByTestId("box-lot")).toContainText("12,000円");
  // 開封済みにする（1BOX）→ 所有数1。履歴の取り消しで2に戻る
  await detail.getByTestId("box-open-btn").click();
  await page.getByTestId("box-open-dialog").getByLabel("開封する数量").fill("1");
  await page.getByTestId("box-open-dialog").getByTestId("box-dialog-save").click();
  await expect(detail.getByTestId("state-shrink")).toContainText("1BOX");
  await detail.getByTestId("undo-op").first().click();
  await expect(detail.getByTestId("state-shrink")).toContainText("2BOX");

  // 後片付け（テスト世帯のデータ。履歴は追記のみなので、掃除は世帯の削除時に行われる）
  await a.from("box_prices").delete().eq("household_id", hid);
});

test("購入記録（BOX）の登録で所有数が増え、収支の支出は実際に支払った額のまま", async ({ page }) => {
  test.setTimeout(120_000);
  await login(page);
  const hid = await household();
  const a = admin();
  const { data: prod, error } = await a.from("products").insert({ household_id: hid, official_name: "6M購入連動BOX", packs_per_box: 30, list_price_box: 5400 }).select("id").single();
  expect(error).toBeNull();
  await page.goto("/finance");
  await page.getByRole("button", { name: "＋支出" }).click();
  await page.getByLabel("商品1").fill("6M購入連動BOX");
  await page.getByRole("option", { name: /6M購入連動BOX/ }).click();
  await page.getByLabel("数量1").fill("2");
  await page.getByLabel("購入金額1").fill("10800");
  await page.getByRole("button", { name: "保存" }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  // 収支の支出は実際の購入金額
  await expect(page.getByTestId("ledger-row").filter({ hasText: "6M購入連動BOX" })).toContainText("10,800");

  await page.goto("/collection?tab=box");
  await expect(page.getByTestId("collection-hub")).toHaveAttribute("data-tab", "box");
  const tile = page.getByTestId("box-tile").filter({ hasText: "6M購入連動BOX" });
  await expect(tile).toHaveCount(1);
  await expect(tile.getByTestId("box-tile-qty")).toHaveText("×2");
  await expect(tile.getByTestId("box-tile-unknown")).toBeVisible(); // 受取前は状態未確認
  // 購入記録の数量を直すと所有数も追従する（二重加算しない）
  await page.goto("/purchases");
  await page.getByTestId("purchase-row").filter({ hasText: "6M購入連動BOX" }).click();
  await page.getByLabel("数量1").fill("3");
  await page.getByRole("button", { name: "保存" }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await page.goto("/collection?tab=box");
  await expect(page.getByTestId("box-tile").filter({ hasText: "6M購入連動BOX" }).getByTestId("box-tile-qty")).toHaveText("×3");
  void prod;
});
