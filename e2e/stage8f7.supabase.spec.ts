import { createClient } from "@supabase/supabase-js";
import { expect, test, type Page } from "@playwright/test";

/**
 * Stage 8F-7 の画面確認: 店舗選択式の二重登録の整理候補（実Supabaseのテスト世帯・架空データ・モバイル幅）。
 *   E2E_SPEC=stage8f7.supabase.spec.ts npm run test:e2e:supabase
 *  - 整理候補: 店舗選択式のカードと同じ情報源の店舗別カードが並び、応募の記録があるカードは「退避しない」と示される
 *  - 「整理する」は2回目の確認で実行。記録の無いカードだけ退避し、元に戻せる
 *  - 「別の抽選として残す」: 候補から外れる。「分類を解除」で戻る
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
async function noHorizontalOverflow(page: Page) {
  const over = await page.evaluate(() => {
    const sc = document.getElementById("app-scroll") ?? document.documentElement;
    return { sw: sc.scrollWidth, cw: sc.clientWidth, dw: document.documentElement.scrollWidth, dcw: document.documentElement.clientWidth };
  });
  expect(over.sw, JSON.stringify(over)).toBeLessThanOrEqual(over.cw + 1);
  expect(over.dw, JSON.stringify(over)).toBeLessThanOrEqual(over.dcw + 1);
}

test("店舗選択式の整理候補: 退避は記録の無いカードだけ・元に戻せる・別の抽選として残す", async ({ page }) => {
  test.setTimeout(300_000);
  page.setDefaultTimeout(20_000);
  await login(page);
  const hid = await household();
  const a = admin();
  const ins = async (table: string, row: Record<string, unknown>) => {
    const { data, error } = await a.from(table).insert(row as never).select("id").single();
    expect(error?.message, table).toBeUndefined();
    return (data as { id: string }).id;
  };
  const day = (n: number) => new Date(Date.now() + n * 86_400_000 + 9 * 3600_000).toISOString().slice(0, 10);
  const chain = await ins("chains", { household_id: hid, name: "8F7電機" });
  const prod = await ins("products", { household_id: hid, official_name: "8F7商品ベータ", packs_per_box: 20 });
  const phantom = await ins("stores", { household_id: hid, chain_id: chain, name: "応募時に店舗選択", prefecture: "" });
  const s1 = await ins("stores", { household_id: hid, chain_id: chain, name: "8F7一号店", prefecture: "兵庫県" });
  const s2 = await ins("stores", { household_id: hid, chain_id: chain, name: "8F7二号店", prefecture: "兵庫県" });
  const url = "https://example.invalid/8f7/e2e";
  const base = { household_id: hid, chain_id: chain, apply_start_precision: "date_only", apply_start_date: day(-1), apply_deadline_precision: "date_only", apply_deadline_date: day(6), result_precision: "date_only", result_date: day(9), receive_method: "store", apply_method: "web", event_state: "open", limit_basis: "account", limit_max_count: 1, source_kind: "manual", registration_path: "manual", source_urls: [url] };
  const mk = async (store: string, over: Record<string, unknown> = {}) => {
    const id = await ins("lotteries", { ...base, store_id: store, ...over });
    await ins("lottery_items", { household_id: hid, lottery_id: id, product_id: prod, quantity: 1, unit: "box" });
    return id;
  };
  const sel = await mk(phantom, { store_mode: "select_on_apply" });
  const l1 = await mk(s1);
  const l2 = await mk(s2);
  const { data: accs } = await a.from("accounts").select("id").eq("household_id", hid).limit(1);
  const accountId = accs?.[0]?.id as string | undefined;
  if (accountId) {
    const { error } = await a.from("applications").insert({ household_id: hid, lottery_id: l1, account_id: accountId, state: "applied", applied_at: new Date().toISOString() } as never);
    expect(error?.message).toBeUndefined();
  }

  await page.goto("/settings/lottery-grouping");
  const panel = page.getByTestId("select-cleanup");
  const cand = panel.getByTestId("cleanup-candidate").filter({ hasText: "8F7電機" });
  await expect(cand).toHaveCount(1);
  await expect(cand.getByTestId("cleanup-card")).toHaveCount(3);
  if (accountId) await expect(cand.getByTestId("cleanup-card").filter({ hasText: "8F7一号店" })).toContainText("応募の記録あり");
  await noHorizontalOverflow(page);
  await page.screenshot({ path: "test-results/8f7-cleanup-390.png", fullPage: false });

  // 1回目のクリックは確認に変わるだけ（実行しない）
  await cand.getByTestId("cleanup-consolidate").click();
  await expect(cand.getByTestId("cleanup-consolidate")).toContainText("本当に整理する");
  const archivedOf = async (id: string) => ((await a.from("lotteries").select("archived_at").eq("id", id).single()).data as { archived_at: string | null }).archived_at;
  expect(await archivedOf(l2)).toBeNull();
  await cand.getByTestId("cleanup-consolidate").click();
  await expect(page.getByTestId("cleanup-msg")).toContainText("退避しました");
  expect(await archivedOf(l2)).not.toBeNull();
  if (accountId) expect(await archivedOf(l1)).toBeNull(); // 応募の記録があるカードは退避しない
  expect(await archivedOf(sel)).toBeNull();

  // 元に戻す
  await page.getByTestId("cleanup-archived").locator("summary").click();
  // 退避したカードをすべて元に戻す（応募の記録のあるカードは退避されていないため、口座が無い環境では2件、ある環境では1件）
  for (let n = 0; n < 3 && (await page.getByTestId("cleanup-restore").count()) > 0; n++) {
    await page.getByTestId("cleanup-restore").first().click();
    await expect(page.getByTestId("cleanup-msg")).toContainText("元に戻しました");
    await page.waitForTimeout(500);
    if ((await page.getByTestId("cleanup-restore").count()) > 0 && !(await page.getByTestId("cleanup-restore").first().isVisible())) await page.getByTestId("cleanup-archived").locator("summary").click();
  }
  expect(await archivedOf(l2)).toBeNull();
  expect(await archivedOf(l1)).toBeNull();

  // 別の抽選として残す → 候補から外れ、分類を解除すると戻る
  const cand2 = panel.getByTestId("cleanup-candidate").filter({ hasText: "8F7電機" });
  await cand2.getByTestId("cleanup-keep").click();
  await expect(page.getByTestId("cleanup-msg")).toContainText("分類を記録しました");
  await expect(panel.getByTestId("cleanup-candidate").filter({ hasText: "8F7電機" })).toHaveCount(0);
  const { data: forms } = await a.from("lotteries").select("lottery_form,lottery_form_source").in("id", [l1, l2]);
  expect((forms as { lottery_form: string; lottery_form_source: string }[]).every((f) => f.lottery_form === "store_independent" && f.lottery_form_source === "manual")).toBe(true);
});
