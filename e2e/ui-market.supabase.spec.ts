import { createClient } from "@supabase/supabase-js";
import { expect, test, type Page } from "@playwright/test";

/**
 * UI改修（相場管理）の画面確認（実Supabaseのテスト世帯・架空データ・390px）。
 *   NEXT_PUBLIC_POKEMON_IMAGES=on E2E_SPEC=ui-market.supabase.spec.ts npm run test:e2e:supabase
 *  - 相場調査メモ: コンパクトな一覧（画像・名前・セット・店舗／レアリティ／状態・価格）・並び替え（アイコンのみ・長押しの一覧）
 *  - 共通化: プロフィールを切り替えても同じ記録が見え、編集できる。系列・店舗の履歴は151図鑑と共通。新規登録の初期選択は5分以内だけ
 *  - 状態違いの価格: 2件目以降もボタン選択式
 *  - 日別の調査結果: 両方の記録元を統合・カード別/店舗別・状態の絞り込み・購入予定のON/OFFと絞り込み・日付の変更・リロードしても維持・翌日は解除（表示されない）
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

async function addCard(page: Page, o: { name: string; set: string; number: string; rarity: string; chain: string; store: string; rank: string; yen: string }) {
  await page.getByTestId("market-add").click();
  await page.getByTestId("market-card-name").fill(o.name);
  await page.getByTestId("market-card-set").fill(o.set);
  await page.getByTestId("market-card-number").fill(o.number);
  await page.getByTestId("market-card-rarity").fill(o.rarity);
  await page.getByTestId("price-chain").fill(o.chain);
  await page.getByTestId("price-store").fill(o.store);
  await page.getByTestId("price-rank").getByRole("radio", { name: o.rank, exact: true }).click();
  await page.getByTestId("price-yen").fill(o.yen);
  await page.getByTestId("price-submit").click();
  await expect(page.getByTestId("market-add-sheet")).toHaveCount(0);
}

test("相場調査メモの一覧・並び替え・共通化・5分間の初期選択・状態違いの複数価格・日別の調査結果", async ({ page }) => {
  test.setTimeout(240_000);
  await page.setViewportSize({ width: 390, height: 844 });
  await login(page);
  await page.goto("/market-memo");

  // --- 登録（レアリティ・セット・店舗）。2枚目は1枚目の登録から5分以内なので、系列・店舗が初期選択される
  await addCard(page, { name: "ミロカロス", set: "SV8", number: "100/106", rarity: "SAR", chain: "トレカキャピタル", store: "垂水店", rank: "A", yen: "11000" });
  await page.getByTestId("market-add").click();
  await expect(page.getByTestId("price-chain")).toHaveValue("トレカキャピタル"); // 5分以内: 前回の組み合わせが初期選択
  await expect(page.getByTestId("price-store")).toHaveValue("垂水店");
  await page.getByTestId("market-card-name").fill("ドリュウズex");
  await page.getByTestId("market-card-set").fill("SV8");
  await page.getByTestId("market-card-number").fill("050/106");
  await page.getByTestId("market-card-rarity").fill("SAR");
  await page.getByTestId("price-yen").fill("800");
  await page.getByTestId("price-submit").click();
  await expect(page.getByTestId("market-add-sheet")).toHaveCount(0);
  await expect(page.getByTestId("market-card")).toHaveCount(2);

  // 状態違いの価格を追加（カード詳細の「価格を記録」）: 2件目以降も A+・A・B+・B・C のボタン選択式（プルダウンではない）
  await page.getByTestId("market-card").filter({ hasText: "ドリュウズ" }).getByTestId("market-card-open").click();
  await page.getByTestId("market-price-add").click();
  await page.getByTestId("price-rank").getByRole("radio", { name: "A+", exact: true }).click();
  await page.getByTestId("price-yen").fill("900");
  await page.getByTestId("price-extra-add").click();
  const extra = page.getByTestId("price-extra-row").first();
  await expect(extra.locator("select")).toHaveCount(0);
  expect(await extra.getByTestId("price-extra-rank-btn").allTextContents()).toEqual(["A+", "A", "B+", "B", "C"]);
  await extra.getByTestId("price-extra-rank-btn").nth(3).click(); // B
  await extra.getByTestId("price-extra-yen").fill("750");
  expect(await noOverflow(page)).toBe(true);
  await page.screenshot({ path: "test-results/ui-market-form-390.png" });
  await page.getByTestId("price-submit").click();
  await expect(page.getByTestId("price-row")).toHaveCount(3); // 800(A)・900(A+)・750(B)
  await page.keyboard.press("Escape");

  // --- 一覧のレイアウト（参考画像）: 左=画像・名前・セット・店舗／中央=レアリティ／右=状態・価格
  const row = page.getByTestId("market-card").filter({ hasText: "ミロカロス" });
  await expect(row.getByTestId("row-set")).toHaveText("SV8");
  await expect(row.getByTestId("row-rarity")).toHaveText("SAR");
  await expect(row.getByTestId("market-card-best")).toHaveText("11,000円");
  await expect(row.getByTestId("market-card-store")).toContainText("垂水店");
  const box = await row.getByTestId("market-card-open").boundingBox();
  expect(box!.height).toBeLessThan(64); // コンパクト
  expect(await noOverflow(page)).toBe(true);
  await page.screenshot({ path: "test-results/ui-market-list-390.png" });

  // --- 並び替え: アイコンのみ・ツールバーの他のボタンと同じ高さ。タップで循環、長押しで一覧
  const sort = page.getByTestId("market-sort");
  expect(((await sort.textContent()) ?? "").trim()).toBe("");
  const hs = (await sort.boundingBox())!.height;
  const ha = (await page.getByTestId("market-add").boundingBox())!.height;
  const hq = (await page.getByTestId("market-search").boundingBox())!.height;
  expect([hs, hq]).toEqual([ha, ha]); // 検索・並び替え・購入済み・追加のボタンはすべて同じ高さ
  const seen: string[] = [(await sort.getAttribute("data-sort"))!];
  for (let i = 0; i < 6; i++) {
    await sort.click();
    seen.push((await sort.getAttribute("data-sort"))!);
  }
  expect(seen).toEqual(["new", "priceDesc", "priceAsc", "condition", "rarity", "kana", "new"]);
  await expect(page.getByTestId("market-sort-heading")).toHaveText(/新着順/);
  await sort.hover();
  await page.mouse.down();
  await page.waitForTimeout(600);
  await page.mouse.up();
  await expect(page.getByTestId("market-sort-menu")).toBeVisible();
  expect(await page.getByTestId("market-sort-option").count()).toBe(7);
  await page.screenshot({ path: "test-results/ui-market-sort-menu-390.png" });
  await page.getByTestId("market-sort-option").filter({ hasText: "価格の安い順" }).click();
  await expect(sort).toHaveAttribute("data-sort", "priceAsc");
  expect(await page.getByTestId("market-card-name-text").allTextContents()).toEqual(["ドリュウズex", "ミロカロス"]); // 安い順（750円 → 11,000円）
  await expect(page.getByTestId("market-sort-heading")).toHaveText(/価格の安い順/);

  // --- 日別の調査結果へ（本日）。151図鑑の記録も統合される（別の記録元）
  await page.goto("/zukan");
  await expect(page.getByTestId("daily-link")).toBeVisible(); // 151図鑑からも入れる
  await page.locator('[data-testid="zukan-item"][data-no="25"]').click();
  await page.getByTestId("price-add").click();
  // 履歴は相場調査メモと共通（相場調査メモで入力した店舗が候補に出る）。直前の入力なので初期選択にもなる
  await expect(page.getByTestId("pair-chip").first()).toContainText("トレカキャピタル 垂水店");
  await expect(page.getByTestId("price-store")).toHaveValue("垂水店");
  await page.getByTestId("price-chain").fill("カードラボ");
  await page.getByTestId("price-store").fill("梅田店");
  await page.getByTestId("price-yen").fill("1500");
  await page.getByTestId("price-submit").click();
  await expect(page.getByTestId("price-row")).toHaveCount(1);
  await page.keyboard.press("Escape");

  await page.goto("/market-memo");
  await page.getByTestId("daily-link").click();
  await expect(page).toHaveURL(/\/market-memo\/daily$/);
  await expect(page.getByTestId("daily-date")).toHaveValue(jst());
  await expect(page.getByTestId("daily-row")).toHaveCount(5); // 相場調査メモ4件（ミロカロス・ドリュウズ×3状態）＋151図鑑1件
  // カード別（既定）: 図鑑番号の順。ピカチュウ(25) → ドリュウズ(530相当は範囲外) 等。グループ内は安い順
  const groups = page.getByTestId("daily-group-head");
  expect(await groups.count()).toBe(3);
  expect((await groups.first().textContent()) ?? "").toContain("ピカチュウ"); // 図鑑No.25 が最初
  const drill = page.getByTestId("daily-group").filter({ hasText: "ドリュウズex" });
  expect(await drill.getByTestId("daily-row-price").allTextContents()).toEqual(["750円", "800円", "900円"]); // 同じカード内は安い順
  expect(await noOverflow(page)).toBe(true);
  await page.screenshot({ path: "test-results/ui-market-daily-390.png" });

  // 購入予定: タップでON（背景が強調）・OFF。購入予定のみの絞り込み。リロードしても維持。詳細は「i」から
  const target = page.getByTestId("daily-row").filter({ hasText: "11,000円" });
  await target.getByTestId("daily-toggle").click();
  await expect(target).toHaveAttribute("data-planned", "1");
  await expect(page.getByTestId("daily-planned-count")).toHaveText("1");
  await page.getByTestId("daily-planned-only").click();
  await expect(page.getByTestId("daily-row")).toHaveCount(1);
  await page.screenshot({ path: "test-results/ui-market-daily-planned-390.png" });
  await target.getByTestId("daily-detail").click();
  await expect(page.getByTestId("daily-detail-sheet")).toContainText("11,000円");
  await page.keyboard.press("Escape");
  await page.reload();
  await expect(page.getByTestId("daily-planned-count")).toHaveText("1"); // 当日中は維持
  await page.getByTestId("daily-rank").filter({ hasText: /^B$/ }).click(); // 状態Bだけ
  await expect(page.getByTestId("daily-row")).toHaveCount(1);
  await page.getByTestId("daily-rank").filter({ hasText: /^B$/ }).click();
  // 店舗別に切り替え
  await page.getByTestId("daily-mode-store").click();
  expect(await page.getByTestId("daily-group").count()).toBe(2); // トレカキャピタル 垂水店（4件）・カードラボ 梅田店（1件）
  // 日付の変更: 昨日は記録なし。購入予定のマークは昨日の画面でも「今日のマーク」として判定され、翌日以降は解除される
  await page.getByTestId("daily-prev").click();
  await expect(page.getByTestId("daily-empty")).toBeVisible();
  await page.getByTestId("daily-today").click();
  await expect(page.getByTestId("daily-date")).toHaveValue(jst());

  // --- 翌日になったら購入予定は解除（表示されない）。記録は残る（マークを昨日付けにして再読み込み）
  const sb = admin();
  const { data: marks } = await sb.from("market_plan_marks").select("id").limit(10);
  expect((marks ?? []).length).toBeGreaterThan(0);
  await sb.from("market_plan_marks").update({ marked_on: "2020-01-01" }).in("id", (marks ?? []).map((m: { id: string }) => m.id));
  await page.reload();
  await expect(page.getByTestId("daily-planned-count")).toHaveText("0");
  await expect(page.getByTestId("daily-row")).toHaveCount(5); // 相場記録そのものは残っている
  // 再度ONにできる（当日の日付に更新される）
  await page.getByTestId("daily-row").filter({ hasText: "11,000円" }).getByTestId("daily-toggle").click();
  await expect(page.getByTestId("daily-planned-count")).toHaveText("1");

  // --- 5分以上経過したら、新規登録の初期選択は空欄（履歴の候補は残る）。作成時刻を6分前にして開き直す
  await sb.from("market_prices").update({ created_at: new Date(Date.now() - 6 * 60_000).toISOString() }).not("id", "is", null);
  await sb.from("zukan_price_records").update({ created_at: new Date(Date.now() - 6 * 60_000).toISOString() }).not("id", "is", null);
  await page.goto("/market-memo");
  await page.getByTestId("market-add").click();
  await expect(page.getByTestId("price-chain")).toHaveValue("");
  await expect(page.getByTestId("price-store")).toHaveValue("");
  await expect(page.getByTestId("pair-chip").first()).toBeVisible(); // 履歴は保持
  await page.keyboard.press("Escape");

  // --- 共通化: 別のプロフィールに切り替えても同じ記録が見える
  const profileBefore = await page.getByTestId("current-profile").textContent();
  await page.getByRole("button", { name: /ユーザー切り替え/ }).click();
  const radios = page.getByRole("radio", { name: /^プロフィール / });
  const n = await radios.count();
  if (n >= 2) {
    for (let i = 0; i < n; i++) {
      if (((await radios.nth(i).getAttribute("aria-checked")) ?? "") !== "true") {
        await radios.nth(i).click();
        break;
      }
    }
    await expect(page.getByTestId("current-profile")).not.toHaveText(profileBefore ?? "");
    await page.goto("/market-memo");
    await expect(page.getByTestId("market-card")).toHaveCount(2); // 別のプロフィールでも同じ2枚
    await page.goto("/market-memo/daily");
    await expect(page.getByTestId("daily-row")).toHaveCount(5);
    await expect(page.getByTestId("daily-planned-count")).toHaveText("1"); // 購入予定も共通
  }

  // --- 後始末（テスト世帯の記録は世帯の削除で消えるが、再実行のために消す）
  await sb.from("market_plan_marks").delete().not("id", "is", null);
});
