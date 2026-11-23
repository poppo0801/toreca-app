import { createClient } from "@supabase/supabase-js";
import { expect, test, type Page } from "@playwright/test";

/**
 * 相場管理の追加改善の画面確認（実Supabaseのテスト世帯・架空データ・390px）。
 *   NEXT_PUBLIC_POKEMON_IMAGES=on E2E_SPEC=ui-market-purchase-master.supabase.spec.ts npm run test:e2e:supabase
 *  - 相場調査メモ一覧: レアリティ・状態ランク・価格の列位置が全行で同じ（店舗名が長くてもずれない）・横スクロールなし
 *  - 価格の詳細: 右=編集・更新・完売／左=この価格で購入・削除。個別購入が購入記録（シングルカード・同日合算）に入る
 *  - 本日の調査結果: 更新で再確認した記録の表示・購入予定のみの画面は行全体タップで解除確認・固定バーは1行
 *  - 相場比較表: 日付のみ（「調査」なし）・系列名が店舗名より太い・ロゴが無いときの代替表示
 *  - 未入力の確認: 番号を入れると収録セットを補完して保存
 */
const email = process.env.E2E_EMAIL!;
const password = process.env.E2E_PASSWORD!;
const admin = () => createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } });

async function login(page: Page) {
  await page.goto("/login");
  await page.getByLabel("メールアドレス").fill(email);
  await page.getByLabel("パスワード").fill(password);
  await page.getByRole("button", { name: "ログイン" }).click();
  await expect(page).toHaveURL(/\/lotteries$/);
}
const noOverflow = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1);
const jst = (d = new Date()) => new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Tokyo", year: "numeric", month: "2-digit", day: "2-digit" }).format(d);

test("相場管理の追加改善: 一覧の整列・詳細の操作配置・個別購入の購入記録連携・更新の日別反映・購入予定の操作・比較表・未入力の確認", async ({ page }) => {
  test.setTimeout(300_000);
  await page.setViewportSize({ width: 390, height: 844 });
  await login(page);
  const a = admin();
  const { data: list } = await a.auth.admin.listUsers({ perPage: 200 });
  const user = list!.users.find((u) => u.email === email)!;
  const { data: hm } = await a.from("household_members").select("household_id").eq("user_id", user.id).limit(1).maybeSingle();
  const hid = hm!.household_id as string;
  const { data: prof } = await a.from("profiles").select("id").eq("household_id", hid).limit(1).maybeSingle();
  const pid = prof!.id as string;
  const today = jst();
  const old = "2026-01-05";

  // --- 仕込み
  const mk = async (name: string, set: string, no: string, rarity: string) => (await a.from("market_cards").insert({ household_id: hid, profile_id: pid, name, set_name: set, card_number: no, rarity }).select("id").single()).data!.id as string;
  const milo = await mk("ミロカロス", "超電ブレイカー", "SV8", "SAR");
  const pika = await mk("ピカチュウ", "ポケモンカード151", "SV2a", "UR");
  const blank = await mk("番号なしのカード", "", "", "");
  const price = (cardId: string, o: Record<string, unknown>) => ({ household_id: hid, profile_id: pid, card_id: cardId, store_name: "垂水店", chain_name: "トレカキャピタル", condition: "A", price_yen: 1000, surveyed_on: today, ...o });
  const ins = await a
    .from("market_prices")
    .insert([
      price(milo, { price_yen: 11000, store_name: "垂水店（ポケモンカード専門館 新宿西口本店のとても長い名前）" }),
      price(pika, { price_yen: 980, condition: "S", store_name: "梅田店", chain_name: "カードラボ" }),
      price(pika, { price_yen: 1500, condition: "B", store_name: "更新店", chain_name: "カードラボ", surveyed_on: old }), // 調査は古いが、本日「更新」で再確認
      price(blank, { price_yen: 300, condition: "C" }),
    ] as never)
    .select("id,price_yen");
  const byYen = new Map((ins.data ?? []).map((r) => [r.price_yen as number, r.id as string]));
  await a.from("market_price_events").insert({ household_id: hid, market_price_id: byYen.get(1500), event: "confirmed", happened_on: today } as never);
  await a.from("zukan_price_records").insert({ household_id: hid, profile_id: pid, dex_no: 25, card_name: "ピカチュウex", set_name: "超電ブレイカー", card_number: "SV8", rarity: "SAR", store_name: "難波店", chain_name: "カードラボ", condition: "B", price_yen: 2000, surveyed_on: today } as never);

  // === 相場調査メモ一覧: 列の位置が全行で同じ。横スクロールなし
  await page.goto("/market-memo");
  await expect(page.getByTestId("market-card")).toHaveCount(3);
  const xs = async (id: string) => (await page.getByTestId(id).evaluateAll((els) => els.map((e) => Math.round(e.getBoundingClientRect().left * 10) / 10))) as number[];
  const rights = (await page.getByTestId("market-card-best").evaluateAll((els) => els.map((e) => Math.round(e.getBoundingClientRect().right * 10) / 10))) as number[];
  const rar = await xs("row-rarity");
  const rank = await xs("row-rank");
  expect(new Set(rar).size).toBe(1); // レアリティの列位置が同じ
  expect(new Set(rank).size).toBe(1); // 状態ランクの列位置が同じ
  expect(new Set(rights).size).toBe(1); // 価格の右端が同じ
  expect(await noOverflow(page)).toBe(true);
  await expect(page.getByTestId("market-card").filter({ hasText: "ミロカロス" }).getByTestId("market-card-store")).toContainText("新宿西口本店のとても長い名前"); // 長い店舗名も全文（折り返し）
  await page.screenshot({ path: "test-results/ui-purchase-list-390.png" });
  // 未入力の確認への入口（番号・レア未入力のカードがあるときだけ）
  await expect(page.getByTestId("review-link")).toBeVisible();

  // === 価格の詳細: 操作の配置。個別購入 → 購入記録（シングルカード）
  await page.getByTestId("market-card").filter({ hasText: "ピカチュウ" }).getByTestId("market-card-open").click();
  await page.getByTestId("price-row").filter({ hasText: "980円" }).click();
  const left = await page.getByTestId("price-actions-left").boundingBox();
  const right = await page.getByTestId("price-actions-right").boundingBox();
  expect(right!.x).toBeGreaterThan(left!.x + left!.width - 1); // 右=編集・更新・完売
  await expect(page.getByTestId("price-actions-right").getByRole("button")).toHaveText(["編集", "更新", "完売"]);
  await expect(page.getByTestId("price-actions-left").getByRole("button")).toHaveText(["この価格で購入", "削除"]);
  expect(await noOverflow(page)).toBe(true);
  await page.screenshot({ path: "test-results/ui-purchase-detail-390.png" });
  await page.getByTestId("price-buy").click();
  await page.getByTestId("buy-ok").click();
  await page.waitForTimeout(500);
  const single = async () => {
    const p = await a.from("purchases").select("id,archived_at,purchased_date").eq("household_id", hid).eq("category", "single_card").eq("buyer_profile_id", pid).eq("purchased_date", today).is("archived_at", null);
    const items = [] as number[];
    for (const r of p.data ?? []) for (const i of (await a.from("purchase_items").select("amount_paid").eq("purchase_id", r.id)).data ?? []) items.push(i.amount_paid as number);
    return { purchases: (p.data ?? []).length, items };
  };
  expect(await single()).toEqual({ purchases: 1, items: [980] });
  await page.keyboard.press("Escape");

  // === 151図鑑の個別購入も同じ購入記録に合算される
  await page.goto("/zukan");
  await page.locator('[data-testid="zukan-item"][data-no="25"]').click();
  await page.getByTestId("price-row").first().click();
  await page.getByTestId("price-buy").click();
  await page.getByTestId("buy-ok").click();
  await page.waitForTimeout(500);
  const s2 = await single();
  expect(s2.purchases).toBe(1);
  expect(s2.items.sort((x, y) => x - y)).toEqual([980, 2000]); // 合算（収支は購入記録から集計）
  await page.keyboard.press("Escape");

  // === 本日の調査結果: 更新で再確認した記録が表示される
  await page.goto("/market-memo/daily");
  await expect(page.getByTestId("daily-row").filter({ hasText: "1,500円" }).getByTestId("daily-refreshed")).toBeVisible();
  await expect(page.getByTestId("daily-row").filter({ hasText: "11,000円" }).getByTestId("daily-refreshed")).toHaveCount(0);
  // 比較表: 日付のみ・系列名が太い・ロゴ代替
  await page.getByTestId("daily-group").filter({ hasText: "ピカチュウ" }).first().getByTestId("daily-compare").click();
  const crow = page.getByTestId("compare-row").first();
  await expect(crow).toBeVisible();
  await expect(page.getByTestId("compare-sheet")).not.toContainText("調査 ");
  await expect(crow.getByTestId("compare-date")).toHaveText(/^\d+\/\d+$/);
  const chainWeight = await crow.locator('[data-testid="store-chain"] > span:last-child').evaluate((e) => Number(getComputedStyle(e).fontWeight));
  const storeWeight = await crow.locator('[data-testid="store-identity"] > span:last-child').evaluate((e) => Number(getComputedStyle(e).fontWeight));
  expect(chainWeight).toBeGreaterThan(storeWeight);
  expect((await crow.getByTestId("chain-logo").count()) + (await crow.getByTestId("chain-fallback").count())).toBe(1); // ロゴ または 代替
  await page.screenshot({ path: "test-results/ui-purchase-compare-390.png" });
  await page.keyboard.press("Escape");

  // === 購入予定のみ: 行全体タップで解除確認・固定バーは1行
  await page.getByTestId("daily-row").filter({ hasText: "11,000円" }).getByTestId("daily-toggle").click();
  await page.getByTestId("daily-row").filter({ hasText: "300円" }).getByTestId("daily-toggle").click();
  await expect(page.getByTestId("daily-planned-count")).toHaveText("2");
  await page.getByTestId("daily-planned-only").click();
  const line = await page.getByTestId("daily-planned-line").boundingBox();
  const bar = await page.getByTestId("daily-planned-bar").boundingBox();
  expect(line!.height).toBeLessThan(24); // 文字は1行
  expect(bar!.height).toBeLessThan(62); // 2段にならない
  await expect(page.getByTestId("daily-planned-line")).toContainText("購入予定 2枚");
  await expect(page.getByTestId("daily-planned-line")).toContainText("合計 11,300円");
  expect(await noOverflow(page)).toBe(true);
  await page.screenshot({ path: "test-results/ui-purchase-planned-390.png" });
  // 行の右端（価格）をタップしても解除の確認
  await page.getByTestId("daily-row-price").first().click();
  await expect(page.getByTestId("unmark-dialog")).toBeVisible();
  await page.getByRole("button", { name: "キャンセル" }).click();
  await expect(page.getByTestId("daily-planned-count")).toHaveText("2");

  // === 未入力の確認: 番号を入れると収録セットを補完して保存
  await page.goto("/market-memo/review");
  const item = page.getByTestId("review-item").filter({ hasText: "番号なしのカード" });
  await expect(item).toBeVisible();
  await item.getByTestId("review-number").fill("SV8");
  await expect(item.getByTestId("review-set")).toHaveValue("超電ブレイカー"); // マスターで一意
  await item.getByTestId("review-rarity").fill("AR");
  await item.getByTestId("review-save").click();
  await expect(page.getByTestId("review-item").filter({ hasText: "番号なしのカード" })).toHaveCount(0);
  const saved = await a.from("market_cards").select("set_name,card_number,rarity").eq("id", blank).single();
  expect(saved.data).toEqual({ set_name: "超電ブレイカー", card_number: "SV8", rarity: "AR" });
  expect((await a.from("market_prices").select("price_yen").eq("card_id", blank)).data).toEqual([{ price_yen: 300 }]); // 価格は不変
  expect(await noOverflow(page)).toBe(true);
});
