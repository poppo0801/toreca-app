import { createClient } from "@supabase/supabase-js";
import { expect, test, type Page } from "@playwright/test";

/**
 * Stage 6N の画面確認（実Supabaseのテスト世帯・架空データ）。
 *   E2E_SPEC=stage6n.supabase.spec.ts npm run test:e2e:supabase
 *  - 支出登録の「系列＋店舗」（店舗は選んだ系列の店舗に絞られる／店舗なしの系列は系列のみで保存）
 *  - 経費の「ガソリン代を計算する」: 往復・片道、金額の手動修正、片道距離を系列＋店舗ごとに保存して次回自動入力
 *  - 設定のガソリン代（燃費）の変更が、次の計算に反映される。保存済みの支出金額は変わらない
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

test("経費のガソリン代: 系列＋店舗・往復/片道・手動修正・距離の保存と再利用・燃費設定の変更", async ({ page }) => {
  test.setTimeout(150_000);
  await login(page);
  const hid = await household();
  const a = admin();
  const chain = (await a.from("chains").insert({ household_id: hid, name: "6N-E2E系列" }).select("id").single()).data!.id as string;
  const sA = (await a.from("stores").insert({ household_id: hid, chain_id: chain, name: "6N三宮店" }).select("id").single()).data!.id as string;
  const sB = (await a.from("stores").insert({ household_id: hid, chain_id: chain, name: "6N大阪店" }).select("id").single()).data!.id as string;

  const openExpense = async () => {
    await page.goto("/finance");
    await page.getByRole("button", { name: "＋支出" }).click();
    await page.getByTestId("expense-category").selectOption("expense");
  };
  const pick = async (label: string, text: string, option: string) => {
    await page.getByRole("combobox", { name: label }).fill(text);
    await page.getByRole("option", { name: new RegExp(option) }).first().click();
  };

  // 1回目: 三宮店。距離を入力して往復で計算（初期値 155円/L・16.7km/L → 8.5×2÷16.7×155 = 158円）
  await openExpense();
  await pick("系列", "6N-E2E", "6N-E2E系列");
  await pick("購入店舗", "6N三宮", "6N三宮店");
  await page.getByTestId("fuel-toggle").check();
  await expect(page.getByTestId("expense-item-name")).toHaveValue("ガソリン代");
  await expect(page.getByLabel("ガソリン単価")).toHaveValue("155");
  await expect(page.getByText("燃費")).toHaveCount(0); // 燃費は支出登録画面に出さない
  await page.getByLabel("片道距離").fill("8.5");
  await page.getByTestId("fuel-calc-btn").click();
  await expect(page.getByLabel("購入金額1")).toHaveValue("158");
  await page.getByLabel("購入金額1").fill("160"); // 手動修正
  await page.getByRole("button", { name: "保存" }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  const row = page.getByTestId("ledger-row").filter({ hasText: "ガソリン代" }).first();
  await expect(row).toContainText("160");

  // 2回目: 同じ系列・店舗を選ぶと距離が自動入力される。別の店舗では流用されない。片道に切り替えて計算
  await openExpense();
  await pick("系列", "6N-E2E", "6N-E2E系列");
  await pick("購入店舗", "6N三宮", "6N三宮店");
  await page.getByTestId("fuel-toggle").check();
  await expect(page.getByLabel("片道距離")).toHaveValue("8.5");
  await pick("購入店舗", "6N大阪", "6N大阪店");
  await expect(page.getByLabel("片道距離")).toHaveValue("");
  await page.getByLabel("片道距離").fill("34");
  await page.getByTestId("fuel-oneway").click();
  await page.getByTestId("fuel-calc-btn").click();
  await expect(page.getByLabel("購入金額1")).toHaveValue("316"); // 34÷16.7×155 = 315.6 → 316
  await page.getByRole("button", { name: "キャンセル" }).click();

  // 距離が系列＋店舗ごとに保存されている
  const distOf = async (storeId: string) => {
    const { data } = await a.from("store_trip_distances").select("one_way_km").eq("household_id", hid).eq("chain_id", chain).eq("store_id", storeId).maybeSingle();
    return data ? Number(data.one_way_km) : null;
  };
  await expect.poll(() => distOf(sA)).toBe(8.5);
  await expect.poll(() => distOf(sB)).toBe(34);

  // 設定で燃費を変更 → 次の計算に反映。保存済みの支出（160円）は変わらない
  await page.goto("/settings");
  await page.getByTestId("acc-fuel").getByRole("button").first().click();
  await page.getByLabel("燃費", { exact: true }).fill("10");
  await page.getByTestId("fuel-settings-save").click();
  await expect(page.getByText("保存しました")).toBeVisible();
  await openExpense();
  await pick("系列", "6N-E2E", "6N-E2E系列");
  await pick("購入店舗", "6N大阪", "6N大阪店");
  await page.getByTestId("fuel-toggle").check();
  await expect(page.getByLabel("片道距離")).toHaveValue("34");
  await page.getByTestId("fuel-oneway").click();
  await page.getByTestId("fuel-calc-btn").click();
  await expect(page.getByLabel("購入金額1")).toHaveValue("527"); // 34÷10×155 = 527
  await page.getByRole("button", { name: "キャンセル" }).click();
  await page.goto("/finance");
  await expect(page.getByTestId("ledger-row").filter({ hasText: "ガソリン代" }).first()).toContainText("160");

  // 後片付け
  await a.from("fuel_settings").delete().eq("household_id", hid);
  const { data: ps } = await a.from("purchases").select("id").eq("household_id", hid).eq("chain_id", chain);
  for (const p of ps ?? []) {
    await a.from("purchase_items").delete().eq("purchase_id", p.id);
    await a.from("purchases").delete().eq("id", p.id);
  }
});

test("経費・グッズ: 店舗のない系列は系列のみで保存できる（店舗は任意）", async ({ page }) => {
  await login(page);
  const hid = await household();
  const a = admin();
  const chain = (await a.from("chains").insert({ household_id: hid, name: "6N-E2E店舗なし系列" }).select("id").single()).data!.id as string;
  await page.goto("/finance");
  await page.getByRole("button", { name: "＋支出" }).click();
  await page.getByTestId("expense-category").selectOption("goods");
  await page.getByRole("combobox", { name: "系列" }).fill("6N-E2E店舗なし");
  await page.getByRole("option", { name: /6N-E2E店舗なし系列/ }).first().click();
  await page.getByTestId("expense-item-name").fill("6Nスリーブ");
  await page.getByLabel("購入金額1").fill("500");
  await page.getByRole("button", { name: "保存" }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(page.getByTestId("ledger-row").filter({ hasText: "6Nスリーブ" })).toBeVisible();
  const { data } = await a.from("purchases").select("id,chain_id,store_id").eq("household_id", hid).eq("chain_id", chain);
  expect(data).toHaveLength(1);
  expect(data![0].store_id).toBeNull();
  for (const p of data ?? []) {
    await a.from("purchase_items").delete().eq("purchase_id", p.id);
    await a.from("purchases").delete().eq("id", p.id);
  }
});

test("店舗選択式の抽選: 応募済みにする操作で応募店舗を選び、詳細に表示され、後から変更できる", async ({ page }) => {
  test.setTimeout(150_000);
  await login(page);
  const hid = await household();
  const a = admin();
  const ins = async (table: string, row: Record<string, unknown>) => {
    const { data, error } = await a.from(table).insert(row as never).select("id").single();
    expect(error, table).toBeNull();
    return (data as { id: string }).id;
  };
  const { data: profs } = await a.from("profiles").select("id,label").eq("household_id", hid).order("sort_order");
  const chain = await ins("chains", { household_id: hid, name: "6N選択式系列" });
  const ph = await ins("stores", { household_id: hid, chain_id: chain, name: "応募時に店舗選択", is_provisional: true });
  await ins("stores", { household_id: hid, chain_id: chain, name: "6N梅田店", prefecture: "大阪府" });
  const prod = await ins("products", { household_id: hid, official_name: "6N選択式商品", packs_per_box: 20 });
  const one = async (table: string, make: () => Promise<string>) => {
    const { data } = await a.from(table).select("id").eq("household_id", hid).limit(1).maybeSingle();
    return data ? (data as { id: string }).id : make();
  };
  const fam = await one("family_groups", () => ins("family_groups", { household_id: hid, label: "6N家族" }));
  const adr = await one("address_groups", () => ins("address_groups", { household_id: hid, label: "6N住所" }));
  const idn = await ins("identities", { household_id: hid, display_label: "6N名義", family_group_id: fam, address_group_id: adr });
  for (const p of profs ?? []) await ins("service_accounts", { household_id: hid, chain_id: chain, identity_id: idn, managed_by_profile_id: p.id, account_label: `acc-${p.label}`, membership_state: "eligible" });
  const lot = await ins("lotteries", {
    household_id: hid, chain_id: chain, store_id: ph, store_mode: "select_on_apply",
    selectable_stores: [{ name: "6N梅田店", prefecture: "大阪府" }, { name: "6N三宮店", prefecture: "兵庫県" }],
    apply_deadline_precision: "date_time", apply_deadline_at: "2099-01-10T14:59:00Z",
    receive_method: "store", apply_method: "web", event_state: "open", limit_basis: "account", limit_max_count: 5, source_kind: "manual",
  });
  await ins("lottery_items", { household_id: hid, lottery_id: lot, product_id: prod, quantity: 1, unit: "box" });
  await a.from("lottery_management").insert({ household_id: hid, lottery_id: lot, is_managed: true, managed_source: "manual" } as never);

  await page.goto("/lotteries");
  const card = page.getByTestId("lottery-card").filter({ hasText: "6N選択式商品" }).first();
  await expect(card).toBeVisible();
  await card.getByTestId("my-apply").click();
  // 応募先の店舗を選ぶ画面が開く（候補は取得済みの一覧）
  const dlg = page.getByTestId("applied-store-dialog");
  await expect(dlg).toBeVisible();
  await expect(dlg.getByTestId("applied-store-ok")).toBeDisabled(); // 店舗を選ぶか、決めずに進むかのどちらか
  await dlg.getByRole("combobox", { name: "応募先の店舗" }).fill("6N三宮");
  await dlg.getByRole("option", { name: /6N三宮店/ }).first().click();
  await dlg.getByTestId("applied-store-ok").click();
  await expect(dlg).toHaveCount(0);
  await expect.poll(async () => (await a.from("applications").select("applied_store_name,applied_store_prefecture,state").eq("lottery_id", lot)).data?.[0]).toMatchObject({ applied_store_name: "6N三宮店", applied_store_prefecture: "兵庫県", state: "applied" });

  // 詳細: 「応募時に店舗選択」の表示と、応募店舗。変更できる
  // 応募済みにしたカードは未応募の一覧から退場するため、読み込み直して「応募済み」から開く
  await page.reload();
  await page.getByRole("tab", { name: /応募済み/ }).click();
  await page.getByTestId("lottery-card").filter({ hasText: "6N選択式商品" }).first().click();
  const sheet = page.getByTestId("lottery-detail-sheet");
  await expect(sheet.getByTestId("store-select-badge")).toHaveText("応募時に店舗選択");
  await expect(sheet.getByTestId("applied-store").first()).toContainText("6N三宮店");
  await sheet.getByTestId("applied-store-edit").first().click();
  const edit = page.getByTestId("applied-store-dialog");
  await edit.getByRole("combobox", { name: "応募先の店舗" }).fill("6N梅田");
  await edit.getByRole("option", { name: /6N梅田店/ }).first().click();
  await edit.getByTestId("applied-store-ok").click();
  await expect.poll(async () => (await a.from("applications").select("applied_store_name").eq("lottery_id", lot)).data?.[0]?.applied_store_name).toBe("6N梅田店");
  await expect(sheet.getByTestId("applied-store").first()).toContainText("6N梅田店");

  // 後片付け
  await a.from("applications").delete().eq("lottery_id", lot);
});
