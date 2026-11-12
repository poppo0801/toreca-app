import { createClient } from "@supabase/supabase-js";
import { expect, test, type Page } from "@playwright/test";

/**
 * Stage 7N の画面確認（実Supabaseのテスト世帯・架空データ）。
 *   E2E_SPEC=stage7n.supabase.spec.ts npm run test:e2e:supabase
 *  - 店舗選択式: 新しい店舗を入力して応募済みにすると、都道府県を一覧から選べ、完了後に閉じ、店舗が店舗マスターに確認済みで登録される
 *  - 店舗マスター: 系列別の折りたたみ一覧・検索で自動展開・未確認の●・編集して保存すると確認済みになる
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

test("店舗選択式の応募で入力した店舗が店舗マスターに登録され、店舗マスターは系列別の折りたたみ一覧・検索・未確認の●で管理できる", async ({ page }) => {
  test.setTimeout(240_000);
  page.setDefaultTimeout(20_000);
  await login(page);
  const hid = await household();
  const a = admin();
  const ins = async (table: string, row: Record<string, unknown>) => {
    const { data, error } = await a.from(table).insert(row as never).select("id").single();
    expect(error?.message, table).toBeUndefined();
    return (data as { id: string }).id;
  };
  const { data: profs } = await a.from("profiles").select("id,label").eq("household_id", hid).eq("active", true).order("sort_order");
  const chain = await ins("chains", { household_id: hid, name: "7N電機" });
  const fam = await ins("family_groups", { household_id: hid, label: "7N家族" });
  const adr = await ins("address_groups", { household_id: hid, label: "7N住所" });
  const idn = await ins("identities", { household_id: hid, display_label: "7N名義", family_group_id: fam, address_group_id: adr });
  for (const p of profs ?? []) await ins("service_accounts", { household_id: hid, chain_id: chain, identity_id: idn, managed_by_profile_id: p.id, account_label: `acc-${p.label}`, membership_state: "eligible" });
  const prod = await ins("products", { household_id: hid, official_name: "7N商品", packs_per_box: 20 });
  const ph = await ins("stores", { household_id: hid, chain_id: chain, name: "応募時に店舗選択", is_provisional: true });
  const unconfirmed = await ins("stores", { household_id: hid, chain_id: chain, name: "7N未確認店", prefecture: "大阪府", is_provisional: true });
  await ins("stores", { household_id: hid, chain_id: chain, name: "7N確認済店", prefecture: "兵庫県", is_provisional: false });
  await ins("stores", { household_id: hid, chain_id: chain, name: "7N通販", prefecture: "", sales_kind: "online_only", is_provisional: false });
  const lot = await ins("lotteries", { household_id: hid, chain_id: chain, store_id: ph, store_mode: "select_on_apply", apply_deadline_precision: "date_time", apply_deadline_at: "2099-01-10T14:59:00Z", receive_method: "store", apply_method: "web", event_state: "open", limit_basis: "account", limit_max_count: 5, source_kind: "manual" });
  await ins("lottery_items", { household_id: hid, lottery_id: lot, product_id: prod, quantity: 1, unit: "box" });
  await a.from("lottery_management").insert({ household_id: hid, lottery_id: lot, is_managed: true, managed_source: "manual" } as never);

  try {
    // ---- 応募: 新しい店舗を入力し、都道府県を一覧から選ぶ（標準のプルダウンは使わない）
    await page.goto("/lotteries");
    const card = page.getByTestId("lottery-card").filter({ hasText: "7N商品" });
    await expect(card).toHaveCount(1);
    await card.getByTestId("my-apply").click();
    const sheet = page.getByTestId("applied-store-dialog");
    await sheet.getByRole("combobox", { name: "応募先の店舗" }).fill("7N新店舗");
    await expect(sheet.locator("select")).toHaveCount(0);
    await sheet.getByTestId("pref-toggle").click();
    await sheet.getByTestId("pref-option").filter({ hasText: "兵庫県" }).click();
    await expect(sheet.getByTestId("pref-toggle")).toContainText("兵庫県");
    await sheet.getByTestId("applied-store-ok").click();
    await expect(sheet).toHaveCount(0); // 完了後に閉じる
    await expect.poll(async () => (await a.from("applications").select("applied_store_name,applied_store_id,state").eq("lottery_id", lot)).data?.[0]).toMatchObject({ applied_store_name: "7N新店舗", state: "applied" });
    // 店舗マスターへ確認済み（正式登録）で登録され、応募記録に紐づく
    const reg = (await a.from("stores").select("id,prefecture,is_provisional").eq("chain_id", chain).eq("name", "7N新店舗").single()).data!;
    expect(reg).toMatchObject({ prefecture: "兵庫県", is_provisional: false });
    expect((await a.from("applications").select("applied_store_id").eq("lottery_id", lot).single()).data!.applied_store_id).toBe(reg.id);

    // ---- 店舗マスター: 系列別の折りたたみ。系列カードに店舗数と未確認数
    await page.goto("/settings/masters");
    await page.getByRole("tab", { name: "店舗", exact: true }).click();
    const group = page.getByTestId("store-group").filter({ hasText: "7N電機" });
    await expect(group).toHaveCount(1);
    await expect(group).toHaveAttribute("data-open", "0");
    await expect(group.getByTestId("store-group-count")).toHaveText("4店舗"); // 応募時に店舗選択（仮の店舗）は数えない
    await expect(group.getByTestId("store-group-unconfirmed")).toHaveText("1件"); // Stage 7R 以降は「n件」表記
    await group.getByTestId("store-group-toggle").click();
    const rows = group.getByTestId("store-row");
    await expect(rows.first()).toContainText("7N未確認店"); // 未確認が先頭
    await expect(rows.first().getByTestId("unconfirmed-dot")).toBeVisible();
    await expect(rows.filter({ hasText: "7N通販" })).toContainText("通販");
    await expect(rows.filter({ hasText: "7N確認済店" }).getByTestId("unconfirmed-dot")).toHaveCount(0);

    // 検索: 店舗名で絞り込み、該当する系列を自動展開
    await group.getByTestId("store-group-toggle").click(); // 折りたたむ
    await expect(group).toHaveAttribute("data-open", "0");
    await page.getByTestId("master-search").fill("7N確認済");
    await expect(page.getByTestId("store-group")).toHaveCount(1);
    await expect(page.getByTestId("store-group")).toHaveAttribute("data-open", "1");
    await expect(page.getByTestId("store-row")).toHaveCount(1);
    await page.getByTestId("master-search").fill("");

    // ---- 未確認の店舗を編集して保存すると、変更なしでも確認済みになる
    await page.getByTestId("master-search").fill("7N未確認店");
    const row = page.getByTestId("store-row").filter({ hasText: "7N未確認店" });
    await row.getByRole("button", { name: "編集" }).click();
    const dlg = page.getByRole("dialog");
    await expect(dlg.getByTestId("unconfirmed-note")).toContainText("未確認");
    await dlg.getByRole("button", { name: "保存" }).click();
    await expect(dlg).toHaveCount(0);
    await expect(row.getByTestId("unconfirmed-dot")).toHaveCount(0);
    expect((await a.from("stores").select("is_provisional").eq("id", unconfirmed).single()).data!.is_provisional).toBe(false);

    // ---- 系列内の「店舗を追加」: 系列が自動設定される（手動登録は確認済み）
    await page.getByTestId("master-search").fill("7N電機");
    await page.getByTestId("store-group").first().getByTestId("store-add-in-chain").click();
    const add = page.getByRole("dialog");
    await add.getByLabel(/店舗名/).fill("7N追加店");
    await add.getByRole("button", { name: "保存" }).click();
    await expect(add).toHaveCount(0);
    await expect.poll(async () => (await a.from("stores").select("chain_id,is_provisional").eq("name", "7N追加店").maybeSingle()).data).toMatchObject({ chain_id: chain, is_provisional: false });
  } finally {
    await a.from("applications").delete().eq("lottery_id", lot);
    await a.from("lottery_management").delete().eq("lottery_id", lot);
    await a.from("lottery_items").delete().eq("lottery_id", lot);
    await a.from("lotteries").delete().eq("id", lot);
    await a.from("stores").delete().eq("chain_id", chain);
    await a.from("service_accounts").delete().eq("chain_id", chain);
    await a.from("chains").delete().eq("id", chain);
    await a.from("products").delete().eq("id", prod);
  }
});
