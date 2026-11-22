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
    const names: Record<number, string> = { 1: "フシギダネ", 4: "ヒトカゲ", 6: "リザードン", 7: "ゼニガメ", 25: "ピカチュウ", 150: "ミュウツー" };
    for (const [no, name] of Object.entries(names)) {
      const file = `${IMG_DIR}/【公式絵No.${String(no).padStart(4, "0")}】${name}.png`;
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
  await expect(page.getByTestId("market-card")).toHaveCount(2);
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
  await a.storage.from("pokemon-images").remove(["1", "4", "6", "7", "25", "150"].map((n) => `${hid}/official/${n.padStart(4, "0")}.webp`));
});
