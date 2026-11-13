import { createClient } from "@supabase/supabase-js";
import { expect, test, type Page } from "@playwright/test";

/**
 * Stage 9B の画面確認（実Supabaseのテスト世帯・架空データ・モバイル幅）。
 *   E2E_SPEC=stage9b.supabase.spec.ts npm run test:e2e:supabase
 *  - 自動更新された抽選: 詳細に「自動更新の履歴」（日時・内容・情報源）。「元に戻す」で更新前の締切に戻り、履歴は「元に戻しました」になる
 *  - 履歴の無い抽選・日時が不明な抽選: 履歴は出ない。日時不明の抽選も一覧（全情報）に表示される（締切の文字は出さない）
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

test("自動更新の履歴: 詳細で確認でき、元に戻せる。日時不明の抽選も一覧に表示される", async ({ page }) => {
  test.setTimeout(150_000);
  await login(page);
  const hid = await household();
  const a = admin();
  const chain = (await a.from("chains").insert({ household_id: hid, name: "9B-E2E系列" }).select("id").single()).data!.id as string;
  const sUpd = (await a.from("stores").insert({ household_id: hid, chain_id: chain, name: "9B更新店", prefecture: "大阪府" }).select("id").single()).data!.id as string;
  const sUnk = (await a.from("stores").insert({ household_id: hid, chain_id: chain, name: "9B不明店", prefecture: "大阪府" }).select("id").single()).data!.id as string;
  const prod = (await a.from("products").insert({ household_id: hid, official_name: "9B-E2E商品", packs_per_box: 30 }).select("id").single()).data!.id as string;
  const day = (n: number) => new Date(Date.now() + n * 86_400_000 + 9 * 3600_000).toISOString().slice(0, 10);
  const base = { household_id: hid, chain_id: chain, receive_method: "store", apply_method: "web", event_state: "open", limit_basis: "account", limit_max_count: 1, source_kind: "auto", registration_path: "auto", is_new: false };
  const mk = async (store: string, extra: Record<string, unknown>) => {
    const id = (await a.from("lotteries").insert({ ...base, store_id: store, ...extra } as never).select("id").single()).data!.id as string;
    await a.from("lottery_items").insert({ household_id: hid, lottery_id: id, product_id: prod, quantity: 1, unit: "box" } as never);
    return id;
  };
  const d1 = day(5);
  const d2 = day(9);
  const hist = [{ id: "11111111-1111-4111-8111-111111111111", at: new Date().toISOString(), keys: ["applyDeadline"], labels: ["応募締切"], before: { apply_deadline_precision: "date_only", apply_deadline_date: d1, apply_deadline_at: null }, after: { apply_deadline_precision: "date_only", apply_deadline_date: d2, apply_deadline_at: null }, afterKeys: { applyDeadline: `${d2}T23:59` }, summary: [`応募締切: ${d1} → ${d2}`], sourceUrl: "https://shop.example.invalid/lottery", sourceKind: "official_site", official: true }];
  const lUpd = await mk(sUpd, { apply_deadline_precision: "date_only", apply_deadline_date: d2, update_history: hist });
  await mk(sUnk, { apply_deadline_precision: "unknown", cautions: [{ code: "deadline_unknown", field: "applyDeadline", message: "応募締切が確認できていません", at: new Date().toISOString() }] });

  await page.goto("/lotteries");
  await page.getByRole("tab", { name: /全情報/ }).click();
  const card = (name: string) => page.getByTestId("lottery-card").filter({ hasText: name });
  await expect(card("9B更新店")).toHaveCount(1);
  await expect(card("9B不明店")).toHaveCount(1); // 日時不明の抽選も通常の一覧に表示される
  await noHorizontalOverflow(page);

  // 日時不明の抽選: 自動更新の履歴は出ない
  await card("9B不明店").getByRole("button", { name: /の詳細を開く/ }).first().click();
  const sheet = page.getByTestId("lottery-detail-sheet");
  await expect(sheet.getByTestId("update-history")).toHaveCount(0);
  await page.keyboard.press("Escape");

  // 自動更新された抽選: 履歴（内容・情報源）を確認し、元に戻す
  await card("9B更新店").getByRole("button", { name: /の詳細を開く/ }).first().click();
  const hs = sheet.getByTestId("update-history");
  await expect(hs).toBeVisible();
  await hs.locator("summary").click();
  await expect(hs.getByTestId("update-history-item")).toHaveCount(1);
  await expect(hs).toContainText("応募締切");
  await expect(hs).toContainText("公式の情報");
  await expect(hs).toContainText("shop.example.invalid");
  await noHorizontalOverflow(page);
  await page.screenshot({ path: "test-results/9b-history-390.png" });
  await hs.getByTestId("update-revert").click();
  await expect(hs).toContainText("元に戻しました");
  const row = (await a.from("lotteries").select("apply_deadline_date").eq("id", lUpd).single()).data as { apply_deadline_date: string };
  expect(row.apply_deadline_date).toBe(d1);
});
