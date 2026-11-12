import { createClient } from "@supabase/supabase-js";
import { expect, test, type Page } from "@playwright/test";

/**
 * Stage 8D-4: 反映候補の承認フロー（開発用・ローカルDB・モック・架空データ）。
 *   E2E_SPEC=stage8d4.supabase.spec.ts npm run test:e2e:supabase
 *  - 調査（モック）→「反映候補にする」→ 一覧に差異・情報源・公式性が出る → 保留 → 解除 → 承認で店舗マスターへ反映 → 取消で元に戻る
 *  - 却下すると店舗は変わらない／同じ候補は二重に作れない
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
async function makeStore(name: string, chainName: string, extra: Record<string, unknown> = {}) {
  const hid = await household();
  const a = admin();
  const chain = (await a.from("chains").insert({ household_id: hid, name: chainName }).select("id").single()).data!.id as string;
  const store = (await a.from("stores").insert({ household_id: hid, chain_id: chain, name, prefecture: "東京都", store_url: "https://test-bookstore.test/", ...extra }).select("id").single()).data!.id as string;
  return { a, store };
}

test("承認フロー: 調査 → 反映候補 → 保留 → 解除 → 承認で反映 → 取消。店舗マスターは承認するまで変わらない", async ({ page }) => {
  test.setTimeout(150_000);
  await login(page);
  const { a, store } = await makeStore("テスト書店 駅前店", "テスト書店");
  await page.goto("/settings/store-research");
  await page.getByTestId("research-store").selectOption(store);
  await page.getByTestId("research-run").click();
  await expect(page.getByTestId("research-status")).toHaveText("確認済み");
  await page.getByTestId("research-propose").click();
  await expect(page.getByTestId("research-propose-msg")).toContainText("反映候補にしました");

  const card = page.getByTestId("proposal-card").first();
  await expect(card).toContainText("テスト書店／テスト書店 駅前店");
  await expect(card.getByTestId("proposal-status")).toHaveText("承認待ち");
  await expect(card.getByTestId("proposal-diff")).toContainText("東京都架空区駅前1-2-3");
  await expect(card).toContainText("公式（登録済み）");
  expect((await a.from("stores").select("address_optional").eq("id", store).single()).data!.address_optional).toBe(""); // 候補の段階では店舗は変わらない

  // 同じ調査結果からの二重の候補は作れない（同じ候補を返す）
  await page.getByTestId("research-propose").click();
  await expect(page.getByTestId("research-propose-msg")).toContainText("すでにあります");
  await expect(page.getByTestId("proposal-card")).toHaveCount(1);

  await card.getByTestId("proposal-hold").click();
  await expect(card.getByTestId("proposal-status")).toHaveText("保留");
  await card.getByTestId("proposal-reopen").click();
  await expect(card.getByTestId("proposal-status")).toHaveText("承認待ち");
  await card.getByTestId("proposal-apply").click();
  await expect(card.getByTestId("proposal-status")).toHaveText("反映済み");
  await expect(page.getByTestId("proposal-notice")).toContainText("開発DB");
  expect((await a.from("stores").select("address_optional,prefecture").eq("id", store).single()).data).toMatchObject({ address_optional: "東京都架空区駅前1-2-3", prefecture: "東京都" });
  await expect(card.getByTestId("proposal-apply")).toHaveCount(0); // 二重に反映できない

  await card.getByTestId("proposal-revert").click();
  await expect(card.getByTestId("proposal-status")).toHaveText("取消済み");
  expect((await a.from("stores").select("address_optional").eq("id", store).single()).data!.address_optional).toBe("");
  const events = (await a.from("store_location_proposal_events").select("action").order("occurred_at")).data!.map((e) => e.action);
  expect(events).toEqual(["created", "held", "reopened", "applied", "reverted"]);
});

test("承認フロー: 候補の作成後に店舗が編集されたら反映されない（編集を守る）。却下すると店舗は変わらず、却下済みは反映できない", async ({ page }) => {
  test.setTimeout(150_000);
  await login(page);
  const { a, store } = await makeStore("テストカード 中央店", "テストカード専門店", { prefecture: "埼玉県", store_url: null });
  await page.goto("/settings/store-research");
  await page.getByTestId("research-store").selectOption(store);
  await page.getByTestId("research-run").click();
  await expect(page.getByTestId("research-status")).toHaveText("候補あり");
  await page.getByTestId("research-propose").click();
  const card = page.getByTestId("proposal-card").first();
  await expect(card.getByTestId("proposal-status")).toHaveText("承認待ち");
  await expect(card).toContainText("公式");

  await a.from("stores").update({ address_optional: "東京都架空区利用者が入力した住所9-9-9" }).eq("id", store); // 候補の作成後に、利用者が店舗の住所を入力した
  await card.getByTestId("proposal-apply").click(); // 承認しても、利用者の入力を上書きしない
  await expect(page.getByTestId("proposal-error")).toContainText("変更");
  await expect(card.getByTestId("proposal-status")).toHaveText("承認待ち");
  expect((await a.from("stores").select("address_optional").eq("id", store).single()).data!.address_optional).toBe("東京都架空区利用者が入力した住所9-9-9");

  await card.getByTestId("proposal-reject").click();
  await expect(card.getByTestId("proposal-status")).toHaveText("却下");
  expect((await a.from("stores").select("address_optional").eq("id", store).single()).data!.address_optional).toBe("東京都架空区利用者が入力した住所9-9-9");
  await expect(card.getByTestId("proposal-apply")).toHaveCount(0); // 却下済みは反映できない
});
