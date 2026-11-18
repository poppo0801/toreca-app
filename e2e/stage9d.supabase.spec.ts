import { createClient } from "@supabase/supabase-js";
import { expect, test, type Page } from "@playwright/test";

/**
 * Stage 9D: 情報収集エージェントの調査状況の画面（開発用・ローカルDB・架空データ。外部サイト／AI／有料APIは使わない）。
 *   E2E_SPEC=stage9d.supabase.spec.ts npm run test:e2e:supabase
 *  - 「調査する（プレビュー）」→ 調査の履歴（状態・手数・費用）・経過（目的・調査先・成否・所要時間・次に使える情報）・停止理由が出る。
 *  - プレビューは抽選・監視対象を登録しない。外部の取得は既定でオフ（取得できない理由が「止めたもの」に出る）。390pxで横にはみ出さない。
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

test("調査状況: プレビュー調査を実行すると、履歴・経過・停止理由・自己評価が見え、登録も監視の追加もされない", async ({ page }) => {
  test.setTimeout(120_000);
  await page.setViewportSize({ width: 390, height: 844 });
  await login(page);
  const hid = await household();
  const a = admin();
  const chain = (await a.from("chains").insert({ household_id: hid, name: "9D-E2E玩具" }).select("id").single()).data!.id as string;
  await a.from("stores").insert({ household_id: hid, chain_id: chain, name: "9D本店", prefecture: "東京都", store_url: "https://e2e9d.example.invalid/" });
  await a.from("agent_investigation_runs").delete().eq("household_id", hid);
  const before = { l: (await a.from("lotteries").select("id", { count: "exact", head: true }).eq("household_id", hid)).count, s: (await a.from("collection_sources").select("id", { count: "exact", head: true }).eq("household_id", hid)).count };

  await page.goto("/settings/investigation");
  await expect(page.getByTestId("investigation")).toBeVisible();
  await expect(page.getByTestId("inv-usage")).toContainText("今日 0/6回");
  await page.getByTestId("inv-run-dry").click();
  await expect(page.getByTestId("inv-notice")).toBeVisible({ timeout: 60_000 });
  const run = page.getByTestId("inv-run").first();
  await expect(run).toContainText("完了");
  const detail = page.getByTestId("inv-detail");
  await expect(detail).toContainText("get_signals");
  await expect(detail).toContainText("check_official_site");
  await expect(detail).toContainText("目的:");
  // 行動を決めたのは誰か（9E）: 実AIなしの調査は「固定の方針」
  await expect(detail).toContainText("決めたのは: 固定の方針");
  await expect(detail).toContainText("調査先: https://e2e9d.example.invalid/");
  // 外部アクセスはオフ: 取得できない理由が「止めたもの」に出る（アクセス制限・ログインの回避はしない）
  await expect(detail).toContainText("止めたもの・エラー");
  await expect(detail).toContainText("外部アクセスは設定されていません");
  await detail.getByText("自己評価").click();
  await expect(detail).toContainText("取得の成功率");
  await expect(detail).toContainText("［未確認］");
  // 横にはみ出さない（390px）
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(0);
  await page.screenshot({ path: "test-results/9d-investigation-390.png", fullPage: true });
  // プレビューは登録しない
  expect((await a.from("lotteries").select("id", { count: "exact", head: true }).eq("household_id", hid)).count).toBe(before.l);
  expect((await a.from("collection_sources").select("id", { count: "exact", head: true }).eq("household_id", hid)).count).toBe(before.s);
  // 通常の抽選一覧は影響を受けない
  await page.goto("/lotteries");
  await expect(page).toHaveURL(/\/lotteries$/);
});
