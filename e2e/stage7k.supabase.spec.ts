import { createClient } from "@supabase/supabase-js";
import { expect, test, type Page } from "@playwright/test";

/**
 * Stage 7K の画面確認（実Supabaseのテスト世帯・架空データ）。
 *   E2E_SPEC=stage7k.supabase.spec.ts npm run test:e2e:supabase
 *  - BOXを3BOX購入 → 未開封のうちは購入記録に出ない → コレクションで1BOX開封 → 開封1BOX・パック換算・購入単価の金額が加わる → 取り消すと戻る。収支の支出は変わらない
 *  - 収支の支出内訳は一本のバー（固定の順序）
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
const toAllPeriod = async (page: Page) => {
  await page.getByTestId("period-label").click();
  await page.getByTestId("period-picker").getByRole("tab", { name: "全期間" }).click();
};

test("購入記録: BOXは開封した時点で記録（購入単価の金額・パック換算）。未開封の購入は含めず、取り消しで戻り、収支の支出は変わらない", async ({ page }) => {
  test.setTimeout(180_000);
  page.on("dialog", (d) => d.accept());
  await login(page);
  const hid = await household();
  const a = admin();
  const prod = await a.from("products").insert({ household_id: hid, official_name: "7K正式名称BOX 30th CELEBRATION", packs_per_box: 20 } as never).select("id").single();
  expect(prod.error?.message).toBeUndefined();

  // 収支: 3BOXを合計21,600円で購入（支出）→ BOXコレクションに未開封3BOX
  await page.goto("/finance");
  const yen = (t: string) => Number(t.replace(/[^\d]/g, ""));
  await page.getByRole("button", { name: "＋支出" }).click();
  await page.getByLabel("商品1").fill("7K正式名称BOX");
  await page.getByRole("option", { name: /7K正式名称BOX/ }).click();
  await page.getByLabel("数量1").fill("3");
  await page.getByLabel("購入金額1").fill("21600");
  await page.getByRole("button", { name: "保存" }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(page.getByTestId("ledger-row").filter({ hasText: "7K正式名称BOX" })).toContainText("21,600");
  const expense = yen(await page.getByTestId("sum-expense").innerText());

  // 未開封のうちは購入記録に出ない
  await page.goto("/purchases");
  await toAllPeriod(page);
  await page.getByTestId("tab-history").click();
  await expect(page.getByTestId("purchase-row").filter({ hasText: "7K正式名称BOX" })).toHaveCount(0);

  // コレクション > BOX: 1BOX開封
  await page.goto("/collection?tab=box");
  const tile = page.getByTestId("box-tile").filter({ hasText: "7K正式名称BOX" });
  await expect(tile.getByTestId("box-tile-qty")).toHaveText("×3");
  await tile.getByRole("button").first().click();
  const detail = page.getByTestId("box-detail");
  await detail.getByTestId("box-open-btn").click();
  const dlg = page.getByTestId("box-open-dialog");
  await dlg.getByLabel("開封する数量").fill("1");
  await dlg.getByTestId("box-dialog-save").click();
  await expect(detail.getByTestId("state-unknown")).toContainText("2BOX");

  // 購入記録: 開封1BOX・20パック・7,200円（購入単価21,600÷3）。開封日の表示。未開封2BOXは含めない
  await page.goto("/purchases");
  await toAllPeriod(page);
  await page.getByTestId("filter-toggle").click();
  await page.getByLabel("商品で絞り込み").selectOption({ label: "7K正式名称BOX 30th CELEBRATION" });
  await expect(page.getByTestId("stat-box")).toContainText("1");
  await expect(page.getByTestId("stat-pack")).toContainText("20");
  await expect(page.getByTestId("stat-amount")).toContainText("¥7,200");
  const total = page.getByTestId("product-total-row").filter({ hasText: "7K正式名称BOX" });
  await expect(total.getByTestId("total-qty")).toHaveText("20パック");
  await expect(total.getByTestId("total-sub")).toHaveText("開封1BOX ｜ 総額 7,200円");
  await expect(total.getByTestId("total-name")).toContainText("7K正式名称BOX 30th CELEBRATION"); // 正式名称
  await page.getByTestId("tab-history").click();
  const row = page.getByTestId("purchase-row").filter({ hasText: "7K正式名称BOX" });
  await expect(row).toHaveCount(1);
  await expect(row.getByTestId("purchase-qty")).toHaveText("1BOX（20パック）");
  await expect(row.getByTestId("purchase-amount")).toHaveText("7,200円");
  await expect(row.getByTestId("purchase-date")).toContainText("開封");
  // 同じ開封は二重に数えない（再読み込みしても1件）
  await page.reload();
  await toAllPeriod(page);
  await page.getByTestId("tab-history").click();
  await expect(page.getByTestId("purchase-row").filter({ hasText: "7K正式名称BOX" })).toHaveCount(1);

  // 収支の支出は変わらない（開封で新しい支出を作らない）
  await page.goto("/finance");
  expect(yen(await page.getByTestId("sum-expense").innerText())).toBe(expense);
  await expect(page.getByTestId("ledger-row").filter({ hasText: "7K正式名称BOX" })).toHaveCount(1);

  // 開封の取り消し（BOXコレクション）→ 購入記録から除かれ、在庫は3BOXに戻る
  await page.goto("/collection?tab=box");
  await page.getByTestId("box-tile").filter({ hasText: "7K正式名称BOX" }).getByRole("button").first().click();
  await page.getByTestId("box-detail").getByTestId("box-history-summary").click(); // 在庫履歴は折りたたみ（初期は閉じている）。開いてから取り消す
  await page.getByTestId("box-detail").getByTestId("undo-op").first().click();
  await expect(page.getByTestId("box-detail").getByTestId("state-unknown")).toContainText("3BOX");
  await page.goto("/purchases");
  await toAllPeriod(page);
  await page.getByTestId("tab-history").click();
  await expect(page.getByTestId("purchase-row").filter({ hasText: "7K正式名称BOX" })).toHaveCount(0);
});

test("収支の支出内訳: 一本のバーを割合で色分け。分類の順序は固定", async ({ page }) => {
  test.setTimeout(120_000);
  await login(page);
  const hid = await household();
  const a = admin();
  const today = new Date(Date.now() + 9 * 3600_000).toISOString();
  const made: string[] = [];
  const add = async (category: string, label: string, amount: number) => {
    const p = (await a.from("purchases").insert({ household_id: hid, purchased_at: today, channel: "store", source_kind: "manual", category } as never).select("id").single()).data!.id as string;
    made.push(p);
    await a.from("purchase_items").insert({ household_id: hid, purchase_id: p, product_label: label, quantity: 1, unit: "piece", amount_paid: amount } as never);
  };
  try {
    await add("expense", "7K経費", 2000);
    await add("goods", "7Kサプライ", 3000);
    await add("single_card", "7Kシングル", 4000);
    await add("pokemon_card", "7Kカード", 10000);
    await page.goto("/finance");
    const track = page.getByTestId("expense-bar-track");
    await expect(track).toBeVisible();
    const segs = await track.locator("button").evaluateAll((els) => els.map((e) => ({ id: e.getAttribute("data-testid"), x: e.getBoundingClientRect().x, w: e.getBoundingClientRect().width })));
    const ids = segs.map((s) => s.id);
    // 固定の順序（金額の大小ではない）: ポケモンカード → シングル → グッズ → 経費
    const order = ["bar-seg-pokemon_card", "bar-seg-single_card", "bar-seg-goods", "bar-seg-expense"].filter((x) => ids.includes(x));
    expect(ids.filter((x) => order.includes(x!))).toEqual(order);
    // 隙間なく連続し、全体が1つの角丸
    for (let i = 1; i < segs.length; i++) expect(Math.abs(segs[i].x - (segs[i - 1].x + segs[i - 1].w))).toBeLessThan(1);
    expect(await track.evaluate((e) => getComputedStyle(e).borderRadius)).not.toBe("0px");
    // タップで金額・割合
    await page.getByTestId("bar-seg-single_card").click();
    await expect(page.getByTestId("bar-tip")).toContainText("シングル");
  } finally {
    for (const p of made) {
      await a.from("purchase_items").delete().eq("purchase_id", p);
      await a.from("purchases").delete().eq("id", p);
    }
  }
});
