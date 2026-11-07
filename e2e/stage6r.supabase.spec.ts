import { createClient } from "@supabase/supabase-js";
import { expect, test, type CDPSession, type Page } from "@playwright/test";

/**
 * Stage 6R の画面確認（実Supabaseのテスト世帯・架空データ）。
 *   E2E_SPEC=stage6r.supabase.spec.ts npm run test:e2e:supabase
 *  - コレクション: 購入／買取／枚数の3分割、長押しドラッグで「標準」の並び順を保存→再読込で復元→他の並び順に変えても標準は保たれる
 *  - 収支: 1取引1カード（日付見出しなし・分類色/名称・正式商品名）、詳細シート→編集/削除、支出内訳バー、全期間
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

async function longPressDrag(cdp: CDPSession, from: { x: number; y: number }, to: { x: number; y: number }) {
  await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [from] });
  await new Promise((r) => setTimeout(r, 700)); // 長押し
  const steps = 10;
  for (let i = 1; i <= steps; i++) {
    await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x: from.x + ((to.x - from.x) * i) / steps, y: from.y + ((to.y - from.y) * i) / steps }] });
    await new Promise((r) => setTimeout(r, 30));
  }
  await new Promise((r) => setTimeout(r, 300));
  await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
}

const names = async (page: Page) => (await page.getByTestId("card-tile").evaluateAll((els) => els.map((e) => (e.querySelector("button[aria-label$='の詳細を開く']")?.getAttribute("aria-label") ?? "").replace(/ .*$/, ""))));

test("コレクション: 3分割の集計。長押しドラッグの並びを「標準」として保存・復元し、ほかの並び順を選んでも保たれる", async ({ page }) => {
  test.setTimeout(180_000);
  await login(page);
  const hid = await household();
  const a = admin();
  const base = ["6R-イ", "6R-ロ", "6R-ハ", "6R-ニ"];
  const ins = await a.from("card_masters").insert(base.map((n, i) => ({ household_id: hid, name: n, card_number: `${i + 1}/9`, set_code: "6R", rarity: "RR" })) as never);
  expect(ins.error).toBeNull();
  try {
    await page.goto("/collection");
    // 3分割: 購入／買取／枚数
    const sum = page.getByTestId("summary-line");
    await expect(sum.getByTestId("summary-line-cell-0")).toContainText("購入");
    await expect(sum.getByTestId("summary-line-cell-1")).toContainText("買取");
    await expect(sum.getByTestId("summary-line-cell-2")).toContainText("枚数");
    await expect(page.getByTestId("card-tile")).toHaveCount(4);
    const initial = await names(page);

    // 長押しドラッグ: 先頭のカードを3番目の位置へ
    const cdp = await page.context().newCDPSession(page);
    const tiles = page.getByTestId("card-tile");
    const b0 = (await tiles.nth(0).boundingBox())!;
    const b2 = (await tiles.nth(2).boundingBox())!;
    await longPressDrag(cdp, { x: b0.x + b0.width / 2, y: b0.y + b0.height / 2 }, { x: b2.x + b2.width / 2, y: b2.y + b2.height / 2 });
    await expect.poll(() => names(page)).not.toEqual(initial);
    const custom = await names(page);
    // 保存される（このプロフィールの標準順）
    await expect.poll(async () => ((await a.from("card_display_orders" as never).select("card_id").eq("household_id", hid)).data ?? []).length).toBeGreaterThanOrEqual(4);
    await page.reload();
    await expect(page.getByTestId("card-tile")).toHaveCount(4);
    expect(await names(page)).toEqual(custom); // 再読み込みでも復元

    // ほかの並び順（カード名順）に変えても標準の保存順は変わらず、標準に戻すと復元される
    await page.getByLabel("並び順").selectOption("name");
    expect(await names(page)).toEqual([...custom].sort((x, y) => x.localeCompare(y, "ja")));
    await page.getByLabel("並び順").selectOption("default");
    expect(await names(page)).toEqual(custom);

    // 保存されているのは1プロフィール分だけ（他のプロフィールの標準順は別）
    const profiles = new Set(((await a.from("card_display_orders" as never).select("profile_id").eq("household_id", hid)).data as { profile_id: string }[]).map((r) => r.profile_id));
    expect(profiles.size).toBe(1);
  } finally {
    await a.from("card_masters").delete().eq("household_id", hid).like("name", "6R-%");
  }
});

test("収支: 1取引1カード・分類の色/名称・正式商品名、詳細シートから編集/削除、支出内訳バー、全期間", async ({ page }) => {
  test.setTimeout(180_000);
  await login(page);
  const hid = await household();
  const a = admin();
  const today = new Date(Date.now() + 9 * 3600_000).toISOString().slice(0, 10);
  const longName = "6R 30th CELEBRATION プレミアムデッキセット 正式名称のとても長い商品名";
  const prod = (await a.from("products").insert({ household_id: hid, official_name: longName, packs_per_box: 30 }).select("id").single()).data!.id as string;
  await a.from("product_aliases").insert({ household_id: hid, product_id: prod, alias: "6R略称", normalized_alias: "6r略称" });
  const mkP = async (category: string, date: string, item: Record<string, unknown>) => {
    const p = (await a.from("purchases").insert({ household_id: hid, category, source_kind: "manual", purchased_date: date, channel: "store" } as never).select("id").single()).data!.id as string;
    await a.from("purchase_items").insert({ household_id: hid, purchase_id: p, quantity: 1, unit: "piece", ...item } as never);
    return p;
  };
  const pc = await mkP("pokemon_card", today, { product_id: prod, amount_paid: 12000 });
  const pg = await mkP("goods", today, { product_label: "6Rスリーブ", amount_paid: 5000 });
  const pe = await mkP("expense", today, { product_label: "6R駐車場代", amount_paid: 1500 });
  const old = await mkP("goods", "2025-03-03", { product_label: "6R昔のスリーブ", amount_paid: 700 });
  try {
    await page.goto("/finance");
    const rows = page.getByTestId("ledger-row");
    await expect(rows.filter({ hasText: "6R" })).toHaveCount(3);
    // 日付見出し（M/D（曜））が無い。1取引1カード
    await expect(page.getByTestId("ledger-list").getByText(/（[日月火水木金土]）/)).toHaveCount(0);
    const card = rows.filter({ hasText: "6R 30th" });
    await expect(card.getByTestId("row-category")).toHaveText("カード");
    await expect(card.getByTestId("row-title")).toContainText(longName); // 正式名称（略称に置換しない）
    await expect(card.getByTestId("row-title")).not.toContainText("6R略称");
    await expect(rows.filter({ hasText: "6Rスリーブ" }).getByTestId("row-category")).toHaveText("サプライ");
    await expect(rows.filter({ hasText: "6R駐車場代" }).getByTestId("row-category")).toHaveText("経費");
    // 左端のラインの色が分類ごとに違う
    const colors = await Promise.all(["6R 30th", "6Rスリーブ", "6R駐車場代"].map((t) => rows.filter({ hasText: t }).getByTestId("row-line").evaluate((e) => getComputedStyle(e).backgroundColor)));
    expect(new Set(colors).size).toBe(3);

    // 支出内訳バー: 色をタップで金額と割合。同じ色の再タップで閉じる
    const total = 12000 + 5000 + 1500;
    await expect(page.getByTestId("expense-bar")).toBeVisible();
    await page.getByTestId("bar-seg-pokemon_card").click();
    await expect(page.getByTestId("bar-tip")).toContainText(`カード：12,000円（${Math.round((12000 / total) * 100)}%）`);
    await page.getByTestId("bar-seg-goods").click();
    await expect(page.getByTestId("bar-tip")).toContainText("サプライ：5,000円");
    await page.getByTestId("bar-seg-goods").click();
    await expect(page.getByTestId("bar-tip")).toHaveCount(0);

    // 詳細シート → 編集で金額を変更 → 一覧に即反映
    await rows.filter({ hasText: "6R駐車場代" }).click();
    const detail = page.getByTestId("ledger-detail");
    await expect(detail).toBeVisible();
    await expect(detail.getByTestId("ledger-detail-amount")).toHaveText("1,500円");
    await detail.getByTestId("ledger-edit").click();
    const form = page.getByTestId("expense-form");
    await expect(form).toBeVisible();
    await form.getByLabel("購入金額1").fill("1800");
    await form.getByRole("button", { name: "保存" }).click();
    await expect(form).toHaveCount(0);
    await expect(rows.filter({ hasText: "6R駐車場代" })).toContainText("-1,800円");

    // 詳細シートから削除（確認あり）
    await rows.filter({ hasText: "6Rスリーブ" }).click();
    await page.getByTestId("ledger-delete").click();
    await expect(page.getByTestId("ledger-delete-confirm")).toBeVisible();
    await page.getByTestId("ledger-delete-run").click();
    await expect(page.getByTestId("ledger-detail")).toHaveCount(0);
    await expect(rows.filter({ hasText: "6Rスリーブ" })).toHaveCount(0);

    // 全期間: 過去の取引も一覧・集計・内訳に入る。月に戻すと従来どおり
    await page.getByTestId("month-label").click();
    await page.getByTestId("period-all").click();
    await expect(page.getByTestId("month-label")).toHaveText("全期間");
    await expect(rows.filter({ hasText: "6R昔のスリーブ" })).toHaveCount(1);
    await expect(page.getByTestId("bar-seg-goods")).toBeVisible();
    await page.getByTestId("month-label").click();
    await page.getByRole("button", { name: "1月", exact: true }).click();
    await expect(rows.filter({ hasText: "6R昔のスリーブ" })).toHaveCount(0);
  } finally {
    for (const p of [pc, pg, pe, old]) {
      await a.from("purchase_items").delete().eq("purchase_id", p);
      await a.from("purchases").delete().eq("id", p);
    }
  }
});
