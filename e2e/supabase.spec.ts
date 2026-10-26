import { expect, test } from "@playwright/test";

const email = process.env.E2E_EMAIL!;
const password = process.env.E2E_PASSWORD!;

test("未ログインはログイン画面へ。誤パスワードは拒否される", async ({ page }) => {
  await page.goto("/lotteries");
  await expect(page).toHaveURL(/\/login$/);
  await page.getByLabel("メールアドレス").fill(email);
  await page.getByLabel("パスワード").fill("wrong-password");
  await page.getByRole("button", { name: "ログイン" }).click();
  await expect(page.getByText("メールアドレスまたはパスワードが正しくありません")).toBeVisible();
});

test("ログイン→プロフィール切替→マスター登録・アーカイブ→ログアウト", async ({ page }) => {
  await page.goto("/login");
  await page.getByLabel("メールアドレス").fill(email);
  await page.getByLabel("パスワード").fill(password);
  await page.getByRole("button", { name: "ログイン" }).click();
  await expect(page).toHaveURL(/\/lotteries$/);
  await expect(page.getByRole("radio", { name: /プロフィール [ABC]/ })).toHaveCount(3);

  // プロフィール選択は端末に保存される
  await page.getByRole("radio", { name: "プロフィール B" }).click();
  await page.reload();
  await expect(page.getByRole("radio", { name: "プロフィール B", checked: true })).toBeVisible();

  // マスター: 系列を追加→一覧に出る→アーカイブで非表示（削除ではない）
  const name = `E2E系列-${Date.now()}`;
  await page.goto("/settings/masters");
  await page.getByRole("tab", { name: "系列" }).click();
  await page.getByRole("button", { name: "＋ 追加" }).click();
  await page.getByLabel(/系列名/).fill(name);
  await page.getByRole("button", { name: "保存" }).click();
  const row = page.getByTestId("master-row").filter({ hasText: name });
  await expect(row).toBeVisible();

  // 同名は重複エラー
  await page.getByRole("button", { name: "＋ 追加" }).click();
  await page.getByLabel(/系列名/).fill(name);
  await page.getByRole("button", { name: "保存" }).click();
  await expect(page.getByRole("alert")).toContainText("既に登録");
  await page.getByRole("button", { name: "キャンセル" }).click();

  await row.getByRole("button", { name: "アーカイブ" }).click();
  await expect(row).toHaveCount(0);
  await page.getByLabel("アーカイブも表示").check();
  await expect(row).toContainText("アーカイブ済み");

  await page.goto("/settings");
  await page.getByRole("button", { name: "ログアウト" }).click();
  await expect(page).toHaveURL(/\/login$/);
  await page.goto("/settings/masters");
  await expect(page).toHaveURL(/\/login$/);
});

test("抽選の登録（過去の締切・当選まで）→当選タブ→購入済み→購入履歴→再読込でも保持", async ({ page }) => {
  await page.goto("/login");
  await page.getByLabel("メールアドレス").fill(email);
  await page.getByLabel("パスワード").fill(password);
  await page.getByRole("button", { name: "ログイン" }).click();
  await expect(page).toHaveURL(/\/lotteries$/);

  await page.getByRole("button", { name: "＋ 抽選を登録" }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("系列", { exact: true }).selectOption({ label: "E2E電機" });
  await dialog.getByLabel("店舗", { exact: true }).selectOption({ label: "E2E店" });
  await dialog.getByRole("button", { name: "商品を追加" }).click();
  await dialog.getByLabel("商品1", { exact: true }).selectOption({ label: "E2Eテスト商品" });
  // 応募締切は過去の日時、発表は日付のみ（時刻は推測しない）
  await dialog.getByLabel("応募締切の精度").selectOption("date_time");
  await dialog.getByLabel("応募締切の日付").fill("2026-01-10");
  await dialog.getByLabel("応募締切の時刻").fill("23:59");
  await dialog.getByLabel("当選発表の精度").selectOption("date_only");
  await dialog.getByLabel("当選発表の日付").fill("2026-01-15");
  await dialog.getByLabel(/E2E-acc.*の応募状況/).selectOption("won");
  await page.screenshot({ path: "docs/screenshots/stage2-form-mobile.png" });
  await dialog.getByRole("button", { name: "保存" }).click();
  await expect(dialog).toHaveCount(0);

  // 期限切れの管理対象は「★管理対象」から自動整理され、当選タブ・全情報に残る
  await expect(page.getByRole("tab", { name: /★管理対象/ })).toContainText("0");
  await page.getByRole("tab", { name: /当選/ }).click();
  const card = page.getByTestId("lottery-card").first();
  await expect(card).toContainText("E2E電機 E2E店");
  await expect(card).toContainText("時刻未確認"); // 発表日は日付のみ
  await expect(card).toContainText("E2Eテスト商品 1BOX (20P)".replace("1BOX", "1BOX"));

  // 購入済みを何度押しても購入記録は1件
  await card.getByRole("button", { name: "購入済み" }).click();
  await expect(card).toContainText("購入・受取済み");

  await page.goto("/records");
  await expect(page.getByTestId("purchase-list").getByRole("listitem").filter({ hasText: "当選から" })).toHaveCount(1);

  // 抽選外の購入（日時・金額は不明のまま）
  await page.getByRole("button", { name: "＋ 購入を記録" }).click();
  const pd = page.getByRole("dialog");
  await pd.getByLabel("商品1").selectOption({ label: "E2Eテスト商品" });
  await pd.getByRole("button", { name: "保存" }).click();
  await expect(pd).toHaveCount(0);
  const manual = page.getByTestId("purchase-list").getByRole("listitem").filter({ hasText: "手入力" });
  await expect(manual).toContainText("日時不明");
  await expect(manual).toContainText("金額不明");

  // 再読込しても保存されている（DB保存）
  await page.goto("/lotteries");
  await page.getByRole("tab", { name: /全情報/ }).click();
  await expect(page.getByTestId("lottery-card")).toHaveCount(1);
  await page.getByRole("tab", { name: /当選/ }).click();
  await expect(page.getByTestId("lottery-card").first()).toContainText("購入・受取済み");
});
