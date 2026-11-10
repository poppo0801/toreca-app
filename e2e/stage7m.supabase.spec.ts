import { createClient } from "@supabase/supabase-js";
import { expect, test, type Page } from "@playwright/test";

/**
 * Stage 7M の画面確認（実Supabaseのテスト世帯・架空データ）。
 *   E2E_SPEC=stage7m.supabase.spec.ts npm run test:e2e:supabase
 *  - 抽選詳細: 確認が必要な点は初期は閉じ、「要確認（○件）」。開くと全文
 *  - 複数商品の抽選: 応募済みで商品選択 → 選んだ商品だけ応募。応募済みタブには応募した商品だけ表示。応募商品の変更
 *  - 通知: 要手動確認は通知に出さない／抽選候補: 状態の絞り込み（要確認）
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

test("複数商品の商品別応募・確認事項の折りたたみ・通知から要手動確認を除外・抽選候補の状態絞り込み", async ({ page }) => {
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
  const { data: profs } = await a.from("profiles").select("id,label,is_admin").eq("household_id", hid).eq("active", true).order("sort_order");
  const me = profs![0];
  const wasAdmin = me.is_admin;
  await a.from("profiles").update({ is_admin: true }).eq("id", me.id);
  const day = (n: number) => new Date(Date.now() + n * 86_400_000 + 9 * 3600_000).toISOString().slice(0, 10);

  const chain = await ins("chains", { household_id: hid, name: "7M電機" });
  const pA = await ins("products", { household_id: hid, official_name: "7M商品アルファ", packs_per_box: 20 });
  const pB = await ins("products", { household_id: hid, official_name: "7M商品ベータ", packs_per_box: 20 });
  const store = await ins("stores", { household_id: hid, chain_id: chain, name: "7M駅前店", prefecture: "兵庫県" });
  const cautions = [{ code: "result_date_unknown", field: "resultDate", message: "当選発表日が確認できていません", at: new Date().toISOString() }];
  const lot = await ins("lotteries", { household_id: hid, chain_id: chain, store_id: store, multi_mode: "all", apply_deadline_precision: "date_only", apply_deadline_date: day(10), receive_method: "store", apply_method: "web", event_state: "open", limit_basis: "account", limit_max_count: 5, source_kind: "manual", cautions } as never);
  const itemA = await ins("lottery_items", { household_id: hid, lottery_id: lot, product_id: pA, quantity: 1, unit: "box" });
  const itemB = await ins("lottery_items", { household_id: hid, lottery_id: lot, product_id: pB, quantity: 1, unit: "box" });
  await a.from("lottery_management").upsert({ lottery_id: lot, household_id: hid, is_managed: true, managed_source: "manual" } as never, { onConflict: "lottery_id" });
  const key = "https://s7m-e2e.example.invalid/manual";
  const cand = await ins("collection_candidates", { household_id: hid, dedupe_key: key, source_url: key, title: "7M要確認の候補", status: "pending", job_state: "review", kind: "new", reasons: ["要確認"], triage: "manual", manual_state: "open", manual_reason: "取得できませんでした", draft: {} });

  try {
    await page.goto("/lotteries");
    await page.getByRole("tab", { name: /要チェック/ }).click();
    const card = page.getByTestId("lottery-card").filter({ hasText: "7M駅前店" });
    await expect(card).toHaveCount(1);

    // 詳細: 確認が必要な点は初期は閉じ、見出しは「要確認（1件）」。開くと全文
    await card.getByRole("button", { name: /の詳細を開く/ }).first().click();
    const sheet = page.getByTestId("lottery-detail-sheet");
    await expect(sheet.getByTestId("caution-summary")).toContainText("要確認（1件）");
    await expect(sheet.getByTestId("caution-result_date_unknown")).toBeHidden();
    await sheet.getByTestId("caution-summary").click();
    await expect(sheet.getByTestId("caution-result_date_unknown")).toHaveText("当選発表日が確認できていません");
    // Stage 7N: 「確認済みにする」→ ブロックが消え、解除状態がDBに保存される（再読み込み後も復活しない）
    await sheet.getByTestId("caution-ack").click();
    await expect(sheet.getByTestId("caution-section")).toHaveCount(0);
    await expect.poll(async () => (((await a.from("lotteries").select("cautions").eq("id", lot).single()).data?.cautions ?? []) as { ackAt?: string }[])[0]?.ackAt).toBeTruthy();
    await page.reload();
    await page.getByRole("tab", { name: /要チェック/ }).click();
    await page.getByTestId("lottery-card").filter({ hasText: "7M駅前店" }).getByRole("button", { name: /の詳細を開く/ }).first().click();
    await expect(page.getByTestId("lottery-detail-sheet")).toBeVisible();
    await expect(page.getByTestId("caution-section")).toHaveCount(0);
    await page.keyboard.press("Escape");

    // 応募済みにする → 商品選択（初期は全商品）。商品ベータの選択を外して確定 → 商品アルファだけ応募
    await card.getByTestId("my-apply").first().click();
    const picker = page.getByTestId("item-picker");
    await expect(picker).toBeVisible();
    const checks = picker.getByTestId("item-picker-check");
    await expect(checks).toHaveCount(2);
    await expect(checks.nth(0)).toBeChecked();
    await expect(checks.nth(1)).toBeChecked();
    await checks.nth(1).uncheck();
    await picker.getByTestId("item-picker-ok").click();
    await expect.poll(async () => ((await a.from("applications").select("applied_item_ids,state").eq("lottery_id", lot)).data ?? [])[0]?.applied_item_ids).toEqual([itemA]);

    // 応募済みタブ: 応募した商品だけ表示（未応募の商品ベータは出さない）
    await page.getByRole("tab", { name: /応募済み/ }).click();
    const applied = page.getByTestId("lottery-card").filter({ hasText: "7M駅前店" });
    await expect(applied).toHaveCount(1);
    await expect(applied).toContainText("7M商品アルファ");
    await expect(applied).not.toContainText("7M商品ベータ");

    // 詳細から応募商品を変更（ベータも追加）
    await applied.first().getByRole("button", { name: /の詳細を開く/ }).first().click();
    await expect(sheet.getByTestId("applied-items-names")).toHaveText("7M商品アルファ");
    await sheet.getByTestId("applied-items-edit").click();
    const p2 = page.getByTestId("item-picker");
    await p2.getByTestId("item-picker-check").nth(1).check();
    await p2.getByTestId("item-picker-ok").click();
    await expect.poll(async () => ((await a.from("applications").select("applied_item_ids").eq("lottery_id", lot)).data ?? [])[0]?.applied_item_ids?.length).toBe(2);
    await page.keyboard.press("Escape");

    // 通知: 要手動確認は通知に出さない（期限に関する通知だけ）
    await page.goto("/lotteries");
    await page.getByTestId("notification-bell").click();
    await expect(page.getByRole("dialog").filter({ hasText: "の通知" })).toBeVisible();
    await expect(page.getByTestId("manual-section")).toHaveCount(0);
    await expect(page.getByRole("dialog").filter({ hasText: "の通知" })).not.toContainText("要手動確認");
    await page.keyboard.press("Escape");

    // 抽選候補: 状態の絞り込み（要確認）。要手動確認の案件は抽選候補で管理する
    await page.goto("/lotteries/candidates");
    await page.getByTestId("candidates-state").selectOption("check");
    await expect(page.getByTestId("candidate-card").filter({ hasText: "7M要確認の候補" })).toHaveCount(1);
    await page.getByTestId("candidates-state").selectOption("done");
    await expect(page.getByTestId("candidate-card").filter({ hasText: "7M要確認の候補" })).toHaveCount(0);
  } finally {
    await a.from("applications").delete().eq("lottery_id", lot);
    await a.from("lottery_management").delete().eq("lottery_id", lot);
    await a.from("lottery_items").delete().eq("lottery_id", lot);
    await a.from("lotteries").delete().eq("id", lot);
    await a.from("collection_candidates").delete().eq("id", cand);
    await a.from("stores").delete().eq("id", store);
    await a.from("chains").delete().eq("id", chain);
    await a.from("products").delete().in("id", [pA, pB]);
    await a.from("profiles").update({ is_admin: wasAdmin }).eq("id", me.id);
  }
});
