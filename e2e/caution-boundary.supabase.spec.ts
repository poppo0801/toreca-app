import { createClient } from "@supabase/supabase-js";
import { expect, test, type Page } from "@playwright/test";

/**
 * 注意（cautions）の message が欠けた古い行がDBにあっても、一覧が描画でき、全タブへ移動できること（実Supabaseのテスト世帯・架空データ）。
 *   E2E_SPEC=caution-boundary.supabase.spec.ts npm run test:e2e:supabase
 * 修正前は cautionSummary が undefined.replace で例外 → 注意付きカードの描画が落ちて画面が壊れた。ここでは、境界の正規化後に
 * 注意アイコンが出て（文言は既定の文言）、要チェック⇄全情報⇄応募済み⇄当選の往復と詳細の表示ができることを確認する。
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

test("message欠落の注意があっても、一覧が描画でき、要チェックから全タブへ移動できる", async ({ page }) => {
  test.setTimeout(150_000);
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await login(page);
  const a = admin();
  const { data: list } = await a.auth.admin.listUsers({ perPage: 200 });
  const user = list!.users.find((u) => u.email === email)!;
  const { data: hm } = await a.from("household_members").select("household_id").eq("user_id", user.id).limit(1).maybeSingle();
  const hid = hm!.household_id as string;
  const chain = (await a.from("chains").insert({ household_id: hid, name: "CB-E2E系列" }).select("id").single()).data!.id as string;
  const store = (await a.from("stores").insert({ household_id: hid, chain_id: chain, name: "CB注意店", prefecture: "大阪府" }).select("id").single()).data!.id as string;
  const prod = (await a.from("products").insert({ household_id: hid, official_name: "CB-E2E商品", packs_per_box: 30 }).select("id").single()).data!.id as string;
  const day = new Date(Date.now() + 10 * 86_400_000 + 9 * 3600_000).toISOString().slice(0, 10);
  const id = (await a.from("lotteries").insert({ household_id: hid, chain_id: chain, store_id: store, apply_deadline_precision: "date_only", apply_deadline_date: day, receive_method: "store", apply_method: "web", event_state: "open", limit_basis: "account", limit_max_count: 5, source_kind: "auto", cautions: [{ code: "result_date_unknown", field: "resultDate" }, { code: "receive_period_unknown", field: "receivePeriod", message: "受取期間が確認できていません" }], confidence: "partial" } as never).select("id").single()).data!.id as string;
  await a.from("lottery_items").insert({ household_id: hid, lottery_id: id, product_id: prod, quantity: 1, unit: "box" } as never);
  try {
    await page.goto("/lotteries");
    await page.getByRole("tab", { name: /全情報/ }).click();
    const card = page.getByTestId("lottery-card").filter({ hasText: "CB注意店" });
    await expect(card).toHaveCount(1);
    await expect(card.getByTestId("caution-mark")).toBeVisible();
    await expect(card.getByTestId("caution-mark")).toHaveAttribute("title", /受取期間が確認できていません/);
    for (const name of [/要チェック/, /応募済み/, /当選/, /全情報/, /要チェック/]) {
      await page.getByRole("tab", { name }).click();
      await expect(page.getByRole("tab", { name })).toHaveAttribute("aria-selected", "true");
      await expect(page.getByTestId("board-content")).toBeVisible();
    }
    await page.getByRole("tab", { name: /全情報/ }).click();
    await card.getByRole("button", { name: /の詳細を開く/ }).first().click();
    await expect(page.getByTestId("lottery-detail-sheet").getByTestId("caution-section")).toBeVisible();
    expect(errors, errors.join("\n")).toEqual([]);
  } finally {
    await a.from("lottery_management").delete().eq("lottery_id", id);
    await a.from("lottery_items").delete().eq("lottery_id", id);
    await a.from("lotteries").delete().eq("id", id);
    await a.from("stores").delete().eq("id", store);
    await a.from("chains").delete().eq("id", chain);
    await a.from("products").delete().eq("id", prod);
  }
});
