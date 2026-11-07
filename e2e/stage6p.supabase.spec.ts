import { createClient } from "@supabase/supabase-js";
import { expect, test, type Page } from "@playwright/test";

/**
 * Stage 6P の画面確認（実Supabaseのテスト世帯・架空データ）。
 *   E2E_SPEC=stage6p.supabase.spec.ts npm run test:e2e:supabase
 *  - PC: コレクションの見出し横のカード／BOX切替、下部ナビ（左サイドメニュー廃止）
 *  - BOX登録: 定価の自動反映・シュリンク初期値・系列＋店舗、登録済みBOXのシュリンク状態の変更
 *  - 商品マスターの削除（参照保護）・既存商品への統合
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
async function household(): Promise<string> {
  const a = admin();
  const { data: list } = await a.auth.admin.listUsers({ perPage: 200 });
  const user = list?.users.find((u) => u.email === email);
  if (!user) throw new Error("test user not found");
  const { data: hm } = await a.from("household_members").select("household_id").eq("user_id", user.id).limit(1).maybeSingle();
  if (!hm) throw new Error("household not found");
  return hm.household_id;
}

test("PC: コレクションの見出し横でカード／BOXを切り替えられる。下部ナビはあり、左サイドメニューは無い", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await login(page);
  await page.goto("/collection");
  await expect(page.locator("aside")).toHaveCount(0);
  const nav = page.getByTestId("bottom-nav-pc");
  await expect(nav).toBeVisible();
  const box = (await nav.boundingBox())!;
  expect(Math.abs(box.y + box.height - 800)).toBeLessThanOrEqual(1);
  const sw = page.getByTestId("collection-switch");
  await expect(sw).toBeVisible();
  await expect(page.getByTestId("collection-hub")).toHaveAttribute("data-tab", "card");
  await expect(page.getByTestId("collection-switch-card")).toHaveAttribute("aria-selected", "true");
  await page.getByTestId("collection-switch-box").click();
  await expect(page.getByTestId("collection-hub")).toHaveAttribute("data-tab", "box");
  await expect(page.getByTestId("collection-switch-box")).toHaveAttribute("aria-selected", "true");
  await expect(page.getByTestId("box-sort")).toBeVisible(); // 一覧・並び順もBOXに切り替わる
  await page.getByTestId("collection-switch-card").click();
  await expect(page.getByTestId("collection-hub")).toHaveAttribute("data-tab", "card");
  // スマホ幅では切替ボタンを出さない（スワイプのみ）
  await page.setViewportSize({ width: 390, height: 800 });
  await expect(page.getByTestId("collection-switch")).toBeHidden();
  await expect(page.getByTestId("bottom-nav")).toBeVisible();
  await expect(page.getByTestId("bottom-nav-pc")).toBeHidden();
});

test("BOX登録: 定価の自動反映・シュリンク初期値・系列＋店舗。登録後にシュリンク状態を変更できる", async ({ page }) => {
  test.setTimeout(150_000);
  await login(page);
  const hid = await household();
  const a = admin();
  const chain = (await a.from("chains").insert({ household_id: hid, name: "6P-E2E系列" }).select("id").single()).data!.id as string;
  await a.from("stores").insert({ household_id: hid, chain_id: chain, name: "6P-E2E三宮店" });
  await a.from("products").insert({ household_id: hid, official_name: "6P定価BOX", packs_per_box: 30, list_price_box: 5400 });
  await page.goto("/collection?tab=box");
  await page.getByTestId("add-card").click();
  const form = page.getByTestId("box-form");
  await expect(form.getByLabel("シュリンク状態")).toHaveValue("shrink");
  await form.getByLabel("BOXの商品").fill("6P定価BOX");
  await expect(form.getByLabel("実際の購入価格")).toHaveValue("5400");
  await form.getByLabel("購入元の系列").fill("6P-E2E");
  await form.getByRole("option", { name: /6P-E2E系列/ }).first().click();
  await form.getByLabel("購入元の店舗").fill("6P-E2E三");
  await form.getByRole("option", { name: /6P-E2E三宮店/ }).first().click();
  await form.getByLabel("BOXの数量").fill("3");
  await form.getByTestId("box-dialog-save").click();
  await expect(form).toHaveCount(0);
  const tile = page.getByTestId("box-tile").filter({ hasText: "6P定価BOX" });
  await expect(tile).toHaveCount(1);
  await expect(tile.getByTestId("box-tile-qty")).toHaveText("×3");

  // シュリンク状態の変更: 3BOXのうち1BOXを「シュリンクなし」へ。合計は3のまま
  await tile.getByRole("button").first().click();
  const detail = page.getByTestId("box-detail");
  await expect(detail.getByTestId("state-shrink")).toContainText("3BOX");
  await detail.getByTestId("box-state-btn").click();
  const dlg = page.getByTestId("box-state-dialog");
  await expect(dlg.getByTestId("box-state-receipt-note")).toHaveCount(0); // 手動登録のロット
  await dlg.getByLabel("変更後の状態").selectOption("no_shrink");
  await dlg.getByLabel("変更する数量").fill("1");
  await dlg.getByRole("button", { name: "変更する" }).click();
  await expect(dlg).toHaveCount(0);
  await expect(detail.getByTestId("state-shrink")).toContainText("2BOX");
  await expect(detail.getByTestId("state-no_shrink")).toContainText("1BOX");
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("box-tile").filter({ hasText: "6P定価BOX" }).getByTestId("box-tile-qty")).toHaveText("×3");
});

test("商品マスター: 参照のある商品は削除できず、重複商品は既存商品へ統合できる（履歴は残る）", async ({ page }) => {
  test.setTimeout(150_000);
  await login(page);
  const hid = await household();
  const a = admin();
  const mk = async (name: string) => (await a.from("products").insert({ household_id: hid, official_name: name, packs_per_box: 30 }).select("id").single()).data!.id as string;
  const keep = await mk("6P統合先商品");
  const dup = await mk("6P統合元商品");
  const free = await mk("6P削除できる商品");
  const pur = (await a.from("purchases").insert({ household_id: hid, source_kind: "manual", purchased_at: new Date().toISOString() }).select("id").single()).data!.id as string;
  await a.from("purchase_items").insert({ household_id: hid, purchase_id: pur, product_id: dup, quantity: 2, unit: "box", amount_paid: 10800 });

  await page.goto("/settings/masters");
  await page.getByRole("tab", { name: "商品", exact: true }).click();
  const row = (name: string) => page.getByTestId("master-row").filter({ hasText: name });
  const menu = async (name: string) => {
    // メニューは開いたままのことがあるため、開閉の切替ではなく「開いた状態にする」
    await row(name).getByTestId("row-menu").evaluate((el) => ((el as HTMLDetailsElement).open = true));
  };

  // 参照が無い商品は削除できる
  await menu("6P削除できる商品");
  await row("6P削除できる商品").getByTestId("product-delete-open").click();
  await expect(page.getByTestId("product-delete-ok")).toBeVisible();
  await page.getByTestId("product-delete-confirm").click();
  await expect(page.getByTestId("product-delete-dialog")).toHaveCount(0);
  await expect.poll(async () => (await a.from("products").select("id").eq("id", free)).data?.length).toBe(0);

  // 参照のある商品は削除できない（購入明細の件数が出て、非表示を提案）
  await menu("6P統合元商品");
  await row("6P統合元商品").getByTestId("product-delete-open").click();
  const blocked = page.getByTestId("product-delete-blocked");
  await expect(blocked).toContainText("購入明細 1件");
  await expect(page.getByTestId("product-delete-confirm")).toHaveCount(0);
  await page.getByRole("button", { name: "キャンセル" }).click();
  expect((await a.from("products").select("id").eq("id", dup)).data).toHaveLength(1);

  // 既存商品へ統合
  await menu("6P統合元商品");
  await row("6P統合元商品").getByTestId("product-merge-open").click();
  const m = page.getByTestId("product-merge-dialog");
  await m.getByRole("combobox", { name: "統合先の商品" }).fill("6P統合先商品");
  await m.getByTestId("product-merge-check").click();
  await expect(m.getByTestId("product-merge-preview")).toContainText("購入明細 1件");
  await m.getByTestId("product-merge-run").click();
  await expect(m.getByTestId("product-merge-done")).toBeVisible();
  const { data: items } = await a.from("purchase_items").select("product_id,quantity,amount_paid").eq("purchase_id", pur);
  expect(items).toEqual([{ product_id: keep, quantity: 2, amount_paid: 10800 }]);
  expect((await a.from("products").select("archived_at").eq("id", dup).single()).data!.archived_at).not.toBeNull();
});
