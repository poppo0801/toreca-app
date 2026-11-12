import { createClient } from "@supabase/supabase-js";
import { expect, test, type Page } from "@playwright/test";

/**
 * Stage 8D-2: 店舗所在地の調査画面（開発用・ローカルDB・モック・架空データ）。
 *   E2E_SPEC=stage8d2.supabase.spec.ts npm run test:e2e:supabase
 *  - 店舗を選び「AIで所在地を調査」→ 結果（状態・住所・情報源・使用量）が出る。店舗マスターは変わらない。実APIは使わない（モック）。
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

test("所在地の調査: 店舗を選んで調査（モック）。結果・情報源・使用量が表示され、店舗マスターは変わらない", async ({ page }) => {
  test.setTimeout(120_000);
  await login(page);
  const hid = await household();
  const a = admin();
  const chain = (await a.from("chains").insert({ household_id: hid, name: "テスト書店" }).select("id").single()).data!.id as string;
  const store = (await a.from("stores").insert({ household_id: hid, chain_id: chain, name: "テスト書店 駅前店", prefecture: "東京都", store_url: "https://test-bookstore.test/" }).select("id").single()).data!.id as string;
  const before = JSON.stringify((await a.from("stores").select("*").eq("id", store).single()).data);

  await page.goto("/settings/store-research");
  await expect(page.getByTestId("research-mode")).toContainText("モック");
  await expect(page.getByTestId("research-run")).toBeDisabled(); // 店舗を選ぶまで押せない
  await page.getByTestId("research-store").selectOption(store);
  await page.getByTestId("research-run").click();

  const result = page.getByTestId("research-result");
  await expect(result).toBeVisible();
  await expect(page.getByTestId("research-status")).toHaveText("確認済み");
  await expect(page.getByTestId("research-address")).toContainText("東京都架空区駅前1-2-3");
  const src = page.getByTestId("research-sources").getByRole("link").first();
  await expect(src).toHaveAttribute("href", /test-bookstore\.test/);
  await expect(src).toHaveAttribute("rel", /noopener/);
  await expect(page.getByTestId("research-usage")).toContainText("推定費用");
  await expect(page.getByTestId("research-usage")).toContainText("検索");
  await expect(page.getByTestId("research-official")).toContainText("公式（登録済み）"); // 登録済みの公式サイト（store_url）の判定が根拠つきで出る
  await expect(page.getByTestId("research-official")).toContainText("store_url）は更新されません");
  await expect(page.getByTestId("research-more")).toHaveCount(0); // 確認済みなら追加調査は出ない

  // 保存: 専用の表に1件。店舗マスターは1文字も変わらない
  const rows = (await a.from("store_location_research").select("status,address,engine,confidence").eq("store_id", store)).data!;
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({ status: "confirmed", address: "東京都架空区駅前1-2-3", engine: "mock-brain" });
  expect(JSON.stringify((await a.from("stores").select("*").eq("id", store).single()).data)).toBe(before);

  // 店舗一覧に最新の状態が付く
  await expect(page.getByTestId("research-store").locator("option", { hasText: "テスト書店 駅前店" })).toContainText("確認済み");
  // 実APIは無効（E2E のサーバーには、実API評価用の開発専用設定を渡さない。キーの有無で結果が変わらない）
  await expect(page.getByText("実APIは無効です")).toBeVisible();
});

test("所在地の調査: 確認済みにならない場合は注意を出し、追加調査ができる", async ({ page }) => {
  test.setTimeout(120_000);
  await login(page);
  const hid = await household();
  const a = admin();
  const chain = (await a.from("chains").insert({ household_id: hid, name: "テストカード専門店" }).select("id").single()).data!.id as string;
  const store = (await a.from("stores").insert({ household_id: hid, chain_id: chain, name: "テストカード 中央店", prefecture: "埼玉県" }).select("id").single()).data!.id as string;
  await page.goto("/settings/store-research");
  await page.getByTestId("research-store").selectOption(store);
  await page.getByTestId("research-run").click();
  await expect(page.getByTestId("research-status")).toHaveText("候補あり"); // 第三者のブログ1件だけ（公式を確認できない）
  await expect(page.getByText("確認済みではありません")).toBeVisible();
  await expect(page.getByTestId("research-more")).toBeVisible();
  await page.getByTestId("research-more").click();
  await expect(page.getByText("この店舗の調査履歴")).toBeVisible();
  await expect(page.getByTestId("research-store").locator("option", { hasText: "テストカード 中央店" })).toContainText("候補あり");
  // 追加調査の保存を待つ（調査は履歴として追記される）
  await expect.poll(async () => ((await a.from("store_location_research").select("id").eq("store_id", store)).data ?? []).length).toBe(2);
});
