import { createClient } from "@supabase/supabase-js";
import { expect, test, type Page } from "@playwright/test";

/**
 * Stage 7J の画面確認（実Supabaseのテスト世帯・架空データ）。
 *   E2E_SPEC=stage7j.supabase.spec.ts npm run test:e2e:supabase
 *  - 抽選の編集で「応募時に店舗選択」に変更 → 応募済みの履歴は変わらず、応募店舗が未設定の案内 → 店舗を入力。他のプロフィールの記録は変わらない
 *  - 登録・編集フォームは入力途中を再開しない（閉じる＝破棄の確認。新規は毎回初期状態）
 *  - 購入記録は商品の正式名称を最大2行で表示
 *  - 抽選詳細: 日付の独立カード・1行のステータス行・管理情報が下部
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

test("抽選詳細のレイアウトと、応募済みの抽選を店舗選択式に変更（履歴は消えない・プロフィール別に店舗を設定）", async ({ page }) => {
  test.setTimeout(180_000);
  await login(page);
  const hid = await household();
  const a = admin();
  const ins = async (table: string, row: Record<string, unknown>) => {
    const { data, error } = await a.from(table).insert(row as never).select("id").single();
    expect(error?.message, table).toBeUndefined();
    return (data as { id: string }).id;
  };
  const { data: profs } = await a.from("profiles").select("id,label").eq("household_id", hid).eq("active", true).order("sort_order");
  const [pa, pb] = profs!;
  const chain = await ins("chains", { household_id: hid, name: "7J電機" });
  const fam = (await a.from("family_groups").select("id").eq("household_id", hid).limit(1).maybeSingle()).data?.id ?? (await ins("family_groups", { household_id: hid, label: "7J家族" }));
  const adr = (await a.from("address_groups").select("id").eq("household_id", hid).limit(1).maybeSingle()).data?.id ?? (await ins("address_groups", { household_id: hid, label: "7J住所" }));
  const idn = await ins("identities", { household_id: hid, display_label: "7J名義", family_group_id: fam, address_group_id: adr });
  const accounts: Record<string, string> = {};
  for (const p of profs!) accounts[p.id] = await ins("service_accounts", { household_id: hid, chain_id: chain, identity_id: idn, managed_by_profile_id: p.id, account_label: `acc7j-${p.label}`, membership_state: "eligible" });
  const prod = await ins("products", { household_id: hid, official_name: "7J正式商品名 30th CELEBRATION", packs_per_box: 20 });
  const store = await ins("stores", { household_id: hid, chain_id: chain, name: "7J梅田店", prefecture: "大阪府" });
  const lot = await ins("lotteries", { household_id: hid, chain_id: chain, store_id: store, apply_deadline_precision: "date_time", apply_deadline_at: "2099-01-10T14:59:00Z", apply_start_precision: "date_time", apply_start_at: "2098-12-20T02:00:00Z", receive_method: "store", apply_method: "web", event_state: "open", limit_basis: "account", limit_max_count: 5, source_kind: "manual" });
  await ins("lottery_items", { household_id: hid, lottery_id: lot, product_id: prod, quantity: 1, unit: "box" });
  await a.from("lottery_management").insert({ household_id: hid, lottery_id: lot, is_managed: true, managed_source: "manual" } as never);
  // A・Bとも応募済み（店舗固定の抽選として）
  const appA = await ins("applications", { household_id: hid, lottery_id: lot, service_account_id: accounts[pa.id], state: "applied", result_status: "pending", fulfillment_status: "none" });
  const appB = await ins("applications", { household_id: hid, lottery_id: lot, service_account_id: accounts[pb.id], state: "applied", result_status: "pending", fulfillment_status: "none" });
  try {
    await page.goto("/lotteries");
    await page.getByRole("tab", { name: /応募済み/ }).click(); // A・Bとも応募済み
    const card = page.locator(`[data-lottery-id="${lot}"]`);
    await card.getByRole("button", { name: /の詳細を開く/ }).first().click();
    const detail = page.getByTestId("lottery-detail-sheet");
    await expect(detail).toBeVisible();

    // ---- 詳細のレイアウト
    // 日付・期間は1項目ごとの独立した角丸カード（2列）
    const dates = detail.getByTestId("date-cards");
    await expect(dates.locator("[data-label]").first()).toBeVisible();
    const labels = await dates.locator("[data-label]").evaluateAll((els) => els.map((e) => e.getAttribute("data-label")));
    expect(labels.slice(0, 3)).toEqual(["応募開始", "応募締切", "当選発表"]);
    const boxes = await dates.locator("[data-label]").evaluateAll((els) => els.map((e) => e.getBoundingClientRect().toJSON()));
    expect(Math.abs(boxes[0].y - boxes[1].y)).toBeLessThan(2); // 1行目に2枚（2列）
    expect(boxes[1].x).toBeGreaterThan(boxes[0].x + boxes[0].width - 1);
    // ステータス行は1行（左=状態、右=現在のプロフィールの応募状態）
    const line = await detail.getByTestId("status-line").boundingBox();
    expect(line!.height).toBeLessThan(40);
    await expect(detail.getByTestId("my-status")).toBeVisible();
    // 管理情報（登録経路）は下部
    const adminY = (await detail.getByTestId("admin-info").boundingBox())!.y;
    const datesY = (await dates.boundingBox())!.y;
    expect(adminY).toBeGreaterThan(datesY);
    const w = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(w).toBeLessThanOrEqual(1);
    await page.screenshot({ path: "docs/screenshots/stage7j-detail-mobile.png" });

    // ---- 編集: 「応募時に店舗選択」へ変更（応募済みの履歴は変わらない）
    await detail.getByRole("button", { name: "編集" }).click();
    const form = page.getByTestId("lottery-form");
    await expect(form).toBeVisible();
    // 入力途中の再開はしない: 何か入力して閉じる → 破棄の確認 → 破棄 → 開き直すと保存済みの内容から始まる
    await form.getByTestId("store-mode").selectOption("select_on_apply");
    await expect(form.getByTestId("store-mode-applied-note")).toContainText("応募の履歴は変わりません");
    await form.getByTestId("form-discard").click();
    await expect(form.getByTestId("form-confirm")).toContainText("入力中の内容を破棄");
    await form.getByRole("button", { name: "破棄して閉じる" }).click();
    await expect(form).toHaveCount(0);
    expect((await a.from("lotteries").select("store_mode").eq("id", lot).single()).data!.store_mode).toBe("fixed"); // 破棄したので保存されていない
    await detail.getByRole("button", { name: "編集" }).click();
    await expect(page.getByTestId("lottery-form").getByTestId("store-mode")).toHaveValue("fixed"); // 前回の未保存の入力は復元されない
    await page.getByTestId("lottery-form").getByTestId("store-mode").selectOption("select_on_apply");
    await page.getByTestId("lottery-form").getByRole("button", { name: "保存" }).click();
    await expect(page.getByTestId("lottery-form")).toHaveCount(0);
    await expect.poll(async () => (await a.from("lotteries").select("store_mode").eq("id", lot).single()).data?.store_mode).toBe("select_on_apply");
    // 応募の履歴は消えない（A・Bとも応募済みのまま。店舗は未設定）
    const rows = (await a.from("applications").select("id,state,applied_store_name").eq("lottery_id", lot)).data!;
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.state === "applied" && r.applied_store_name === "")).toBe(true);

    // ---- 現在のプロフィール(A)の応募店舗が未設定 → 入力を求める → 入力
    const missing = detail.getByTestId("applied-store-missing");
    await expect(missing).toContainText("応募店舗が未設定");
    await missing.getByTestId("applied-store-edit").click();
    const dlg = page.getByRole("dialog").last();
    await expect(dlg).toContainText("Aの応募として記録");
    await dlg.getByRole("button", { name: "7J梅田店" }).click(); // 同系列の店舗の候補からワンタップで選べる
    await dlg.getByRole("button", { name: "決定" }).click();
    await expect.poll(async () => (await a.from("applications").select("applied_store_name").eq("id", appA).single()).data?.applied_store_name).toBe("7J梅田店");
    // Bの記録は勝手に変わらない
    expect((await a.from("applications").select("applied_store_name,state").eq("id", appB).single()).data).toMatchObject({ applied_store_name: "", state: "applied" });
    await expect(detail.getByTestId("applied-store-missing")).toHaveCount(0);
  } finally {
    await a.from("applications").delete().eq("lottery_id", lot);
    await a.from("lottery_management").delete().eq("lottery_id", lot);
    await a.from("lottery_items").delete().eq("lottery_id", lot);
    await a.from("lotteries").delete().eq("id", lot);
  }
});

test("購入記録: 商品名は正式名称（略称ではない）。最大2行で、数量・金額と重ならない（商品別累計・購入履歴の両方）", async ({ page }) => {
  test.setTimeout(120_000);
  await login(page);
  const hid = await household();
  const a = admin();
  const longName = "7J正式名称の確認用の長い商品名 スペシャルエディション 30th CELEBRATION プレミアムBOX";
  const prod = (await a.from("products").insert({ household_id: hid, official_name: longName, packs_per_box: 30 } as never).select("id").single()).data!.id as string;
  await a.from("product_aliases").insert({ household_id: hid, product_id: prod, alias: "7J略称30th", normalized_alias: "7j略称30th" } as never);
  const today = new Date(Date.now() + 9 * 3600_000).toISOString();
  const pu = (await a.from("purchases").insert({ household_id: hid, purchased_at: today, channel: "store", source_kind: "manual", category: "pokemon_card" } as never).select("id").single()).data!.id as string;
  await a.from("purchase_items").insert({ household_id: hid, purchase_id: pu, product_id: prod, quantity: 3, unit: "box", amount_paid: 21600 } as never);
  try {
    await page.goto("/purchases");
    const total = page.getByTestId("product-total-row").filter({ hasText: "7J正式名称" });
    await expect(total).toHaveCount(1);
    await expect(total.getByTestId("total-name")).toContainText("30th CELEBRATION プレミアムBOX"); // 正式名称（略称ではない）
    await expect(total).not.toContainText("7J略称30th");
    const nameBox = (await total.getByTestId("total-name").boundingBox())!;
    const qtyBox = (await total.getByTestId("total-qty").boundingBox())!;
    expect(nameBox.x + nameBox.width).toBeLessThanOrEqual(qtyBox.x + 1); // 数量と重ならない
    expect(nameBox.height).toBeLessThan(50); // 最大2行
    await page.getByTestId("tab-history").click();
    const row = page.getByTestId("purchase-row").filter({ hasText: "7J正式名称" });
    await expect(row.getByTestId("purchase-title")).toContainText("プレミアムBOX");
    await expect(row).not.toContainText("7J略称30th");
    const tb = (await row.getByTestId("purchase-title").boundingBox())!;
    const ab = (await row.getByTestId("purchase-amount").boundingBox())!;
    expect(tb.x + tb.width).toBeLessThanOrEqual(ab.x + 1); // 金額と重ならない
    expect(tb.height).toBeLessThan(50);
  } finally {
    await a.from("purchase_items").delete().eq("purchase_id", pu);
    await a.from("purchases").delete().eq("id", pu);
  }
});
