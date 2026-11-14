import { createClient } from "@supabase/supabase-js";
import { expect, test, type Page } from "@playwright/test";

/**
 * Stage 9C の画面確認（実Supabaseのテスト世帯・架空データ・モバイル幅。外部サイト／AI／有料APIは使わない）。
 *   E2E_SPEC=stage9c.supabase.spec.ts npm run test:e2e:supabase
 *  ⑤ 抽選候補の「重複」で、店舗選択式の抽選カードを統合先として検索・選択でき、店舗が違うという理由で選択不可にならない（応募の記録は変わらない）
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

test("重複先の選択: 店舗選択式の抽選カードを、個別店舗の候補の統合先として選べる", async ({ page }) => {
  test.setTimeout(150_000);
  await login(page);
  const hid = await household();
  const a = admin();
  const { data: profs } = await a.from("profiles").select("id,label").eq("household_id", hid).eq("active", true).order("sort_order");
  await a.from("profiles").update({ is_admin: true }).eq("id", profs![0].id);
  const chain = (await a.from("chains").insert({ household_id: hid, name: "9C-E2E系列" }).select("id").single()).data!.id as string;
  const ph = (await a.from("stores").insert({ household_id: hid, chain_id: chain, name: "応募時に店舗選択", prefecture: "" }).select("id").single()).data!.id as string;
  const s1 = (await a.from("stores").insert({ household_id: hid, chain_id: chain, name: "9C原宿店", prefecture: "東京都" }).select("id").single()).data!.id as string;
  const prod = (await a.from("products").insert({ household_id: hid, official_name: "9C-E2E商品", packs_per_box: 30 }).select("id").single()).data!.id as string;
  const lot = (await a.from("lotteries").insert({ household_id: hid, chain_id: chain, store_id: ph, store_mode: "select_on_apply", receive_method: "store", apply_method: "web", event_state: "open", limit_basis: "account", limit_max_count: 1, source_kind: "auto", registration_path: "auto", apply_deadline_precision: "date_only", apply_deadline_date: "2099-01-20", selectable_stores: [{ name: "9C原宿店", prefecture: "東京都" }] } as never).select("id").single()).data!.id as string;
  await a.from("lottery_items").insert({ household_id: hid, lottery_id: lot, product_id: prod, quantity: 1, unit: "box" } as never);
  const EMPTY = { precision: "unknown", date: "", time: "" };
  const key = "https://s9c-e2e.example.invalid/cand-1";
  const input = {
    chain: { id: chain, name: "9C-E2E系列" },
    store: { id: s1, name: "9C原宿店", prefecture: "東京都" },
    campaignId: null, newCampaign: null,
    items: [{ product: { id: prod, name: "9C-E2E商品" }, quantity: 1, unit: "box" }],
    multiMode: "single", applyStart: EMPTY, applyDeadline: { precision: "date_only", date: "2099-01-20", time: "" }, resultDate: EMPTY, procedureStart: EMPTY, procedureDeadline: EMPTY,
    receiveMethod: "store", applyMethod: "web", requirementTags: [], conditionsText: "", verificationText: "", announcementMethod: "", announcementUrl: "", sourceUrls: [], eventState: "open", limitBasis: "account", limitMaxCount: 1, memo: "", applications: [],
  };
  const draft = { input, flags: {}, summary: { chain: "exact", store: "exact", items: [{ name: "x", kind: "exact", matchedName: "x" }] }, warnings: [], modePending: false, verdict: "review", ready: false, notices: [] };
  const ins = await a.from("collection_candidates").insert({ household_id: hid, dedupe_key: key, source_url: key, title: "9C候補", status: "pending", job_state: "review", kind: "new", reasons: ["要確認"], draft: draft as never } as never);
  expect(ins.error?.message).toBeUndefined();
  try {
    await page.goto("/lotteries/candidates");
    const card = page.getByTestId("candidate-card").filter({ hasText: "9C原宿店" });
    await expect(card).toHaveCount(1);
    await card.getByTestId("candidate-exclude").click();
    await page.getByTestId("reason-duplicate").click();
    // 自動の候補に、店舗選択式の抽選が出る。店舗が異なるという理由で無効にならない
    const opt = page.getByTestId("dup-option").first();
    await expect(opt).toBeVisible();
    await expect(opt.locator("input[type=radio]")).toBeEnabled();
    await expect(opt).not.toContainText("店舗が異なるため");
    await expect(opt).toContainText("店舗選択式");
    const w = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(w).toBeLessThanOrEqual(1);
    await page.screenshot({ path: "test-results/9c-dup-select-390.png" });
    await opt.locator("input[type=radio]").check();
    await page.getByTestId("exclude-submit").click();
    await expect.poll(async () => (await a.from("collection_candidates").select("status").eq("dedupe_key", key).single()).data?.status).toBe("duplicate");
    // 統合先の抽選は変わらない（応募の記録なし・商品は1つのまま）
    expect((await a.from("lottery_items").select("id").eq("lottery_id", lot)).data).toHaveLength(1);
  } finally {
    await a.from("collection_candidates").delete().eq("dedupe_key", key);
    await a.from("lottery_items").delete().eq("lottery_id", lot);
    await a.from("lotteries").delete().eq("id", lot);
  }
});
