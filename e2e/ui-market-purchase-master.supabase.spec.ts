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

test("相場UIの統一: 一覧に収録パック名なし・3か所の比較表が同じ行レイアウト・151図鑑はカード種類別に比較表を分ける・並び替えの長押しで文字選択なし", async ({ page }) => {
  test.setTimeout(240_000);
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
  const { data: card } = await a.from("market_cards").insert({ household_id: hid, profile_id: pid, name: "ライチュウ", set_name: "超電ブレイカー", card_number: "SV8", rarity: "SR" }).select("id").single();
  await a.from("market_prices").insert([
    { household_id: hid, profile_id: pid, card_id: card!.id, store_name: "垂水店", chain_name: "トレカキャピタル", condition: "A", price_yen: 4000, surveyed_on: today },
    { household_id: hid, profile_id: pid, card_id: card!.id, store_name: "梅田店", chain_name: "カードラボ", condition: "S", price_yen: 4800, surveyed_on: today },
  ] as never);
  const z = (o: Record<string, unknown>) => ({ household_id: hid, profile_id: pid, dex_no: 26, card_name: "ライチュウ", store_name: "難波店", chain_name: "カードラボ", condition: "A", surveyed_on: today, ...o });
  await a.from("zukan_price_records").insert([z({ set_name: "超電ブレイカー", card_number: "SV8", rarity: "AR", price_yen: 700 }), z({ set_name: "超電ブレイカー", card_number: "SV8", rarity: "SAR", price_yen: 4200 }), z({ set_name: "ポケモンカード151", card_number: "SV2a", rarity: "SAR", price_yen: 9000 })] as never);

  // 相場調査メモの一覧: 収録パック名は出ない（番号のみ）。レアの左右に縦線なし
  await page.goto("/market-memo");
  const row = page.getByTestId("market-card").filter({ hasText: "ライチュウ" });
  await expect(row.getByTestId("row-set")).toHaveText("SV8");
  await expect(row).not.toContainText("超電ブレイカー");
  expect(await row.getByTestId("row-rarity").evaluate((e) => getComputedStyle(e).borderLeftWidth)).toBe("0px");
  expect(await row.getByTestId("row-rarity").evaluate((e) => parseFloat(getComputedStyle(e).fontSize))).toBeLessThanOrEqual(11.5);
  await page.screenshot({ path: "test-results/ui-unify-list-390.png" });

  // 相場調査メモの詳細の価格一覧（比較表）
  await row.getByTestId("market-card-open").click();
  const memoRow = page.getByTestId("price-row").first();
  await expect(memoRow).toBeVisible();
  const geo = async (loc: ReturnType<Page["locator"]>) => loc.evaluate((e) => { const c = getComputedStyle(e); const r = e.getBoundingClientRect(); return { h: Math.round(r.height), pad: c.padding, radius: c.borderRadius, bw: c.borderTopWidth, fs: getComputedStyle(e.querySelector('[data-testid$="-amount"]')!).fontSize }; });
  const g1 = await geo(memoRow);
  // 1行目に ロゴ・系列・店舗 が同じ高さ、日付はその下
  const idBox = await memoRow.getByTestId("store-identity").boundingBox();
  const chainBox = await memoRow.getByTestId("store-chain").boundingBox();
  const dateBox = await memoRow.getByTestId("price-date").boundingBox();
  expect(Math.abs(chainBox!.y - idBox!.y)).toBeLessThan(6);
  expect(dateBox!.y).toBeGreaterThan(idBox!.y + idBox!.height - 2);
  await expect(memoRow).not.toContainText("調査");
  await expect(memoRow).not.toContainText("超電ブレイカー");
  await page.waitForTimeout(700);
  await page.screenshot({ path: "test-results/ui-unify-memo-detail-390.png" });
  await page.keyboard.press("Escape");

  // 本日の調査結果の比較表と同じ形（高さ・余白・角丸・文字サイズ）
  await page.goto("/market-memo/daily");
  await page.getByTestId("daily-group").filter({ hasText: "ライチュウ" }).first().getByTestId("daily-compare").click();
  const cRow = page.getByTestId("compare-row").first();
  await expect(cRow).toBeVisible();
  const g2 = await geo(cRow);
  expect(g2).toEqual(g1);
  await page.waitForTimeout(700);
  await page.screenshot({ path: "test-results/ui-unify-compare-390.png" });
  await page.keyboard.press("Escape");

  // 151図鑑: 番号・レアリティごとに比較表が分かれる（混在しない）
  await page.goto("/zukan");
  await page.locator('[data-testid="zukan-item"][data-no="26"]').click();
  const heads = page.getByTestId("price-group-head");
  await expect(heads).toHaveCount(3);
  const texts = (await heads.allTextContents()).sort();
  expect(texts).toEqual(["SV2a ・ SAR", "SV8 ・ AR", "SV8 ・ SAR"]);
  const priceOf = async (head: string) => page.getByTestId("price-group").filter({ has: page.getByTestId("price-group-head").filter({ hasText: new RegExp(`^${head}$`) }) }).getByTestId("price-amount").allTextContents();
  expect(await priceOf("SV8 ・ AR")).toEqual(["700円"]);
  expect(await priceOf("SV8 ・ SAR")).toEqual(["4,200円"]);
  expect(await priceOf("SV2a ・ SAR")).toEqual(["9,000円"]);
  await expect(page.getByTestId("price-row").first()).not.toContainText("SAR");
  expect(await geo(page.getByTestId("price-row").first())).toEqual(g1);
  expect(await noOverflow(page)).toBe(true);
  await page.getByTestId("price-group").first().scrollIntoViewIfNeeded();
  await page.waitForTimeout(700);
  await page.screenshot({ path: "test-results/ui-unify-zukan-390.png" });
  await page.keyboard.press("Escape");

  // 並び替えの長押し: 並び替えメニューだけが開き、選択は発生しない
  await page.goto("/market-memo");
  const sort = page.getByTestId("market-sort");
  const box = (await sort.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.waitForTimeout(700);
  await expect(page.getByTestId("market-sort-menu")).toBeVisible();
  await page.mouse.up();
  expect(await page.evaluate(() => window.getSelection()?.toString() ?? "")).toBe("");
  expect(await sort.evaluate((e) => getComputedStyle(e).userSelect)).toBe("none");
  await page.keyboard.press("Escape");
  const before = await sort.getAttribute("data-sort");
  await sort.click(); // 通常タップは次の並びへ
  expect(await sort.getAttribute("data-sort")).not.toBe(before);
});
