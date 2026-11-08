import { createClient } from "@supabase/supabase-js";
import { expect, test, type Page } from "@playwright/test";

/**
 * Stage 7E の画面確認（実Supabaseのテスト世帯・架空データ・複数プロフィール）。
 *   E2E_SPEC=stage7e.supabase.spec.ts npm run test:e2e:supabase
 *  - 第二ユーザーの「応募済み」: 再読み込み後（端末に第二ユーザーが保存された状態）でも、エラーなく第二ユーザー自身の応募として保存。Aの応募は変わらない
 *  - 購入記録: 商品別の累計が初期表示、4項目の集計、購入履歴は日付見出しなし・数量→単位・コレクション追加リンクなし
 *  - 支出: シングルカード（枚固定）の登録 → 収支・購入記録へ反映
 *  - 標準画像の登録・差し替え・削除と、購入記録への反映
 *  - 当選タブ: 受取の記録で右へスライドして消え、下のカードが詰まる
 */
const email = process.env.E2E_EMAIL!;
const password = process.env.E2E_PASSWORD!;
const admin = () => createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false, autoRefreshToken: false } });
// 1x1 の PNG
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");

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
async function switchProfile(page: Page, label: string) {
  await page.getByRole("button", { name: /ユーザー切り替え/ }).click();
  await page.getByRole("radio", { name: `プロフィール ${label}` }).click();
  await page.keyboard.press("Escape");
}
async function setup(hid: string, name: string) {
  const a = admin();
  const ins = async (table: string, row: Record<string, unknown>) => {
    const { data, error } = await a.from(table).insert(row as never).select("id").single();
    expect(error?.message, table).toBeUndefined();
    return (data as { id: string }).id;
  };
  const { data: profs } = await a.from("profiles").select("id,label").eq("household_id", hid).order("sort_order");
  const chain = await ins("chains", { household_id: hid, name });
  const one = async (table: string, make: () => Promise<string>) => {
    const { data } = await a.from(table).select("id").eq("household_id", hid).limit(1).maybeSingle();
    return data ? (data as { id: string }).id : make();
  };
  const fam = await one("family_groups", () => ins("family_groups", { household_id: hid, label: "7E家族" }));
  const adr = await one("address_groups", () => ins("address_groups", { household_id: hid, label: "7E住所" }));
  const idn = await ins("identities", { household_id: hid, display_label: `${name}名義`, family_group_id: fam, address_group_id: adr });
  const accounts: Record<string, string> = {};
  for (const p of profs ?? []) accounts[p.id] = await ins("service_accounts", { household_id: hid, chain_id: chain, identity_id: idn, managed_by_profile_id: p.id, account_label: `acc-${p.label}`, membership_state: "eligible" });
  const prod = await ins("products", { household_id: hid, official_name: `${name}商品`, packs_per_box: 20 });
  const store = await ins("stores", { household_id: hid, chain_id: chain, name: `${name}店`, prefecture: "大阪府" });
  return { a, ins, profs: profs ?? [], chain, accounts, prod, store };
}

test("第二ユーザーの応募済み: 再読み込み後でもエラーなく第二ユーザー自身の応募として保存され、Aの応募は変わらない（根本原因: 操作者が先頭のプロフィールになっていた）", async ({ page }) => {
  test.setTimeout(150_000);
  await login(page);
  const hid = await household();
  const { a, ins, profs, chain, accounts, prod, store } = await setup(hid, "7E応募");
  const [pa, pb] = profs;
  const mkLot = async (extra: Record<string, unknown> = {}) => {
    const lot = await ins("lotteries", { household_id: hid, chain_id: chain, store_id: store, apply_deadline_precision: "date_time", apply_deadline_at: "2099-01-10T14:59:00Z", receive_method: "store", apply_method: "web", event_state: "open", limit_basis: "account", limit_max_count: 5, source_kind: "manual", ...extra });
    await ins("lottery_items", { household_id: hid, lottery_id: lot, product_id: prod, quantity: 1, unit: "box" });
    await a.from("lottery_management").insert({ household_id: hid, lottery_id: lot, is_managed: true, managed_source: "manual" } as never);
    return lot;
  };
  const lot1 = await mkLot();
  // Aは先に応募済み
  await ins("applications", { household_id: hid, lottery_id: lot1, service_account_id: accounts[pa.id], state: "applied", result_status: "pending", fulfillment_status: "none" });
  try {
    await page.goto("/lotteries");
    await switchProfile(page, pb.label);
    // 再読み込み: アプリの状態は未設定に戻り、端末に保存した第二ユーザーが表示される（以前はこの状態で操作者が先頭のプロフィールになり、エラーになっていた）
    await page.reload();
    await expect(page.locator("header").getByTestId("current-profile")).toHaveText(pb.label);
    const card = page.getByTestId("lottery-card").filter({ hasText: "7E応募商品" });
    await expect(card).toHaveCount(1);
    await card.getByTestId("my-apply").click();
    await expect(page.getByText("他のユーザーの応募状況は変更できません")).toHaveCount(0);
    await expect.poll(async () => ((await a.from("applications").select("service_account_id,state").eq("lottery_id", lot1)).data ?? []).filter((r) => r.state === "applied").map((r) => r.service_account_id).sort()).toEqual([accounts[pa.id], accounts[pb.id]].sort());
    // Aの応募記録は書き換えられていない
    const rowA = (await a.from("applications").select("state,result_status,updated_by_profile_id").eq("lottery_id", lot1).eq("service_account_id", accounts[pa.id]).single()).data!;
    expect(rowA).toMatchObject({ state: "applied", result_status: "pending" });
    expect(rowA.updated_by_profile_id).not.toBe(pb.id);

    // 逆: Bのみ応募済みの抽選をAが（再読み込み後に）応募済みにする
    const lot2 = await mkLot();
    await ins("applications", { household_id: hid, lottery_id: lot2, service_account_id: accounts[pb.id], state: "applied", result_status: "pending", fulfillment_status: "none" });
    await switchProfile(page, pa.label);
    await page.reload();
    await expect(page.locator("header").getByTestId("current-profile")).toHaveText(pa.label);
    const cards = page.getByTestId("lottery-card").filter({ hasText: "7E応募商品" });
    await expect(cards.first()).toBeVisible();
    // A がまだ応募していないカード（lot2）の「応募済み」を押す
    const target = page.locator(`[data-lottery-id="${lot2}"]`);
    await target.getByTestId("my-apply").click();
    await expect(page.getByText("他のユーザーの応募状況は変更できません")).toHaveCount(0);
    await expect.poll(async () => ((await a.from("applications").select("service_account_id,state").eq("lottery_id", lot2)).data ?? []).filter((r) => r.state === "applied").length).toBe(2);
    // 同じ抽選のBの記録は変わっていない
    expect((await a.from("applications").select("state,result_status").eq("lottery_id", lot2).eq("service_account_id", accounts[pb.id]).single()).data).toMatchObject({ state: "applied", result_status: "pending" });
  } finally {
    for (const l of (await a.from("lotteries").select("id").eq("chain_id", chain)).data ?? []) {
      await a.from("applications").delete().eq("lottery_id", l.id);
      await a.from("lottery_management").delete().eq("lottery_id", l.id);
      await a.from("lottery_items").delete().eq("lottery_id", l.id);
      await a.from("lotteries").delete().eq("id", l.id);
    }
  }
});

test("購入記録と支出: シングルカード（枚固定）を登録すると収支・購入記録へ反映。商品別が初期表示で、履歴は日付見出しなし。標準画像の登録・差し替え・削除", async ({ page }) => {
  test.setTimeout(180_000);
  await login(page);
  const hid = await household();
  const a = admin();
  const prod = (await a.from("products").insert({ household_id: hid, official_name: "7E-BOX商品", packs_per_box: 20 } as never).select("id").single()).data!.id as string;
  const today = new Date(Date.now() + 9 * 3600_000).toISOString().slice(0, 10);
  const pu = (await a.from("purchases").insert({ household_id: hid, category: "pokemon_card", source_kind: "manual", purchased_date: today, channel: "store" } as never).select("id").single()).data!.id as string;
  await a.from("purchase_items").insert({ household_id: hid, purchase_id: pu, product_id: prod, quantity: 3, unit: "box", amount_paid: 21600 } as never);
  try {
    // 支出の登録（シングルカード）
    await page.goto("/finance");
    await page.getByRole("button", { name: "＋支出" }).click();
    const form = page.getByTestId("expense-form");
    await expect(form).toBeVisible();
    // 開いた直後に入力欄へフォーカスしない
    expect(await page.evaluate(() => /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement?.tagName ?? ""))).toBe(false);
    await form.getByTestId("expense-category").selectOption("single_card");
    await expect(form.getByTestId("unit-fixed")).toBeDisabled();
    await expect(form.getByTestId("unit-fixed")).toContainText("枚");
    await form.getByLabel("カード名1").fill("7Eピカチュウ");
    await form.getByLabel("数量1").fill("6");
    await form.getByLabel("購入金額1").fill("6260");
    await page.waitForTimeout(500); // 位置を測る前に、シートの開閉アニメーションと再描画を待つ
    // 数量と単位は同じ行に横並び
    const q = (await form.getByLabel("数量1").boundingBox())!;
    const u = (await form.getByLabel("単位1").boundingBox())!;
    expect(Math.abs(q.y - u.y)).toBeLessThan(6);
    expect(u.x).toBeGreaterThan(q.x + q.width);
    await form.getByRole("button", { name: "保存" }).click();
    await expect(form).toHaveCount(0);
    const row = page.getByTestId("ledger-row").filter({ hasText: "7Eピカチュウ" });
    await expect(row).toHaveCount(1);
    await expect(row.getByTestId("row-category")).toHaveText("シングル");

    // 標準画像（シングルカード）を登録 → 購入記録へ反映
    await page.goto("/settings/display");
    const std = page.getByTestId("default-image-single_card");
    await expect(std).toBeVisible();
    await page.getByTestId("default-image-file-single_card").setInputFiles({ name: "std.png", mimeType: "image/png", buffer: PNG });
    await expect(std.getByTestId("default-image-preview")).toBeVisible();
    expect((await a.from("item_default_images").select("category").eq("household_id", hid)).data).toHaveLength(1);

    // 購入記録: 商品別が初期表示
    await page.goto("/purchases");
    await expect(page.getByTestId("tab-products")).toHaveAttribute("aria-selected", "true");
    await expect(page.getByTestId("product-totals")).toBeVisible();
    const totalRow = (name: string) => page.getByTestId("product-total-row").filter({ hasText: name });
    await expect(totalRow("7E-BOX商品").getByTestId("total-qty")).toHaveText("60パック");
    await expect(totalRow("7E-BOX商品").getByTestId("total-sub")).toHaveText("3BOX ｜ 購入総額 21,600円");
    await expect(totalRow("7Eピカチュウ").getByTestId("total-qty")).toHaveText("6枚");
    await expect(totalRow("7Eピカチュウ").getByTestId("default-image")).toBeVisible(); // 標準画像
    await expect(totalRow("7E-BOX商品").getByTestId("default-image")).toHaveCount(0); // 商品個別（画像なし）はシングル用の標準画像を使わない
    // 上部の集計（横4分割・コンパクト）
    await expect(page.getByTestId("stat-box")).toContainText("3");
    await expect(page.getByTestId("stat-pack")).toContainText("60");
    const sb = (await page.getByTestId("purchase-summary").boundingBox())!;
    expect(sb.height).toBeLessThan(70);
    // 購入履歴: 日付見出しなし・数量→単位・コレクション追加リンクなし・金額は右寄せ
    await page.getByTestId("tab-history").click();
    const hist = page.getByTestId("purchase-row").filter({ hasText: "7Eピカチュウ" });
    await expect(hist.getByTestId("purchase-qty")).toHaveText("6枚");
    await expect(hist.getByTestId("purchase-date")).toBeVisible();
    await expect(page.getByTestId("to-collection")).toHaveCount(0);
    await expect(hist.getByTestId("default-image")).toBeVisible();
    const amountBoxes = await page.getByTestId("purchase-amount").evaluateAll((els) => els.map((e) => e.getBoundingClientRect().right));
    expect(Math.max(...amountBoxes) - Math.min(...amountBoxes)).toBeLessThan(1);
    // 標準画像の削除 → 画像なしの代替表示
    await page.goto("/settings/display");
    await page.getByTestId("default-image-delete-single_card").click();
    await expect(page.getByTestId("default-image-single_card").getByTestId("default-image-preview")).toHaveCount(0);
    expect((await a.from("item_default_images").select("category").eq("household_id", hid)).data).toHaveLength(0);
    await page.goto("/purchases");
    await expect(page.getByTestId("product-total-row").filter({ hasText: "7Eピカチュウ" }).getByTestId("default-image")).toHaveCount(0);
    await expect(page.getByTestId("product-total-row").filter({ hasText: "7Eピカチュウ" }).getByTestId("image-placeholder")).toBeVisible();
  } finally {
    await a.from("item_default_images").delete().eq("household_id", hid);
    for (const r of (await a.from("purchases").select("id").eq("household_id", hid).or("category.eq.single_card,id.eq." + pu)).data ?? []) {
      await a.from("purchase_items").delete().eq("purchase_id", r.id);
      await a.from("purchases").delete().eq("id", r.id);
    }
    await a.from("products").delete().eq("id", prod);
  }
});

test("当選タブ: 受取を記録すると、カードが右へスライドして消え、下のカードが詰まる。件数が更新される", async ({ page }) => {
  test.setTimeout(150_000);
  await login(page);
  const hid = await household();
  const { a, ins, profs, chain, accounts, prod, store } = await setup(hid, "7E当選");
  const jst = (n: number) => new Date(Date.now() + n * 86_400_000 + 9 * 3600_000).toISOString().slice(0, 10);
  const mk = async () => {
    const lot = await ins("lotteries", { household_id: hid, chain_id: chain, store_id: store, apply_deadline_precision: "date_only", apply_deadline_date: jst(-10), receive_method: "store", apply_method: "web", event_state: "closed", limit_basis: "account", limit_max_count: 5, source_kind: "manual", procedure_start_precision: "date_only", procedure_start_date: jst(-1), procedure_deadline_precision: "date_only", procedure_deadline_date: jst(5) });
    await ins("lottery_items", { household_id: hid, lottery_id: lot, product_id: prod, quantity: 1, unit: "box" });
    await ins("applications", { household_id: hid, lottery_id: lot, service_account_id: accounts[profs[0].id], state: "applied", result_status: "won", fulfillment_status: "none" });
    return lot;
  };
  const l1 = await mk();
  const l2 = await mk();
  try {
    await page.goto("/lotteries");
    await page.getByRole("tab", { name: /当選/ }).click();
    const cards = page.getByTestId("lottery-card").filter({ hasText: "7E当選商品" });
    await expect(cards).toHaveCount(2);
    const first = cards.first();
    const id = (await first.getAttribute("data-lottery-id"))!;
    const other = cards.nth(1);
    const otherBefore = (await other.boundingBox())!;
    const li = page.locator(`li[data-exit], li:has([data-lottery-id="${id}"])`).filter({ has: page.locator(`[data-lottery-id="${id}"]`) }).first();
    await first.getByRole("button", { name: "受取を記録" }).click();
    // スライドのフェーズが現れる（hold → sliding → collapsing）
    await expect(li).toHaveAttribute("data-exit", /hold|sliding|collapsing/, { timeout: 5000 });
    await expect(page.locator(`[data-lottery-id="${id}"]`)).toHaveCount(0, { timeout: 8000 });
    // 残りのカードが上へ詰まる
    const otherAfter = (await page.locator(`[data-lottery-id="${id === l1 ? l2 : l1}"]`).boundingBox())!;
    expect(otherAfter.y).toBeLessThan(otherBefore.y);
    await expect(page.getByTestId("tab-count-won")).toHaveText("1");
    // 記録は残る（受取済み）
    expect((await a.from("applications").select("fulfillment_status,result_status").eq("lottery_id", id)).data?.[0]).toMatchObject({ fulfillment_status: "purchased", result_status: "won" });
  } finally {
    for (const l of [l1, l2]) {
      await a.from("applications").delete().eq("lottery_id", l);
      await a.from("lottery_items").delete().eq("lottery_id", l);
      await a.from("lotteries").delete().eq("id", l);
    }
  }
});
