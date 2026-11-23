import { createClient } from "@supabase/supabase-js";
import { expect, test, type Page } from "@playwright/test";

/**
 * 相場管理の機能改善の画面確認（実Supabaseのテスト世帯・架空データ・390px）。
 *   NEXT_PUBLIC_POKEMON_IMAGES=on E2E_SPEC=ui-market-fresh.supabase.spec.ts npm run test:e2e:supabase
 *  - 見出し右の「本日の調査結果」・操作ヘッダーの固定（スクロールしても検索・並び替えが画面上部に残る）
 *  - 番号・レアリティの候補選択（先頭1文字で絞り込み・選ぶとセットとレアを補完・自由入力）
 *  - 最新の販売情報（古い価格は一覧から外れ、推移に残る）・更新・完売・販売中への復帰・新着順（相場の更新日時）
 *  - 151図鑑のカード情報の編集（同じカードの価格記録すべてに反映）
 *  - 本日の調査結果: 相場比較表・購入予定（切替・解除の確認・下部の合計）・一括購入（購入記録・収支・151図鑑/相場調査メモの購入情報・マーク解除・二重計上なし）・完売は購入不可・編集リンク
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

test("相場管理の機能改善: 固定ヘッダー・候補選択・最新/更新/完売・カード情報編集・相場比較表・購入予定・一括購入", async ({ page }) => {
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

  // --- 仕込み: 相場調査メモ（古い記録を含む多数のカード）・151図鑑の価格記録
  const mk = async (name: string, set: string, no: string, rarity: string) => (await a.from("market_cards").insert({ household_id: hid, profile_id: pid, name, set_name: set, card_number: no, rarity }).select("id").single()).data!.id as string;
  const miloOld = await mk("ミロカロス", "SV8", "100/106", "SAR");
  const filler: string[] = [];
  for (let i = 1; i <= 14; i++) filler.push(await mk("フィラー" + i, "SVF", `0${i}/100`, "R"));
  const price = (cardId: string, o: Record<string, unknown>) => ({ household_id: hid, profile_id: pid, card_id: cardId, store_name: "垂水店", chain_name: "トレカキャピタル", condition: "A", price_yen: 1000, surveyed_on: today, ...o });
  await a.from("market_prices").insert([
    price(miloOld, { surveyed_on: old, price_yen: 1500, condition: "A" }), // 古い価格（同じ店舗・状態）
    price(miloOld, { surveyed_on: today, price_yen: 1000, condition: "A" }), // 最新
    price(miloOld, { surveyed_on: today, price_yen: 700, condition: "C", store_name: "梅田店", chain_name: "カードラボ" }),
    ...filler.map((id, i) => price(id, { price_yen: 100 + i, surveyed_on: old, store_name: "古い店" + i })),
  ] as never);
  await a.from("zukan_price_records").insert([
    { household_id: hid, profile_id: pid, dex_no: 25, card_name: "ピカチュウex", set_name: "SV8", card_number: "132/106", rarity: "SAR", store_name: "難波店", chain_name: "カードラボ", condition: "B", price_yen: 4000, surveyed_on: today },
  ] as never);

  // === 見出し右のリンク・固定ヘッダー（スクロールしても検索・並び替えが上部に残る）
  await page.goto("/market-memo");
  const link = page.getByTestId("daily-link");
  await expect(link).toBeVisible();
  const heading = await page.getByRole("heading", { level: 1 }).boundingBox();
  const lb = await link.boundingBox();
  expect(lb!.x).toBeGreaterThan(heading!.x + heading!.width - 1); // 見出しの右側
  expect(Math.abs(lb!.y - heading!.y)).toBeLessThan(20); // 見出しと同じ行
  await expect(page.getByTestId("market-card")).toHaveCount(15);
  await page.getByTestId("app-scroll").evaluate((el) => (el.scrollTop = 600));
  await page.waitForTimeout(300);
  const tb = await page.getByTestId("market-toolbar").boundingBox();
  const hdr = await page.locator("header").first().boundingBox();
  expect(tb!.y).toBeLessThan(hdr!.y + hdr!.height + 6); // 画面上部（共通ヘッダーの直下）に固定
  expect(await page.getByTestId("market-sort").isVisible()).toBe(true);
  expect(await noOverflow(page)).toBe(true);
  await page.screenshot({ path: "test-results/ui-fresh-sticky-390.png" });
  await page.getByTestId("app-scroll").evaluate((el) => (el.scrollTop = 0));

  // === 最新の販売情報: 古い 1,500円 は通常の一覧・カード詳細に出ない。推移に残る
  await page.getByTestId("market-card").filter({ hasText: "ミロカロス" }).getByTestId("market-card-open").click();
  const rows = page.getByTestId("price-row");
  await expect(rows).toHaveCount(2); // 垂水店A(1,000円)・梅田店C(700円)。1,500円は非表示
  await expect(page.getByTestId("price-list")).not.toContainText("1,500円");
  await rows.filter({ hasText: "1,000円" }).click();
  await expect(page.getByTestId("price-history")).toContainText("1,500円"); // 過去の記録は推移で確認できる
  // 完売 → バッジ・最安の対象外 → 更新で販売中に戻る
  await page.getByTestId("price-soldout").click();
  await expect(page.getByTestId("price-detail")).toHaveCount(0);
  await expect(rows.filter({ hasText: "1,000円" }).getByTestId("soldout-badge")).toBeVisible();
  await rows.filter({ hasText: "1,000円" }).click();
  await expect(page.getByTestId("detail-soldout")).toBeVisible();
  await expect(page.getByTestId("price-confirm")).toContainText("販売中に戻す");
  await page.getByTestId("price-confirm").click();
  await expect(page.getByTestId("soldout-badge")).toHaveCount(0);
  // 履歴は追記される（価格記録は書き換わらない）
  const ev = await a.from("market_price_events").select("event").eq("household_id", hid).order("created_at");
  expect((ev.data ?? []).map((e) => e.event)).toEqual(["sold_out", "confirmed"]);
  const pr = await a.from("market_prices").select("price_yen,surveyed_on").eq("card_id", miloOld).order("price_yen");
  expect((pr.data ?? []).map((p) => p.price_yen)).toEqual([700, 1000, 1500]);
  await page.keyboard.press("Escape");
  // 新着順: 更新した古いカード（ミロカロス）が、フィラー（古い日付）より上位
  await expect(page.getByTestId("market-card-name-text").first()).toHaveText("ミロカロス");

  // === 番号・レアリティの候補（先頭1文字で絞り込み・選ぶとセットとレアを補完・自由入力）
  await page.getByTestId("market-add").click();
  const num = page.getByTestId("market-card-number");
  await num.click();
  await expect(page.getByTestId("market-card-number-option").first()).toBeVisible();
  await num.fill("1");
  const texts = await page.getByTestId("market-card-number-option").allTextContents();
  expect(texts.length).toBeGreaterThan(0);
  expect(texts.every((t) => t.startsWith("1"))).toBe(true); // 先頭1文字で絞り込み
  await num.fill("100");
  await page.getByTestId("market-card-number-option").first().dispatchEvent("pointerdown");
  await expect(num).toHaveValue("100/106");
  await expect(page.getByTestId("market-card-set")).toHaveValue("SV8"); // 補完
  await expect(page.getByTestId("market-card-rarity")).toHaveValue("SAR");
  await num.fill("999/999"); // 一覧に無い番号は自由入力
  await expect(page.getByTestId("market-card-number-option")).toHaveCount(0);
  await expect(num).toHaveValue("999/999");
  await page.getByTestId("market-card-rarity").fill("特別");
  await expect(page.getByTestId("market-card-rarity")).toHaveValue("特別");
  await page.screenshot({ path: "test-results/ui-fresh-candidates-390.png" });
  await page.keyboard.press("Escape");

  // === 151図鑑: カード情報（名前・セット・番号・レア）の編集。同じカードの価格記録すべてに反映
  await page.goto("/zukan");
  await expect(page.getByTestId("daily-link")).toBeVisible();
  await expect(page.getByTestId("zukan-toolbar")).toBeVisible();
  await page.locator('[data-testid="zukan-item"][data-no="25"]').click();
  await page.getByTestId("price-row").first().click();
  await page.getByTestId("price-edit-card").click();
  await page.getByTestId("price-card-name").fill("ピカチュウex（改）");
  await page.getByTestId("price-card-rarity").fill("UR");
  await page.getByTestId("card-info-save").click();
  await expect(page.getByTestId("card-info-editor")).toHaveCount(0);
  const z = await a.from("zukan_price_records").select("card_name,rarity,price_yen,store_name").eq("household_id", hid);
  expect(z.data).toEqual([{ card_name: "ピカチュウex（改）", rarity: "UR", price_yen: 4000, store_name: "難波店" }]); // 価格・店舗は不変
  await page.keyboard.press("Escape");

  // === 本日の調査結果: 相場比較表・購入予定・一括購入
  await page.goto("/market-memo/daily");
  await expect(page.getByTestId("daily-row")).toHaveCount(3); // ミロカロス2件（今日分）＋ピカチュウ1件
  await page.getByTestId("daily-group").filter({ hasText: "ミロカロス" }).getByTestId("daily-compare").click(); // カード名・画像 → 相場比較表（ミロカロス: 古い 1,500円は過去の参考情報）
  await expect(page.getByTestId("compare-sheet")).toBeVisible();
  await expect(page.getByTestId("compare-current").getByTestId("compare-row")).toHaveCount(2);
  await expect(page.getByTestId("compare-past").getByTestId("compare-row")).toHaveCount(1);
  await expect(page.getByTestId("compare-past")).toContainText("1,500円");
  await page.screenshot({ path: "test-results/ui-fresh-compare-390.png" });
  await page.keyboard.press("Escape");
  // 詳細 → 編集（該当の記録を直接開く）
  await page.getByTestId("daily-row").filter({ hasText: "700円" }).getByTestId("daily-detail").click();
  await page.getByTestId("daily-edit-market").click();
  await expect(page).toHaveURL(/\/market-memo\?edit=/);
  await expect(page.getByTestId("price-form")).toBeVisible(); // その価格の編集フォームが開いている
  await page.goto("/market-memo/daily");
  // 購入予定: 2件マーク → 購入予定ボタンで「購入予定のみ・系列店舗別」へ
  await page.getByTestId("daily-row").filter({ hasText: "1,000円" }).getByTestId("daily-toggle").click();
  await page.getByTestId("daily-row").filter({ hasText: "700円" }).getByTestId("daily-toggle").click();
  await expect(page.getByTestId("daily-planned-count")).toHaveText("2");
  await page.getByTestId("daily-planned-only").click();
  await expect(page.getByTestId("daily-mode-store")).toHaveAttribute("aria-checked", "true");
  await expect(page.getByTestId("daily-row")).toHaveCount(2);
  await expect(page.getByTestId("daily-planned-bar-total")).toHaveText("1,700円"); // 下部に固定表示
  const bar = await page.getByTestId("daily-planned-bar").boundingBox();
  const nav = await page.getByTestId("bottom-nav").boundingBox();
  expect(Math.abs(bar!.y + bar!.height - nav!.y)).toBeLessThanOrEqual(2); // 下部ナビの直上
  expect(await noOverflow(page)).toBe(true);
  await page.screenshot({ path: "test-results/ui-fresh-planned-390.png" });
  // 解除は確認つき（キャンセルで維持）
  await page.getByTestId("daily-toggle").first().click();
  await expect(page.getByTestId("unmark-dialog")).toBeVisible();
  await page.getByRole("button", { name: "キャンセル" }).click();
  await expect(page.getByTestId("daily-planned-count")).toHaveText("2");
  // 一括購入: 確認画面（枚数・合計・店舗）→ 確定
  const purchasesBefore = (await a.from("purchases").select("id", { count: "exact", head: true }).eq("household_id", hid).eq("category", "single_card")).count ?? 0;
  await page.getByTestId("daily-bulk-open").click();
  await expect(page.getByTestId("bulk-count")).toHaveText("2枚");
  await expect(page.getByTestId("bulk-total")).toHaveText("1,700円");
  await expect(page.getByTestId("bulk-stores")).toContainText("垂水店");
  await expect(page.getByTestId("bulk-stores")).toContainText("梅田店");
  await page.getByTestId("bulk-confirm").dblclick(); // 二重タップ
  await expect(page.getByTestId("daily-bulk-done")).toContainText("2枚・合計1,700円");
  const pur = await a.from("purchases").select("id,category,buyer_profile_id").eq("household_id", hid).eq("category", "single_card");
  expect((pur.data ?? []).length - purchasesBefore).toBe(1); // 購入記録は1件のみ
  const items = await a.from("purchase_items").select("amount_paid,unit").eq("purchase_id", (pur.data ?? []).at(-1)!.id);
  expect((items.data ?? []).reduce((t, i) => t + (i.amount_paid as number), 0)).toBe(1700);
  expect((await a.from("market_purchases").select("id").eq("household_id", hid)).data).toHaveLength(2);
  expect((await a.from("market_plan_marks").select("id").eq("household_id", hid)).data).toHaveLength(0); // マークは解除
  await expect(page.getByTestId("daily-planned-count")).toHaveText("0");
  // 購入記録の画面（収支）に反映されている
  await page.goto("/purchases");
  await expect(page.getByText(/ミロカロス/).first()).toBeVisible();
  await page.screenshot({ path: "test-results/ui-fresh-purchases-390.png" });

  // === 完売は購入予定にできない
  await page.goto("/market-memo/daily");
  const piKey = await a.from("zukan_price_records").select("id").eq("household_id", hid).limit(1).single();
  await a.from("market_price_events").insert({ household_id: hid, zukan_price_id: piKey.data!.id, event: "sold_out", happened_on: today } as never);
  await page.reload();
  const sold = page.getByTestId("daily-row").filter({ hasText: "4,000円" });
  await expect(sold.getByTestId("daily-soldout")).toBeVisible();
  await sold.getByTestId("daily-toggle").click();
  await expect(page.getByTestId("daily-error")).toContainText("完売");
  expect(await noOverflow(page)).toBe(true);
});
