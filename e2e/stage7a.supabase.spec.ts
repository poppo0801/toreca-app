import { createClient } from "@supabase/supabase-js";
import { expect, test, type Page } from "@playwright/test";

/**
 * Stage 7A の画面確認（実Supabaseのテスト世帯・架空データ）。
 *   E2E_SPEC=stage7a.supabase.spec.ts npm run test:e2e:supabase
 *  - 注意付きで自動登録された抽選: 一覧に小さな注意アイコン、詳細に「確認が必要な点」。通常の抽選にはどちらも出ない
 *  - 注意付きの抽選も★・応募済みなど通常の抽選として扱える（全情報に表示）
 *  - 系列の「店舗選択式を基本とする」設定の切り替え
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

test("注意付きの自動登録: 一覧の注意アイコンと詳細の確認事項。通常の抽選には出ない。系列の店舗選択式の設定を切り替えられる", async ({ page }) => {
  test.setTimeout(150_000);
  await login(page);
  const hid = await household();
  const a = admin();
  const chain = (await a.from("chains").insert({ household_id: hid, name: "7A-E2E系列" }).select("id").single()).data!.id as string;
  const sCaution = (await a.from("stores").insert({ household_id: hid, chain_id: chain, name: "7A注意店", prefecture: "大阪府" }).select("id").single()).data!.id as string;
  const sNormal = (await a.from("stores").insert({ household_id: hid, chain_id: chain, name: "7A通常店", prefecture: "大阪府" }).select("id").single()).data!.id as string;
  const prod = (await a.from("products").insert({ household_id: hid, official_name: "7A-E2E商品", packs_per_box: 30 }).select("id").single()).data!.id as string;
  const day = (n: number) => new Date(Date.now() + n * 86_400_000 + 9 * 3600_000).toISOString().slice(0, 10);
  const mk = async (store: string, extra: Record<string, unknown>) => {
    const id = (await a.from("lotteries").insert({ household_id: hid, chain_id: chain, store_id: store, apply_deadline_precision: "date_only", apply_deadline_date: day(10), receive_method: "store", apply_method: "web", event_state: "open", limit_basis: "account", limit_max_count: 5, source_kind: "auto", ...extra } as never).select("id").single()).data!.id as string;
    await a.from("lottery_items").insert({ household_id: hid, lottery_id: id, product_id: prod, quantity: 1, unit: "box" } as never);
    return id;
  };
  const cautions = [
    { code: "result_date_unknown", field: "resultDate", message: "当選発表日が確認できていません", at: new Date().toISOString() },
    { code: "deadline_conflict", field: "applyDeadline", message: "締切情報に相違があります。11/10と11/12の情報が確認されています（早い方の11/10を暫定表示しています）", values: ["11/10", "11/12"], at: new Date().toISOString() },
  ];
  const lc = await mk(sCaution, { cautions, confidence: "conflict" });
  const ln = await mk(sNormal, {});
  try {
    await page.goto("/lotteries");
    await page.getByRole("tab", { name: /全情報/ }).click();
    const card = (name: string) => page.getByTestId("lottery-card").filter({ hasText: name });
    await expect(card("7A注意店")).toHaveCount(1);
    await expect(card("7A通常店")).toHaveCount(1);
    // 注意付きにだけアイコン。通常の抽選には出ない
    await expect(card("7A注意店").getByTestId("caution-mark")).toBeVisible();
    await expect(card("7A通常店").getByTestId("caution-mark")).toHaveCount(0);
    // 注意アイコンは店舗名の行の中（NEW・★・応募状態と別の位置）
    const mark = await card("7A注意店").getByTestId("caution-mark").boundingBox();
    const star = await card("7A注意店").getByTestId("card-star").boundingBox();
    expect(mark && star && (mark.x > star.x + star.width || mark.y > star.y + star.height)).toBe(true);

    // 詳細: 確認が必要な点（項目別・理由別）。通常の抽選には出ない
    await card("7A注意店").getByRole("button", { name: /の詳細を開く/ }).first().click();
    const sheet = page.getByTestId("lottery-detail-sheet");
    await expect(sheet.getByTestId("caution-section")).toBeVisible();
    await sheet.getByTestId("caution-summary").click(); // 確認が必要な点は初期は閉じている
    await expect(sheet.getByTestId("caution-result_date_unknown")).toHaveText("当選発表日が確認できていません");
    await expect(sheet.getByTestId("caution-deadline_conflict")).toContainText("11/10と11/12");
    await page.keyboard.press("Escape");
    await card("7A通常店").getByRole("button", { name: /の詳細を開く/ }).first().click();
    await expect(sheet.getByTestId("caution-section")).toHaveCount(0);
    await page.keyboard.press("Escape");

    // 注意付きでも通常の抽選と同じように★登録できる
    await card("7A注意店").getByTestId("card-star").click();
    await expect.poll(async () => ((await a.from("lottery_management").select("is_managed").eq("lottery_id", lc)).data ?? []).some((m) => m.is_managed)).toBe(true);

    // 系列の店舗選択式を基本とする設定
    await page.goto("/settings/masters");
    await page.getByRole("tab", { name: "系列", exact: true }).click();
    const row = page.getByTestId("master-row").filter({ hasText: "7A-E2E系列" });
    await row.getByTestId("row-menu").evaluate((el) => ((el as HTMLDetailsElement).open = true));
    await expect(row.getByTestId("chain-store-select-toggle")).toContainText("OFF");
    await row.getByTestId("chain-store-select-toggle").click();
    await expect.poll(async () => (await a.from("chains").select("store_select_default").eq("id", chain).single()).data!.store_select_default).toBe(true);
  } finally {
    for (const id of [lc, ln]) {
      await a.from("lottery_management").delete().eq("lottery_id", id);
      await a.from("lottery_items").delete().eq("lottery_id", id);
      await a.from("lotteries").delete().eq("id", id);
    }
    await a.from("stores").delete().in("id", [sCaution, sNormal]);
    await a.from("chains").delete().eq("id", chain);
    await a.from("products").delete().eq("id", prod);
  }
});
