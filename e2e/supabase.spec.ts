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
  await page.getByRole("tab", { name: "系列", exact: true }).click();
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

/** JST の日付・時刻（フォーム入力用） */
function jstParts(offsetMin: number) {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Tokyo", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" })
      .formatToParts(new Date(Date.now() + offsetMin * 60_000))
      .map((x) => [x.type, x.value]),
  );
  return { date: `${p.year}-${p.month}-${p.day}`, time: `${p.hour}:${p.minute}` };
}

test("PWA・通知基盤: manifest/SWは未ログインでも取得でき、通知ジョブは認証なしで拒否される", async ({ request }) => {
  const manifest = await request.get("/manifest.webmanifest");
  expect(manifest.status()).toBe(200);
  const json = await manifest.json();
  expect(json).toMatchObject({ display: "standalone", start_url: "/lotteries" });
  expect(json.icons.length).toBeGreaterThanOrEqual(2);
  const sw = await request.get("/sw.js");
  expect(sw.status()).toBe(200);
  expect(await sw.text()).toContain("showNotification");
  expect((await request.get("/icons/icon-192.png")).status()).toBe(200);

  // 通知ジョブ: 認証なし・誤った秘密は401（個人データを返さない）
  expect((await request.get("/api/cron/notify")).status()).toBe(401);
  expect((await request.post("/api/cron/notify", { headers: { authorization: "Bearer wrong" } })).status()).toBe(401);
});

test("スルー・応募ルール・要対応アラート・マトリクス", async ({ page }) => {
  await page.goto("/login");
  await page.getByLabel("メールアドレス").fill(email);
  await page.getByLabel("パスワード").fill(password);
  await page.getByRole("button", { name: "ログイン" }).click();
  await expect(page).toHaveURL(/\/lotteries$/);

  // 2時間後に締切の未応募の抽選を登録
  const dl = jstParts(120);
  await page.getByRole("button", { name: "＋ 抽選を登録" }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("系列", { exact: true }).selectOption({ label: "E2E電機" });
  await dialog.getByLabel("店舗", { exact: true }).selectOption({ label: "E2E店" });
  await dialog.getByRole("button", { name: "商品を追加" }).click();
  await dialog.getByLabel("商品1", { exact: true }).selectOption({ label: "E2Eテスト商品" });
  await dialog.getByLabel("応募締切の精度").selectOption("date_time");
  await dialog.getByLabel("応募締切の日付").fill(dl.date);
  await dialog.getByLabel("応募締切の時刻").fill(dl.time);
  await dialog.getByLabel("応募制限", { exact: true }).selectOption("account");
  await dialog.getByRole("button", { name: "保存" }).click();
  await expect(dialog).toHaveCount(0);

  // 未応募の締切間近は「要対応」に出る（プッシュ通知が使えなくても画面で確認できる）
  const alerts = page.getByTestId("alerts-bar");
  await expect(alerts).toContainText("要対応");
  await expect(alerts).toContainText("E2E電機 E2E店");

  // 詳細: 判定の根拠と、適用される応募制限
  const card = page.getByTestId("lottery-card").filter({ hasText: "E2E店" }).first();
  await card.getByRole("button", { name: "詳細" }).click();
  await expect(card.getByTestId("judge-list")).toContainText("未応募");
  await expect(card.getByTestId("rules-applied")).toContainText("1アカウント1回・抽選固有");

  // スルー: 店舗単位で追加 → 要対応から消え、カードに「店舗スルー中」。★は変わらない
  await page.goto("/settings/rules");
  await page.getByLabel("スルーの単位").selectOption("store");
  await page.getByLabel("スルーする対象").selectOption({ label: "E2E電機 E2E店" });
  await page.getByRole("button", { name: "スルーに追加" }).click();
  await expect(page.getByTestId("skip-row")).toContainText("E2E電機 E2E店");

  await page.goto("/lotteries");
  const card2 = page.getByTestId("lottery-card").filter({ hasText: "E2E店" }).first();
  await expect(card2).toContainText("店舗スルー中");
  await expect(page.getByTestId("alerts-bar")).toHaveCount(0);
  await expect(page.getByRole("tab", { name: /★管理対象/ })).toContainText("1"); // ★はスルーと独立

  // 今回だけ例外解除 → 再び未応募として扱われ、取り消すとスルーに戻る
  await card2.getByRole("button", { name: "詳細" }).click();
  await card2.getByRole("button", { name: /この抽選だけ解除/ }).click();
  await expect(card2).toContainText("スルー例外");
  await expect(page.getByTestId("alerts-bar")).toBeVisible();
  await card2.getByRole("button", { name: "今回だけの解除を取り消す" }).click();
  await expect(card2).toContainText("店舗スルー中");

  // マトリクス: 凡例とスルー表示
  await page.getByRole("button", { name: "応募マトリクスにする" }).click();
  await expect(page.getByTestId("matrix-summary")).toContainText("応募漏れの可能性");
  await expect(page.getByTestId("matrix")).toContainText("スルー");
  await expect(page.getByRole("list", { name: "凡例" })).toContainText("応募不可");
  await page.screenshot({ path: "docs/screenshots/stage3-matrix-mobile.png" });

  // スルー解除 → 未応募に戻る
  await page.goto("/settings/rules");
  await page.getByTestId("skip-row").getByRole("button", { name: "解除" }).click();
  await expect(page.getByTestId("skip-row")).toHaveCount(0);

  // 系列の標準応募制限を保存
  const chainBox = page.getByTestId("chain-rules").filter({ hasText: "E2E電機" });
  await chainBox.getByRole("button", { name: "ルールを追加" }).click();
  await chainBox.getByLabel("E2E電機のルール1の基準").selectOption("family");
  await chainBox.getByRole("button", { name: "保存" }).click();
  await expect(page.getByRole("status")).toContainText("標準応募制限を保存しました");
  await page.screenshot({ path: "docs/screenshots/stage3-rules-mobile.png", fullPage: true });
});

test("通知設定の画面: 端末の状態とプロフィール別の通知ルール", async ({ page }) => {
  await page.goto("/login");
  await page.getByLabel("メールアドレス").fill(email);
  await page.getByLabel("パスワード").fill(password);
  await page.getByRole("button", { name: "ログイン" }).click();
  await expect(page).toHaveURL(/\/lotteries$/);
  await page.goto("/settings");
  await expect(page.getByText("この端末", { exact: true })).toBeVisible();
  await expect(page.getByRole("group", { name: /通知ルール/ })).toBeVisible();
  // 日付のみの期限の扱いを設定できる（時刻を仮定しない）
  await page.getByLabel("時刻が不明（日付のみ）の期限").selectOption("none");
  await page.getByRole("button", { name: "通知ルールを保存" }).click();
  await expect(page.getByRole("status")).toContainText("通知設定を保存しました");
  await page.reload();
  await expect(page.getByLabel("時刻が不明（日付のみ）の期限")).toHaveValue("none");
});
