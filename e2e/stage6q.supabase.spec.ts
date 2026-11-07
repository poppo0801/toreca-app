import { createClient } from "@supabase/supabase-js";
import { expect, test, type Page } from "@playwright/test";

/**
 * Stage 6Q の画面確認（実Supabaseのテスト世帯・架空データ）。
 *   E2E_SPEC=stage6q.supabase.spec.ts npm run test:e2e:supabase
 *  - 系列マスターの削除（参照保護）・既存系列への統合
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

test("系列マスター: 参照のある系列は削除できず、重複系列は既存系列へ統合できる（店舗・抽選は統合先へ）", async ({ page }) => {
  test.setTimeout(150_000);
  await login(page);
  const hid = await household();
  const a = admin();
  const mk = async (name: string) => (await a.from("chains").insert({ household_id: hid, name }).select("id").single()).data!.id as string;
  const keep = await mk("6Q-E2E統合先");
  const dup = await mk("6Q-E2E統合元");
  const free = await mk("6Q-E2E削除できる系列");
  const store = (await a.from("stores").insert({ household_id: hid, chain_id: dup, name: "6Q-E2E店", prefecture: "大阪府" }).select("id").single()).data!.id as string;
  const lot = (await a.from("lotteries").insert({ household_id: hid, chain_id: dup, store_id: store, apply_deadline_precision: "unknown", receive_method: "store", apply_method: "web", event_state: "open", limit_basis: "account", limit_max_count: 5, source_kind: "manual" } as never).select("id").single()).data!.id as string;

  await page.goto("/settings/masters");
  await page.getByRole("tab", { name: "系列", exact: true }).click();
  const row = (name: string) => page.getByTestId("master-row").filter({ hasText: name });
  const menu = async (name: string) => {
    await row(name).getByTestId("row-menu").evaluate((el) => ((el as HTMLDetailsElement).open = true));
  };

  await menu("6Q-E2E削除できる系列");
  await row("6Q-E2E削除できる系列").getByTestId("chain-delete-open").click();
  await expect(page.getByTestId("chain-delete-ok")).toBeVisible();
  await page.getByTestId("chain-delete-confirm").click();
  await expect(page.getByTestId("chain-delete-dialog")).toHaveCount(0);
  await expect.poll(async () => (await a.from("chains").select("id").eq("id", free)).data?.length).toBe(0);

  await menu("6Q-E2E統合元");
  await row("6Q-E2E統合元").getByTestId("chain-delete-open").click();
  await expect(page.getByTestId("chain-delete-blocked")).toContainText("店舗 1件");
  await expect(page.getByTestId("chain-delete-blocked")).toContainText("抽選 1件");
  await expect(page.getByTestId("chain-delete-confirm")).toHaveCount(0);
  await page.getByRole("button", { name: "キャンセル" }).click();
  expect((await a.from("chains").select("id").eq("id", dup)).data).toHaveLength(1);

  await menu("6Q-E2E統合元");
  await row("6Q-E2E統合元").getByTestId("chain-merge-open").click();
  const m = page.getByTestId("chain-merge-dialog");
  await m.getByRole("combobox", { name: "統合先の系列" }).fill("6Q-E2E統合先");
  await m.getByTestId("chain-merge-check").click();
  await expect(m.getByTestId("chain-merge-preview")).toContainText("抽選 1件");
  await m.getByTestId("chain-merge-run").click();
  await expect(m.getByTestId("chain-merge-done")).toBeVisible();
  const l = (await a.from("lotteries").select("chain_id,store_id").eq("id", lot).single()).data!;
  expect(l).toEqual({ chain_id: keep, store_id: store });
  expect((await a.from("stores").select("chain_id").eq("id", store).single()).data!.chain_id).toBe(keep);
  expect((await a.from("chains").select("archived_at").eq("id", dup).single()).data!.archived_at).not.toBeNull();
});
