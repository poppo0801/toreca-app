import { createClient } from "@supabase/supabase-js";
import { expect, test, type CDPSession, type Page } from "@playwright/test";

/**
 * Stage 7B の画面確認（実Supabaseのテスト世帯・架空データ・複数プロフィール）。
 *   E2E_SPEC=stage7b.supabase.spec.ts npm run test:e2e:supabase
 *  - 店舗選択式: 応募済みで店舗入力シート（候補・キャンセル・自由入力）、プロフィールA/Bで別の店舗、カード1枚のまま切替
 *  - 設定: スワイプ操作（プロフィール別）・日付表示B。保存後に再読み込みしても保持され、プロフィールで独立
 *  - タブ切替スワイプ（タッチ）。端のタブ・画面の端からの操作・カード操作モードでは切り替わらない
 *  - 当選タブ: ●は対応が必要な当選だけ。受取済みは一覧から外れ、記録は残る
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
async function switchProfile(page: Page, label: string) {
  await page.getByRole("button", { name: /ユーザー切り替え/ }).click();
  await page.getByRole("radio", { name: `プロフィール ${label}` }).click();
  await page.keyboard.press("Escape");
}
async function touchSwipe(cdp: CDPSession, page: Page, x: number, y: number, dx: number, dy = 0) {
  await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x, y }] });
  for (let i = 1; i <= 8; i++) {
    await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x: x + (dx * i) / 8, y: y + (dy * i) / 8 }] });
    await page.waitForTimeout(8);
  }
  await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
}

/** 系列・名義・各プロフィールのアカウントを用意する */
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
  const fam = await one("family_groups", () => ins("family_groups", { household_id: hid, label: "7B家族" }));
  const adr = await one("address_groups", () => ins("address_groups", { household_id: hid, label: "7B住所" }));
  const idn = await ins("identities", { household_id: hid, display_label: `${name}名義`, family_group_id: fam, address_group_id: adr });
  const accounts: Record<string, string> = {};
  for (const p of profs ?? []) accounts[p.id] = await ins("service_accounts", { household_id: hid, chain_id: chain, identity_id: idn, managed_by_profile_id: p.id, account_label: `acc-${p.label}`, membership_state: "eligible" });
  const prod = await ins("products", { household_id: hid, official_name: `${name}商品`, packs_per_box: 20 });
  return { a, ins, profs: profs ?? [], chain, accounts, prod };
}

test("店舗選択式: 店舗入力シート（候補・キャンセル・自由入力）。AとBで別の店舗を保存し、カードは1枚のままプロフィールで表示が変わる", async ({ page }) => {
  test.setTimeout(180_000);
  await login(page);
  const hid = await household();
  const { a, ins, profs, chain, prod } = await setup(hid, "7B選択式");
  expect(profs.length).toBeGreaterThanOrEqual(2);
  const ph = await ins("stores", { household_id: hid, chain_id: chain, name: "応募時に店舗選択", is_provisional: true });
  await ins("stores", { household_id: hid, chain_id: chain, name: "7B梅田店", prefecture: "大阪府" });
  await ins("stores", { household_id: hid, chain_id: chain, name: "7B三宮店", prefecture: "兵庫県" });
  const mkLot = async () => {
    const lot = await ins("lotteries", { household_id: hid, chain_id: chain, store_id: ph, store_mode: "select_on_apply", apply_deadline_precision: "date_time", apply_deadline_at: "2099-01-10T14:59:00Z", receive_method: "store", apply_method: "web", event_state: "open", limit_basis: "account", limit_max_count: 5, source_kind: "manual" });
    await ins("lottery_items", { household_id: hid, lottery_id: lot, product_id: prod, quantity: 1, unit: "box" });
    await a.from("lottery_management").insert({ household_id: hid, lottery_id: lot, is_managed: true, managed_source: "manual" } as never);
    return lot;
  };
  const lot = await mkLot();
  const [pa, pb] = profs;
  try {
    await page.goto("/lotteries");
    const card = () => page.getByTestId("lottery-card").filter({ hasText: "7B選択式商品" });
    await expect(card()).toHaveCount(1);
    // 応募前は「店舗選択式」
    await expect(card().getByTestId("store-name")).toContainText("店舗選択式");
    await card().getByTestId("my-apply").click();
    const sheet = page.getByTestId("applied-store-dialog");
    await expect(sheet).toBeVisible();
    // 候補が出る（5件以内）。キャンセルでは応募済みにならない
    const n = await sheet.getByTestId("store-candidate").count();
    expect(n).toBeGreaterThanOrEqual(2);
    expect(n).toBeLessThanOrEqual(5);
    await sheet.getByRole("button", { name: "キャンセル" }).click();
    await expect(sheet).toHaveCount(0);
    expect(((await a.from("applications").select("id").eq("lottery_id", lot)).data ?? []).length).toBe(0);
    // 候補をタップして確定 → プロフィールAの応募として保存
    await card().getByTestId("my-apply").click();
    await sheet.getByTestId("store-candidate").filter({ hasText: "7B梅田店" }).click();
    await sheet.getByTestId("applied-store-ok").click();
    await expect(sheet).toHaveCount(0);
    await expect.poll(async () => (await a.from("applications").select("applied_store_name,state").eq("lottery_id", lot)).data?.[0]).toMatchObject({ applied_store_name: "7B梅田店", state: "applied" });

    // プロフィールBに切り替え: 同じ抽選はまだ未応募（店舗選択式）。自由入力した店舗で応募する
    await page.reload();
    await switchProfile(page, pb.label);
    await expect(card()).toHaveCount(1);
    await expect(card().getByTestId("store-name")).toContainText("店舗選択式");
    await card().getByTestId("my-apply").click();
    await sheet.getByRole("combobox", { name: "応募先の店舗" }).fill("7B神戸店");
    await sheet.getByTestId("applied-store-ok").click();
    await expect(sheet).toHaveCount(0);
    await expect.poll(async () => ((await a.from("applications").select("applied_store_name").eq("lottery_id", lot)).data ?? []).map((r) => r.applied_store_name).sort()).toEqual(["7B梅田店", "7B神戸店"]);

    // 応募済みタブ: カードは1枚。Bの店舗が表示され、Aに切り替えるとAの店舗になる（Bの店舗は変わらない）
    await page.reload();
    await page.getByRole("tab", { name: /応募済み/ }).click();
    await expect(card()).toHaveCount(1);
    await expect(card().getByTestId("store-name")).toContainText(pb.label === pa.label ? "7B" : "7B神戸店");
    await switchProfile(page, pa.label);
    await page.getByRole("tab", { name: /応募済み/ }).click();
    await expect(card()).toHaveCount(1);
    await expect(card().getByTestId("store-name")).toContainText("7B梅田店");

    // 応募済み登録後に店舗を編集できる（現在のプロフィールの応募記録だけ）
    await card().click();
    const detail = page.getByTestId("lottery-detail-sheet");
    await detail.getByTestId("applied-store-edit").first().click();
    const edit = page.getByTestId("applied-store-dialog");
    await edit.getByTestId("store-candidate").filter({ hasText: "7B三宮店" }).click();
    await edit.getByTestId("applied-store-ok").click();
    await expect.poll(async () => ((await a.from("applications").select("applied_store_name,service_account_id").eq("lottery_id", lot)).data ?? []).map((r) => r.applied_store_name).sort()).toEqual(["7B三宮店", "7B神戸店"]);
  } finally {
    await a.from("applications").delete().eq("lottery_id", lot);
    await a.from("lottery_management").delete().eq("lottery_id", lot);
    await a.from("lottery_items").delete().eq("lottery_id", lot);
    await a.from("lotteries").delete().eq("id", lot);
  }
});

test("設定とタブ切替スワイプ: スワイプ操作・日付表示はプロフィール別に保存。タブ切替は左右スワイプ、端・画面の端・カード操作モードでは動かない", async ({ page }) => {
  test.setTimeout(180_000);
  await login(page);
  const hid = await household();
  const { a, ins, profs, chain, prod } = await setup(hid, "7B設定");
  const store = await ins("stores", { household_id: hid, chain_id: chain, name: "7B設定店", prefecture: "大阪府" });
  const lot = await ins("lotteries", { household_id: hid, chain_id: chain, store_id: store, apply_deadline_precision: "date_time", apply_deadline_at: "2099-01-10T14:59:00Z", receive_method: "store", apply_method: "web", event_state: "open", limit_basis: "account", limit_max_count: 5, source_kind: "manual" });
  await ins("lottery_items", { household_id: hid, lottery_id: lot, product_id: prod, quantity: 1, unit: "box" });
  await a.from("lottery_management").insert({ household_id: hid, lottery_id: lot, is_managed: true, managed_source: "manual" } as never);
  const [pa, pb] = profs;
  try {
    // 設定: Aをタブ切替・Bタイプにする
    await page.goto("/settings/display");
    await page.getByTestId("swipe-mode-tab").click();
    await page.getByTestId("date-layout-b").click();
    await expect.poll(async () => JSON.stringify((await a.from("profile_settings").select("profile_id,settings").eq("household_id", hid)).data ?? [])).toContain("\"swipeMode\":\"tab\"");
    await page.reload();
    await expect(page.getByTestId("swipe-mode-tab")).toHaveAttribute("aria-checked", "true");
    await expect(page.getByTestId("date-layout-b")).toHaveAttribute("aria-checked", "true");
    // Bは別の設定（既定のカード操作・Aタイプ）のまま
    await switchProfile(page, pb.label);
    await expect(page.getByTestId("swipe-mode-card")).toHaveAttribute("aria-checked", "true");
    await expect(page.getByTestId("date-layout-a")).toHaveAttribute("aria-checked", "true");
    await switchProfile(page, pa.label);

    // Aの抽選管理: Bタイプの日付表示（2行）、タブ切替モード
    await page.goto("/lotteries");
    const card = page.getByTestId("lottery-card").filter({ hasText: "7B設定商品" });
    await expect(card).toHaveCount(1);
    await expect(card.getByTestId("card-dates-b")).toBeVisible();
    await expect(page.getByTestId("board-content")).toHaveAttribute("data-swipe-mode", "tab");
    const selected = async () => (await page.getByRole("tab", { selected: true }).first().innerText()).replace(/\s+/g, "");
    const cdp = await page.context().newCDPSession(page);
    const w = page.viewportSize()!.width;
    const y = 520;
    await page.getByRole("tab", { name: /要チェック/ }).click();
    expect(await selected()).toContain("要チェック");
    await touchSwipe(cdp, page, Math.round(w * 0.75), y, -Math.round(w * 0.5)); // 左スワイプ → 次のタブ
    await expect.poll(selected).toContain("応募済み");
    await page.waitForTimeout(500);
    await touchSwipe(cdp, page, Math.round(w * 0.75), y, -Math.round(w * 0.5));
    await expect.poll(selected).toContain("当選");
    await touchSwipe(cdp, page, Math.round(w * 0.75), y, -Math.round(w * 0.5)); // 最後のタブではそれ以上動かない
    await page.waitForTimeout(400);
    expect(await selected()).toContain("当選");
    await touchSwipe(cdp, page, Math.round(w * 0.25), y, Math.round(w * 0.5)); // 右スワイプ → 前のタブ
    await expect.poll(selected).toContain("応募済み");
    // 縦のスワイプ・画面の端（戻る操作）からのスワイプでは切り替わらない
    await touchSwipe(cdp, page, Math.round(w * 0.5), 600, -30, -240);
    await touchSwipe(cdp, page, 6, y, Math.round(w * 0.5));
    await page.waitForTimeout(400);
    expect(await selected()).toContain("応募済み");
    // カードのタップは従来どおり（詳細が開く）
    await page.getByRole("tab", { name: /要チェック/ }).click();
    await card.getByRole("button", { name: /の詳細を開く/ }).first().click();
    await expect(page.getByTestId("lottery-detail-sheet")).toBeVisible();
    // 詳細（ボトムシート）の中のスワイプではタブは切り替わらない
    await touchSwipe(cdp, page, Math.round(w * 0.75), 400, -Math.round(w * 0.5));
    await page.waitForTimeout(400);
    await page.keyboard.press("Escape");
    expect(await selected()).toContain("要チェック");

    // プロフィールB（カード操作モード）: 同じ操作でタブは切り替わらない
    await switchProfile(page, pb.label);
    await expect(page.getByTestId("board-content")).toHaveAttribute("data-swipe-mode", "card");
    await page.getByRole("tab", { name: /要チェック/ }).click();
    await touchSwipe(cdp, page, Math.round(w * 0.75), 640, -Math.round(w * 0.5));
    await page.waitForTimeout(500);
    expect(await selected()).toContain("要チェック");
  } finally {
    await a.from("lottery_management").delete().eq("lottery_id", lot);
    await a.from("lottery_items").delete().eq("lottery_id", lot);
    await a.from("lotteries").delete().eq("id", lot);
    await a.from("profile_settings").delete().eq("household_id", hid);
  }
});

test("当選タブ: ●は対応が必要な当選だけ。受取済みは一覧から外れ、当選・受取の記録は残る", async ({ page }) => {
  test.setTimeout(150_000);
  await login(page);
  const hid = await household();
  const { a, ins, profs, chain, accounts, prod } = await setup(hid, "7B当選");
  const store = await ins("stores", { household_id: hid, chain_id: chain, name: "7B当選店", prefecture: "大阪府" });
  const jst = (n: number) => new Date(Date.now() + n * 86_400_000 + 9 * 3600_000).toISOString().slice(0, 10);
  const mk = async (extra: Record<string, unknown>) => {
    const lot = await ins("lotteries", { household_id: hid, chain_id: chain, store_id: store, apply_deadline_precision: "date_only", apply_deadline_date: jst(-10), receive_method: "store", apply_method: "web", event_state: "closed", limit_basis: "account", limit_max_count: 5, source_kind: "manual", ...extra });
    await ins("lottery_items", { household_id: hid, lottery_id: lot, product_id: prod, quantity: 1, unit: "box" });
    return lot;
  };
  const won = async (lot: string, fulfillment = "none") => ins("applications", { household_id: hid, lottery_id: lot, service_account_id: accounts[profs[0].id], state: "applied", result_status: "won", fulfillment_status: fulfillment });
  // 受取期間前の当選（対応不要）
  const lotFuture = await mk({ procedure_start_precision: "date_only", procedure_start_date: jst(5), procedure_deadline_precision: "date_only", procedure_deadline_date: jst(9) });
  await won(lotFuture);
  try {
    await page.goto("/lotteries");
    await expect(page.getByTestId("tab-dot-won")).toHaveCount(0); // 当選はあるが、まだ対応は要らない
    // 受取期間中の当選を追加 → ●が出る
    const lotNow = await mk({ procedure_start_precision: "date_only", procedure_start_date: jst(-1), procedure_deadline_precision: "date_only", procedure_deadline_date: jst(4) });
    await won(lotNow);
    await page.reload();
    await expect(page.getByTestId("tab-dot-won")).toBeVisible();
    await page.getByRole("tab", { name: /当選/ }).click();
    const card = page.locator(`[data-lottery-id="${lotNow}"]`);
    await expect(card).toHaveCount(1);
    // 受取を記録 → 一覧から外れ、●が消える。記録は残る
    await card.getByRole("button", { name: "受取を記録" }).click();
    await expect(card).toHaveCount(0);
    await expect(page.getByTestId("tab-dot-won")).toHaveCount(0);
    const rec = (await a.from("applications").select("result_status,fulfillment_status,state").eq("lottery_id", lotNow)).data ?? [];
    expect(rec).toHaveLength(1);
    expect(rec[0]).toMatchObject({ result_status: "won", fulfillment_status: "purchased", state: "applied" });
  } finally {
    for (const l of (await a.from("lotteries").select("id").eq("chain_id", chain)).data ?? []) {
      await a.from("applications").delete().eq("lottery_id", l.id);
      await a.from("lottery_items").delete().eq("lottery_id", l.id);
      await a.from("lotteries").delete().eq("id", l.id);
    }
  }
});
