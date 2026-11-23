import { existsSync, readFileSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";
import { expect, test, type Page } from "@playwright/test";

/**
 * UI要望の実画面確認（実Supabaseのテスト世帯・架空データ・390px）。スクリーンショットは test-results/ui-audit-*.png（Git管理外）。
 *   E2E_SPEC=ui-audit.supabase.spec.ts npm run test:e2e:supabase
 * 画像: 元のPNGフォルダ（POKEMON_IMAGE_DIR。既定はダウンロードフォルダ）があれば、少数をテスト世帯の非公開バケットへ置いて表示も確認する（無ければプレースホルダー）。
 */
const email = process.env.E2E_EMAIL!;
const password = process.env.E2E_PASSWORD!;
const admin = () => createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false, autoRefreshToken: false } });
/** 画像を置く番号（151内外・形態別ファイルの番号を含む） */
const IMAGE_NOS = [1, 4, 6, 7, 25, 150, 173, 305, 350, 520, 530, 593, 595, 702, 703, 741, 774];
const IMG_DIR = process.env.POKEMON_IMAGE_DIR ?? "C:/Users/toppo/Downloads/pokemon-image/Official";

async function login(page: Page) {
  await page.goto("/login");
  await page.getByLabel("メールアドレス").fill(email);
  await page.getByLabel("パスワード").fill(password);
  await page.getByRole("button", { name: "ログイン" }).click();
  await expect(page).toHaveURL(/\/lotteries$/);
}

test("UI監査: 151図鑑・相場調査メモ（390px実画面）", async ({ page }) => {
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

  // 画像（あれば少数）
  if (existsSync(IMG_DIR)) {
    const sharp = (await import("sharp")).default;
    const manifest = existsSync("eval/real-data/pokemon-images-manifest.json") ? (JSON.parse(readFileSync("eval/real-data/pokemon-images-manifest.json", "utf8")).entries as { no: number; file: string }[]) : [];
    for (const no of IMAGE_NOS) {
      const entry = manifest.find((e) => e.no === no);
      if (!entry) continue;
      const file = `${IMG_DIR}/${entry.file}`;
      if (!existsSync(file)) continue;
      const buf = await sharp(readFileSync(file)).resize(160, 160, { fit: "inside" }).webp({ quality: 78 }).toBuffer();
      await a.storage.from("pokemon-images").upload(`${hid}/official/${String(no).padStart(4, "0")}.webp`, buf, { contentType: "image/webp", upsert: true });
    }
  }

  const z = (o: Record<string, unknown>) => ({ household_id: hid, profile_id: pid, ...o });
  await a.from("zukan_cards").insert(z({ dex_no: 25, card_name: "ピカチュウ", quantity: 1, acquire_method: "pack_opening" }) as never);
  await a.from("zukan_price_records").insert([
    z({ dex_no: 6, card_name: "リザードン", set_name: "テストセット", card_number: "006/078", rarity: "AR", store_name: "新宿店", chain_name: "テスト系列", surveyed_on: new Date().toISOString().slice(0, 10), condition: "A", price_yen: 1200 }),
    z({ dex_no: 6, card_name: "リザードン", set_name: "テストセット", card_number: "006/078", rarity: "AR", store_name: "渋谷店", chain_name: "別の系列", surveyed_on: "2026-01-05", condition: "B", price_yen: 800 }),
  ] as never);
  const mc = await a.from("market_cards").insert({ household_id: hid, profile_id: pid, name: "リザードンex", set_name: "スカーレットex", card_number: "006/078", rarity: "AR" } as never).select("id").single();
  const mc2 = await a.from("market_cards").insert({ household_id: hid, profile_id: pid, name: "ピカチュウ", set_name: "151", card_number: "025/165", rarity: "AR" } as never).select("id").single();
  const day = new Date().toISOString().slice(0, 10);
  const extra = [
    { name: "オドリドリex", store: "トレカキャピタル 新宿西口本店（ポケモンカード専門館）", chain: "トレカキャピタル", cond: "A", yen: 2480 },
    { name: "ミロカロス", store: "カードラボ 秋葉原店", chain: "カードラボ", cond: "A+", yen: 980 },
    { name: "ブルンゲルex", store: "ドラゴンスター 渋谷スクランブル交差点前店", chain: "ドラゴンスター", cond: "B+", yen: 1500 },
    { name: "ハイパーボール", store: "短い店", chain: "系列", cond: "A", yen: 100 },
  ];
  for (const [i, c] of extra.entries()) {
    const r = await a.from("market_cards").insert({ household_id: hid, profile_id: pid, name: c.name, set_name: "テストセット", card_number: `${100 + i}/200`, rarity: "AR" } as never).select("id").single();
    await a.from("market_prices").insert({ household_id: hid, profile_id: pid, card_id: r.data!.id, store_name: c.store, chain_name: c.chain, surveyed_on: day, condition: c.cond, price_yen: c.yen, memo: "" } as never);
  }
  await a.from("market_prices").insert([
    { household_id: hid, profile_id: pid, card_id: mc.data!.id, store_name: "新宿店", chain_name: "テスト系列", surveyed_on: day, condition: "A+", price_yen: 1500, memo: "備考の例" },
    { household_id: hid, profile_id: pid, card_id: mc.data!.id, store_name: "渋谷店", chain_name: "別の系列", surveyed_on: "2026-01-05", condition: "A", price_yen: 1200, memo: "" },
    { household_id: hid, profile_id: pid, card_id: mc2.data!.id, store_name: "新宿店", chain_name: "テスト系列", surveyed_on: day, condition: "A", price_yen: 300, memo: "" },
  ] as never);

  // 151図鑑: 一覧
  await page.goto("/zukan");
  await expect(page.getByTestId("zukan-item")).toHaveCount(151);
  await page.waitForTimeout(800);
  await page.waitForTimeout(900);
  await page.screenshot({ path: "test-results/ui-audit-zukan-list-390.png" });
  // 詳細ヘッダー（相場登録済み）: 説明文なし・短いバッジ1個
  await page.locator('[data-testid="zukan-item"][data-no="6"]').click();
  await expect(page.getByTestId("zukan-status-badge")).toHaveText("相場登録済み");
  await expect(page.getByTestId("zukan-sheet")).not.toContainText("価格調査の記録あり");
  await page.waitForTimeout(900);
  await page.screenshot({ path: "test-results/ui-audit-zukan-detail-390.png" });
  expect(await page.getByTestId("price-row").count()).toBe(2);
  await expect(page.getByTestId("price-buy")).toHaveCount(0);
  await page.getByTestId("price-add").click();
  await page.getByTestId("price-form").scrollIntoViewIfNeeded();
  await page.waitForTimeout(900);
  await page.screenshot({ path: "test-results/ui-audit-zukan-price-form-390.png" });
  await page.getByRole("button", { name: "キャンセル" }).click();
  await page.getByTestId("price-row").first().click();
  await page.waitForTimeout(900);
  await page.screenshot({ path: "test-results/ui-audit-price-detail-390.png" });
  await page.keyboard.press("Escape");
  await page.keyboard.press("Escape");
  // 対象レア未収録の詳細（未登録のポケモン）
  await page.locator('[data-testid="zukan-item"][data-no="150"]').click();
  await expect(page.getByTestId("zukan-status-badge")).toHaveText("未登録");
  await page.waitForTimeout(900);
  await page.screenshot({ path: "test-results/ui-audit-zukan-unregistered-390.png" });
  await page.keyboard.press("Escape");

  // 相場調査メモ
  await page.goto("/market-memo");
  await expect(page.getByTestId("market-card")).toHaveCount(6);
  // 画像の有無（151以外を含む）と、長い店名が省略されないこと
  const img = (name: string) => page.getByTestId("market-card").filter({ hasText: name }).getByTestId("dex-image");
  await expect(img("ミロカロス")).toHaveCount(1);
  await expect(img("オドリドリex")).toHaveCount(1);
  await expect(img("ブルンゲルex")).toHaveCount(1);
  await expect(img("ハイパーボール")).toHaveCount(0);
  await expect(page.getByTestId("market-card-store").filter({ hasText: "新宿西口本店（ポケモンカード専門館）" })).toHaveCount(1);
  await expect(page.getByTestId("market-export")).toHaveCount(0);
  await expect(page.getByTestId("market-card-plus")).toHaveCount(0); // 行の「＋」は無い
  // 並び替え・購入済み切替の操作（アイコンのみのボタン。タップで 新着→価格降順→価格昇順→状態→レアリティ→五十音。長押しの一覧から図鑑No順なども選べる）
  const pick = async (sortId: string) => {
    await page.getByTestId("market-sort").hover();
    await page.mouse.down();
    await page.waitForTimeout(600);
    await page.mouse.up();
    await page.getByTestId("market-sort-option").and(page.locator(`[data-sort="${sortId}"]`)).click();
  };
  const priceNums = async () => (await page.getByTestId("market-card-best").allTextContents()).map((t) => Number(t.replace(/[^0-9]/g, "")));
  await page.getByTestId("market-sort").click();
  await expect(page.getByTestId("market-sort")).toHaveAttribute("data-sort", "priceDesc");
  await expect(page.getByTestId("market-sort-heading")).toHaveText("価格の高い順 ↓");
  const desc = await priceNums();
  expect(desc).toEqual([...desc].sort((x, y) => y - x)); // 価格の高い順（記録なしは最後）
  await page.getByTestId("market-sort").click();
  await expect(page.getByTestId("market-sort")).toHaveAttribute("data-sort", "priceAsc");
  const nums = await priceNums();
  expect(nums).toEqual([...nums].sort((x, y) => x - y)); // 価格の安い順
  await page.waitForTimeout(500);
  await page.screenshot({ path: "test-results/ui-audit-market-list-price-sort-390.png" });
  await expect(page.getByTestId("market-sort-heading")).toHaveText("価格の安い順 ↑"); // 見出しの右に現在の並び順
  const order = async () => (await page.getByTestId("market-card-name-text").allTextContents()).map((t) => t.trim());
  await page.getByTestId("market-sort").click(); // 状態順
  await expect(page.getByTestId("market-sort-heading")).toHaveText("状態順 ↑");
  await page.getByTestId("market-sort").click(); // レアリティ順
  await expect(page.getByTestId("market-sort-heading")).toHaveText("レアリティ順 ↓");
  await page.getByTestId("market-sort").click(); // 五十音順（ポケモンの読み仮名。ex に影響されない。ポケモンでないカードは末尾）
  await expect(page.getByTestId("market-sort-heading")).toHaveText("五十音順 ↑");
  expect(await order()).toEqual(["オドリドリex", "ピカチュウ", "ブルンゲルex", "ミロカロス", "リザードンex", "ハイパーボール"]);
  await page.waitForTimeout(500);
  await page.screenshot({ path: "test-results/ui-audit-market-list-kana-390.png" });
  await pick("dex"); // 図鑑No順（全国図鑑番号の昇順。長押しの一覧から）
  await expect(page.getByTestId("market-sort-heading")).toHaveText("図鑑No順 ↑");
  expect(await order()).toEqual(["リザードンex", "ピカチュウ", "ミロカロス", "ブルンゲルex", "オドリドリex", "ハイパーボール"]); // 6, 25, 350, 593, 741, なし
  await page.waitForTimeout(500);
  await page.screenshot({ path: "test-results/ui-audit-market-list-dex-390.png" });
  // 図鑑No（画像の元）はカード番号とは別: ピカチュウの行（カード番号は一覧に出さず、詳細に出す）
  const pika = page.getByTestId("market-card").filter({ hasText: "ピカチュウ" });
  await expect(pika.getByTestId("row-number")).toHaveCount(0);
  await expect(pika.getByTestId("market-card-summary")).toHaveAttribute("data-dex", "25");
  await expect(pika).not.toContainText("件");
  await pick("new"); // 新着順へ戻す
  await expect(page.getByTestId("market-sort")).toHaveAttribute("data-sort", "new");
  await expect(page.getByTestId("market-sort-heading")).toHaveText("新着順 ↓");
  await page.getByTestId("market-show-bought").click();
  await expect(page.getByTestId("market-show-bought")).toHaveAttribute("aria-pressed", "true");
  await page.getByTestId("market-show-bought").click();
  // 画像が実際に読み込まれ、表示されている（HTTP応答・ピクセルサイズ）
  const loaded = await page.getByTestId("market-card").filter({ hasText: "ミロカロス" }).getByTestId("dex-image").evaluate((el: HTMLImageElement) => ({ ok: el.complete && el.naturalWidth > 0, w: el.naturalWidth, src: el.getAttribute("src") }));
  expect(loaded.ok).toBe(true);
  console.log("AUDIT market image loaded:", JSON.stringify(loaded));
  await page.waitForTimeout(500);
  await page.waitForTimeout(900);
  await page.screenshot({ path: "test-results/ui-audit-market-list-390.png" });
  await page.getByTestId("market-card").filter({ hasText: "リザードンex" }).getByTestId("market-card-open").click();
  await expect(page.getByTestId("price-row")).toHaveCount(2);
  await page.waitForTimeout(900);
  await page.screenshot({ path: "test-results/ui-audit-market-detail-390.png" });
  await page.keyboard.press("Escape");
  await page.getByTestId("market-add").click();
  await page.waitForTimeout(900);
  await page.screenshot({ path: "test-results/ui-audit-market-add-390.png" });
  // 候補: 過去の系列＋店舗をワンタップ
  await expect(page.getByTestId("pair-chip").first()).toBeVisible();
  await page.getByTestId("pair-chip").first().click();
  await expect(page.getByTestId("price-chain")).not.toHaveValue("");
  await expect(page.getByTestId("price-store")).not.toHaveValue("");
  await page.waitForTimeout(900);
  await page.screenshot({ path: "test-results/ui-audit-market-add-filled-390.png" });
  // 相互補完: 番号→セット
  await page.getByTestId("market-card-number").fill("025/165");
  await expect(page.getByTestId("market-card-set")).toHaveValue("151");
  await expect(page.getByTestId("market-card-rarity")).toHaveValue("AR");
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);

  // 後片付け
  await a.storage.from("pokemon-images").remove(IMAGE_NOS.map((n) => `${hid}/official/${String(n).padStart(4, "0")}.webp`));
});
