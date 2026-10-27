import { expect, test, type Page } from "@playwright/test";

const email = process.env.E2E_EMAIL!;
const password = process.env.E2E_PASSWORD!;

async function login(page: Page) {
  await page.goto("/login");
  await page.getByLabel("メールアドレス").fill(email);
  await page.getByLabel("パスワード").fill(password);
  await page.getByRole("button", { name: "ログイン" }).click();
  await expect(page).toHaveURL(/\/lotteries$/);
}

/** 抽選登録ダイアログの系列・店舗・商品1を、マスターの有無に関わらず名称入力で埋める */
async function fillMasters(dialog: ReturnType<Page["getByRole"]>, chain: string, store: string, product: string) {
  await dialog.getByRole("combobox", { name: "系列", exact: true }).fill(chain);
  await dialog.getByRole("combobox", { name: "店舗", exact: true }).fill(store);
  await dialog.getByRole("combobox", { name: "商品1", exact: true }).fill(product);
}

test("未ログインはログイン画面へ。誤パスワードは拒否される", async ({ page }) => {
  await page.goto("/lotteries");
  await expect(page).toHaveURL(/\/login$/);
  await page.getByLabel("メールアドレス").fill(email);
  await page.getByLabel("パスワード").fill("wrong-password");
  await page.getByRole("button", { name: "ログイン" }).click();
  await expect(page.getByText("メールアドレスまたはパスワードが正しくありません")).toBeVisible();
});

test("ログイン→ユーザー切替→マスター登録・アーカイブ→ログアウト", async ({ page }) => {
  await login(page);
  const header = page.locator("header");
  await expect(header).not.toContainText("操作中");

  // ユーザー切替は現在のユーザーのみ表示→タップで切り替え画面。選択は端末に保存される
  await page.getByRole("button", { name: /ユーザー切り替え/ }).click();
  await expect(page.getByRole("radio", { name: /プロフィール [ABC]/ })).toHaveCount(3);
  await page.getByRole("radio", { name: "プロフィール B" }).click();
  await page.reload();
  await expect(page.locator("header").getByTestId("current-profile")).toHaveText("B");

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

test("マスター未登録でも抽選を登録→当選→購入済み→収支に反映→金額修正→手入力の支出・売却→分析→再読込でも保持", async ({ page }) => {
  await login(page);

  // マスターは1つも作らず、名称を入力するだけで登録（保存時に仮登録される）
  await page.getByRole("button", { name: "＋抽選を登録" }).click();
  const dialog = page.getByRole("dialog");
  await fillMasters(dialog, "E2E電機", "E2E店", "E2Eテスト商品");
  await expect(dialog.getByTestId("new-master-hint").first()).toContainText("仮登録");
  // 応募締切は過去の日時、発表は日付のみ（時刻は推測しない）
  await dialog.getByLabel("応募締切の精度").selectOption("date_time");
  await dialog.getByLabel("応募締切の日付").fill("2026-01-10");
  await dialog.getByLabel("応募締切の時刻").fill("23:59");
  await dialog.getByLabel("当選発表の精度").selectOption("date_only");
  await dialog.getByLabel("当選発表の日付").fill("2026-01-15");
  await dialog.getByLabel("Aの応募状況").selectOption("won");
  await page.screenshot({ path: "docs/screenshots/stage35-form-mobile.png" });
  await dialog.getByRole("button", { name: "保存" }).click();
  await expect(dialog).toHaveCount(0);

  // 期限切れの管理対象は「★管理対象」から自動整理され、当選タブ・全情報に残る
  await expect(page.getByRole("tab", { name: /★管理対象/ })).toContainText("0");
  await page.getByRole("tab", { name: /当選/ }).click();
  const card = page.getByTestId("lottery-card").first();
  await expect(card).toContainText("E2E電機 E2E店");
  await expect(card).toContainText("時刻未確認"); // 発表日は日付のみ
  await expect(card).toContainText("E2Eテスト商品 1BOX");
  await expect(card).not.toContainText("(30P)"); // 仮登録商品の入数は未確認のため換算を出さない
  // 当選・購入未完了なので、当選タブに赤丸
  await expect(page.getByTestId("tab-dot-won")).toBeVisible();

  // 購入済みを何度押しても購入記録は1件
  await card.getByRole("button", { name: "購入済み" }).click();
  await expect(card).toContainText("購入・受取済み");
  await expect(page.getByTestId("tab-dot-won")).toHaveCount(0);

  // 仮登録のマスターはマスター管理に「仮登録」として出る（重複せず1件ずつ）
  await page.goto("/settings/masters");
  await page.getByRole("tab", { name: "系列", exact: true }).click();
  await expect(page.getByTestId("master-row").filter({ hasText: "E2E電機" })).toHaveCount(1);
  await expect(page.getByTestId("master-row").filter({ hasText: "E2E電機" }).getByTestId("provisional-badge")).toBeVisible();

  // 収支: 抽選の購入が支出として入り（金額未入力は0円とみなさない）、実際の金額を修正できる
  await page.goto("/finance");
  const rows = page.getByTestId("ledger-row").filter({ hasText: "E2Eテスト商品" });
  await expect(rows).toHaveCount(1);
  await expect(rows).toContainText("金額未入力");
  await rows.click();
  const exp = page.getByRole("dialog");
  await expect(exp).toContainText("抽選の当選から作成された購入");
  await exp.getByLabel("購入金額1").fill("5400");
  await exp.getByRole("button", { name: "保存" }).click();
  await expect(exp).toHaveCount(0);
  await expect(rows).toContainText("-5,400円");
  await expect(page.getByTestId("sum-expense")).toHaveText("5,400円");

  // 手入力の支出: マスターにある商品（購入実績に紐づく）。数量変更しても手入力した金額は上書きしない
  await page.getByRole("button", { name: "＋支出" }).click();
  const add = page.getByRole("dialog");
  await add.getByRole("combobox", { name: "商品1", exact: true }).fill("E2Eテスト商品");
  await add.getByLabel("数量1").fill("5");
  await add.getByLabel("単位1").selectOption("pack");
  await add.getByLabel("購入金額1").fill("900");
  await add.getByLabel("数量1").fill("6"); // 金額は手入力済みなので900のまま
  await expect(add.getByLabel("購入金額1")).toHaveValue("900");
  await add.getByRole("combobox", { name: "購入店舗" }).fill("マスターにない店");
  await add.getByRole("button", { name: "保存" }).click();
  await expect(add).toHaveCount(0);
  await expect(page.getByTestId("sum-expense")).toHaveText("6,300円");
  await expect(page.getByTestId("ledger-row").filter({ hasText: "マスターにない店" })).toContainText("-900円");

  // 売却（収入）: 名義人・原価を購入履歴から紐づけ（同じ購入分は重複して使えない）
  await page.getByRole("button", { name: "＋売却" }).click();
  const sale = page.getByRole("dialog");
  await sale.getByRole("combobox", { name: "売却商品" }).fill("E2E売却品");
  await sale.getByLabel("売却金額").fill("8000");
  await sale.getByRole("radiogroup", { name: "売却名義人" }).getByRole("radio", { name: "B" }).click();
  await sale.getByLabel("販売手数料").fill("300");
  await sale.getByLabel("送料").fill("200");
  await sale.getByText("購入履歴から選ぶ").click();
  await sale.getByLabel("原価にする購入").selectOption({ index: 1 });
  await sale.getByLabel("原価にする数量").fill("1");
  await sale.getByRole("button", { name: "保存" }).click();
  await expect(sale).toHaveCount(0);
  await expect(page.getByTestId("sum-income")).toHaveText("8,000円");
  await expect(page.getByTestId("sum-net")).toHaveText("1,700円");

  // 収入タブ: 売却名義人で絞り込み（初期値は全員）
  await page.getByRole("tab", { name: "収入" }).click();
  await expect(page.getByTestId("ledger-row")).toHaveCount(1);
  await page.getByRole("group", { name: "売却名義人で絞り込み" }).getByRole("button", { name: "A", exact: true }).click();
  await expect(page.getByTestId("ledger-row")).toHaveCount(0);
  await page.getByRole("group", { name: "売却名義人で絞り込み" }).getByRole("button", { name: "B", exact: true }).click();
  await expect(page.getByTestId("ledger-row")).toHaveCount(1);

  // 年間実績: Bの売却額・利益。原価は紐づけた購入の按分
  await page.goto("/finance/analysis");
  const total = page.getByTestId("annual-total");
  await expect(total).toContainText("8,000円");
  const seller = page.getByTestId("annual-seller").filter({ hasText: "B" });
  await expect(seller).toContainText("8,000円");
  await expect(page.getByTestId("cost-unknown")).toHaveCount(0); // 原価は確定済み

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

test("スルー・応募ルール・ベルの通知・マトリクス", async ({ page }) => {
  await login(page);

  // 2時間後に締切の未応募の抽選を登録（既存マスターは名称の一致で再利用され、重複作成されない）
  const dl = jstParts(120);
  await page.getByRole("button", { name: "＋抽選を登録" }).click();
  const dialog = page.getByRole("dialog");
  await fillMasters(dialog, "E2E電機", "E2E店", "E2Eテスト商品");
  await expect(dialog.getByTestId("new-master-hint")).toHaveCount(0); // すべて既存マスター
  await dialog.getByLabel("応募締切の精度").selectOption("date_time");
  await dialog.getByLabel("応募締切の日付").fill(dl.date);
  await dialog.getByLabel("応募締切の時刻").fill(dl.time);
  await dialog.getByLabel("応募制限", { exact: true }).selectOption("account");
  await dialog.getByRole("button", { name: "保存" }).click();
  await expect(dialog).toHaveCount(0);

  // 未応募の締切間近はベルに集約される（画面上部にアラートを縦に並べない）。件数バッジ→一覧→該当抽選へ
  await expect(page.getByTestId("alerts-bar")).toHaveCount(0);
  await expect(page.getByTestId("notification-badge")).toHaveText("1");
  await page.getByTestId("notification-bell").click();
  await expect(page.getByTestId("alerts-list")).toContainText("E2E電機 E2E店");
  await page.getByTestId("alerts-list").getByRole("link").first().click();
  await expect(page).toHaveURL(/focus=/);

  // 詳細: 判定の根拠と、適用される応募制限
  const card = page.getByTestId("lottery-card").filter({ hasText: "E2E店" }).first();
  await card.getByRole("button", { name: "詳細" }).click();
  await expect(card.getByTestId("judge-list")).toContainText("未応募");
  await expect(card.getByTestId("rules-applied")).toContainText("1アカウント1回・抽選固有");

  // 応募すると未対応が減り、ベルのバッジが消える
  await card.getByRole("button", { name: /^A: 未応募/ }).click();
  await expect(page.getByTestId("notification-badge")).toHaveCount(0);
  await card.getByRole("button", { name: /^A: 応募済み/ }).click(); // 取消して未応募に戻す
  await expect(page.getByTestId("notification-badge")).toHaveText("1");

  // スルー: 店舗単位で追加 → ベルから消え、★管理対象の通常表示からも外れる。★自体は変わらない
  await page.goto("/settings/rules");
  await page.getByLabel("スルーの単位").selectOption("store");
  await page.getByLabel("スルーする対象").selectOption({ label: "E2E電機 E2E店" });
  await page.getByRole("button", { name: "スルーに追加" }).click();
  await expect(page.getByTestId("skip-row")).toContainText("E2E電機 E2E店");

  await page.goto("/lotteries");
  await expect(page.getByTestId("notification-badge")).toHaveCount(0);
  await expect(page.getByLabel("スルー表示")).toHaveValue("normal");
  await expect(page.getByTestId("lottery-card").filter({ hasText: "E2E店" })).toHaveCount(0); // 通常表示: 自分がスルーしたものは除く
  await page.getByLabel("スルー表示").selectOption("only");
  const card2 = page.getByTestId("lottery-card").filter({ hasText: "E2E店" }).first();
  await expect(card2).toContainText("店舗スルー中");
  await page.getByLabel("スルー表示").selectOption("include");
  await expect(card2).toBeVisible();

  // 今回だけ例外解除 → 再び未応募として扱われ、取り消すとスルーに戻る
  await card2.getByRole("button", { name: "詳細" }).click();
  await card2.getByRole("button", { name: /この抽選だけ解除/ }).click();
  await expect(card2).toContainText("スルー例外");
  await expect(page.getByTestId("notification-badge")).toHaveText("1");
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

test("複数商品の抽選（B方式）: 商品ごとの当落→当選した商品だけが購入・収支に入る", async ({ page }) => {
  await login(page);
  await page.getByRole("button", { name: "＋抽選を登録" }).click();
  const dialog = page.getByRole("dialog");
  await fillMasters(dialog, "E2E電機", "E2E店", "E2E複数商品1");
  await dialog.getByLabel("抽選の方式").selectOption({ label: "B. 1回の応募で複数商品に参加（商品ごとに当落）" });
  await dialog.getByRole("combobox", { name: "商品2", exact: true }).fill("E2E複数商品2");
  await dialog.getByLabel("単位2").selectOption("pack");
  await dialog.getByLabel("数量2").fill("3");
  await dialog.getByLabel("Aの応募状況").selectOption("applied");
  await dialog.getByRole("button", { name: "保存" }).click();
  await expect(dialog).toHaveCount(0);

  const card = page.getByTestId("lottery-card").filter({ hasText: "E2E複数商品1" });
  await expect(card).toContainText("＋他1商品"); // シンプル表示は省スペース
  await expect(card).toContainText("商品ごとに当落");
  await card.getByRole("button", { name: "詳細" }).click();
  await expect(card).toContainText("E2E複数商品2");
  // 商品1は当選・商品2は落選
  await card.getByRole("group", { name: /^A E2E複数商品1.*の結果$/ }).getByRole("button", { name: "当選" }).click();
  await card.getByRole("group", { name: /^A E2E複数商品2.*の結果$/ }).getByRole("button", { name: "落選" }).click();
  await expect(card.getByTestId("item-result-tag").first()).toContainText("当選");

  // 当選タブ: 当選した商品だけ表示。購入済みにすると収支の支出に当選商品のみが数量どおり入る
  await page.getByRole("tab", { name: /当選/ }).click();
  const won = page.getByTestId("lottery-card").filter({ hasText: "E2E複数商品1" });
  await expect(won).toContainText("E2E複数商品1 1BOX");
  await won.getByRole("button", { name: "購入済み" }).click();
  await expect(won).toContainText("購入・受取済み");
  await page.goto("/finance");
  const row = page.getByTestId("ledger-row").filter({ hasText: "E2E複数商品1" });
  await expect(row).toHaveCount(1);
  await expect(page.getByTestId("ledger-row").filter({ hasText: "E2E複数商品2" })).toHaveCount(0);
});

test("ユーザー設定: 表示名・色・マーク・通知先を変更でき、ヘッダーとカードに反映される", async ({ page }) => {
  await login(page);
  await page.goto("/settings");
  await page.getByRole("button", { name: "Cの設定を編集" }).click();
  const dlg = page.getByRole("dialog");
  await dlg.getByLabel("表示名").fill("サブ");
  await dlg.getByRole("button", { name: "星" }).click();
  await dlg.getByLabel("自由な色").fill("#ff8800");
  await dlg.getByLabel("指定したユーザー（例: A・B 両方）").check();
  await dlg.getByRole("checkbox", { name: "A", exact: true }).check();
  await dlg.getByRole("button", { name: "保存" }).click();
  await expect(dlg).toHaveCount(0);
  await expect(page.getByText("通知先: A").first()).toBeVisible();

  // ヘッダーでサブに切り替えると、現在のユーザー名が反映される
  await page.getByRole("button", { name: /ユーザー切り替え/ }).click();
  await page.getByRole("radio", { name: "プロフィール サブ" }).click();
  await expect(page.locator("header").getByTestId("current-profile")).toHaveText("サブ");
});

test("通知設定の画面: 端末の状態とプロフィール別の通知ルール", async ({ page }) => {
  await login(page);
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
