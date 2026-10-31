import { crc32, deflateSync } from "node:zlib";
import { expect, test, type Page } from "@playwright/test";

/** 透過PNG（w×h・半透明の単色）をその場で生成する（リポジトリに画像を置かない） */
function makePng(w: number, h: number, rgb: [number, number, number]): Buffer {
  const raw = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) raw.set([...rgb, x < 3 ? 0 : 255], y * (w * 4 + 1) + 1 + x * 4);
  const chunk = (type: string, data: Buffer) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body));
    return Buffer.concat([len, body, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr.set([8, 6, 0, 0, 0], 8);
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}

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

/** 詳細フィルターを開く（既に開いていれば何もしない） */
async function openFilters(page: Page) {
  const btn = page.getByRole("button", { name: "詳細フィルターを開く" });
  if ((await btn.getAttribute("aria-pressed")) !== "true") await btn.click();
  await expect(page.getByRole("group", { name: "詳細フィルター" })).toBeVisible();
}

/** 下から開くパネルを閉じる（右上の閉じるボタンは無い。Esc・ハンドル・背景タップで閉じる） */
async function closeSheet(page: Page) {
  await page.keyboard.press("Escape");
}

/** 設定の一覧で、アコーディオンの項目を開く（開いていれば何もしない） */
async function openAccordion(page: Page, testId: string) {
  const acc = page.getByTestId(testId);
  const btn = acc.getByRole("button").first();
  if ((await btn.getAttribute("aria-expanded")) !== "true") await btn.click();
  await expect(btn).toHaveAttribute("aria-expanded", "true");
  return acc;
}

/** 抽選フォームの「詳細設定」（抽選方式・キャンペーンなど）を開く */
async function openFormDetails(dialog: ReturnType<Page["getByRole"]>) {
  const details = dialog.getByTestId("form-details");
  if ((await details.getAttribute("open")) === null) await details.locator("summary").click();
}

/** カードをタップして開く詳細パネル */
async function openDetail(page: Page, card: ReturnType<Page["getByTestId"]>) {
  await card.getByRole("button", { name: /の詳細を開く/ }).click();
  const sheet = page.getByTestId("lottery-detail-sheet");
  await expect(sheet).toBeVisible();
  return sheet;
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
  await openAccordion(page, "acc-about");
  await page.getByRole("button", { name: "ログアウト", exact: true }).click();
  await expect(page).toHaveURL(/\/login$/);
  await page.goto("/settings/masters");
  await expect(page).toHaveURL(/\/login$/);
});

test("マスター未登録でも抽選を登録→当選→購入済み→収支に反映→金額修正→手入力の支出・売却→分析→再読込でも保持", async ({ page }) => {
  await login(page);

  // マスターは1つも作らず、名称を入力するだけで登録（保存時に仮登録される）
  await page.getByRole("button", { name: "＋登録" }).click();
  const dialog = page.getByRole("dialog");
  await fillMasters(dialog, "E2E電機", "E2E店", "E2Eテスト商品");
  await expect(dialog.getByTestId("new-master-hint").first()).toContainText("仮登録");
  // 応募締切は過去の日時、発表は日付のみ（時刻は推測しない）
  await dialog.getByLabel("応募締切の日付").fill("2026-01-10");
  await dialog.getByLabel("応募締切の時刻").fill("23:59");
  await dialog.getByLabel("当選発表の日付").fill("2026-01-15"); // 時刻は入力しない = 日付のみ
  await dialog.getByLabel("Aの応募状況").selectOption("won");
  await page.screenshot({ path: "docs/screenshots/stage35-form-mobile.png" });
  await dialog.getByRole("button", { name: "保存" }).click();
  await expect(dialog).toHaveCount(0);

  // 期限切れの管理対象は「★管理対象」から自動整理され、当選タブ・全情報に残る
  await expect(page.getByRole("tab", { name: /★管理対象/ })).toContainText("0");
  await page.getByRole("tab", { name: /当選/ }).click();
  const card = page.getByTestId("lottery-card").first();
  await expect(card).toContainText("E2E電機 E2E店");
  await expect(card.getByLabel(/当選発表 .*時刻未確認/)).toBeVisible(); // 発表日は日付のみ（時刻は推測しない）
  await expect(card).toContainText(/E2Eテスト商品\s*1BOX/);
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
  expect((await request.get("/icons/v2/icon-192.png")).status()).toBe(200);

  // 通知ジョブ: 認証なし・誤った秘密は401（個人データを返さない）
  expect((await request.get("/api/cron/notify")).status()).toBe(401);
  expect((await request.post("/api/cron/notify", { headers: { authorization: "Bearer wrong" } })).status()).toBe(401);
});

test("スルー・応募ルール・ベルの通知・マトリクス", async ({ page }) => {
  await login(page);

  // 2時間後に締切の未応募の抽選を登録（既存マスターは名称の一致で再利用され、重複作成されない）
  const dl = jstParts(120);
  await page.getByRole("button", { name: "＋登録" }).click();
  const dialog = page.getByRole("dialog");
  await fillMasters(dialog, "E2E電機", "E2E店", "E2Eテスト商品");
  await expect(dialog.getByTestId("new-master-hint")).toHaveCount(0); // すべて既存マスター
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
  const sheet = await openDetail(page, card);
  await expect(sheet.getByTestId("judge-list")).toContainText("未応募");
  await expect(sheet.getByTestId("rules-applied")).toContainText("1アカウント1回・抽選固有");
  await closeSheet(page);
  await expect(sheet).toHaveCount(0);

  // 応募すると未対応が減り、ベルのバッジが消える
  await card.getByTestId("my-apply").click(); // 現在のプロフィール(A)だけを応募済みにする
  await expect(page.getByTestId("notification-badge")).toHaveCount(0);
  await card.getByTestId("my-apply").click(); // 取消して未応募に戻す（確認つき）
  await page.getByRole("button", { name: "解除する" }).click();
  await expect(page.getByTestId("notification-badge")).toHaveText("1");

  // スルー: 店舗単位で追加 → ベルから消え、★管理対象の通常表示からも外れる。★自体は変わらない
  await page.goto("/settings/rules");
  await page.getByLabel("スルーの単位").selectOption("store");
  await page.getByLabel("スルーする対象").selectOption({ label: "E2E電機 E2E店" });
  await page.getByRole("button", { name: "スルーに追加" }).click();
  await expect(page.getByTestId("skip-row")).toContainText("E2E電機 E2E店");

  await page.goto("/lotteries");
  await expect(page.getByTestId("notification-badge")).toHaveCount(0);
  await openFilters(page);
  await expect(page.getByLabel("スルー表示")).toHaveValue("normal");
  await expect(page.getByTestId("lottery-card").filter({ hasText: "E2E店" })).toHaveCount(0); // 通常表示: 自分がスルーしたものは除く
  await page.getByLabel("スルー表示").selectOption("only");
  const card2 = page.getByTestId("lottery-card").filter({ hasText: "E2E店" }).first();
  await expect(card2).toContainText("店舗スルー中");
  await page.getByLabel("スルー表示").selectOption("include");
  await expect(card2).toBeVisible();

  // 今回だけ例外解除 → 再び未応募として扱われ、取り消すとスルーに戻る
  const sheet2 = await openDetail(page, card2);
  await sheet2.getByRole("button", { name: /この抽選だけ解除/ }).click();
  await expect(card2).toContainText("スルー例外");
  await expect(page.getByTestId("notification-badge")).toHaveText("1");
  await sheet2.getByRole("button", { name: "今回だけの解除を取り消す" }).click();
  await expect(card2).toContainText("店舗スルー中");
  await closeSheet(page);

  // マトリクス: 凡例とスルー表示
  await page.getByRole("button", { name: "応募マトリクスにする" }).click();
  await expect(page.getByTestId("matrix-summary")).toContainText("応募漏れの可能性");
  await expect(page.getByTestId("matrix").locator('[data-status="skipped"]').first()).toBeVisible(); // スルーはアイコン表示
  await page.getByTestId("matrix").getByRole("button", { name: "アイコンの意味", exact: true }).click();
  await expect(page.getByRole("list", { name: "アイコンの意味" })).toContainText("応募不可");
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
  await page.getByRole("button", { name: "＋登録" }).click();
  const dialog = page.getByRole("dialog");
  await fillMasters(dialog, "E2E電機", "E2E店", "E2E複数商品1");
  await openFormDetails(dialog);
  await dialog.getByLabel("抽選の方式", { exact: true }).selectOption({ label: "B. 1回の応募で複数商品に参加（商品ごとに当落）" });
  await dialog.getByRole("combobox", { name: "商品2", exact: true }).fill("E2E複数商品2");
  await dialog.getByLabel("単位2").selectOption("pack");
  await dialog.getByLabel("数量2").fill("3");
  await dialog.getByLabel("Aの応募状況").selectOption("applied");
  await dialog.getByRole("button", { name: "保存" }).click();
  await expect(dialog).toHaveCount(0);

  const card = page.getByTestId("lottery-card").filter({ hasText: "E2E複数商品1" });
  // 詳細表示・シンプル表示とも、先頭の1種類＋「＋他N種」に集約（全商品は詳細パネル。表示はユーザーごとの設定）
  await expect(card.getByTestId("extra-kinds")).toHaveText("＋他1種");
  await page.getByRole("button", { name: "シンプル表示にする" }).click();
  await expect(card.getByTestId("extra-kinds")).toHaveText("＋他1種");
  await page.waitForTimeout(350); // 表示切替の連続発火ゲート(300ms)
  await page.getByRole("button", { name: "詳細表示にする" }).click();
  const msheet = await openDetail(page, card);
  await expect(msheet).toContainText("商品ごとに当落"); // 方式は詳細パネルで確認
  await expect(msheet).toContainText("E2E複数商品2");
  // 商品1は当選・商品2は落選
  await msheet.getByRole("group", { name: /^A E2E複数商品1.*の結果$/ }).getByRole("button", { name: "当選" }).click();
  await msheet.getByRole("group", { name: /^A E2E複数商品2.*の結果$/ }).getByRole("button", { name: "落選" }).click();
  await expect(msheet.getByTestId("item-result-tag").first()).toContainText("当選");
  await closeSheet(page);

  // 当選タブ: 当選した商品だけ表示。購入済みにすると収支の支出に当選商品のみが数量どおり入る
  await page.getByRole("tab", { name: /当選/ }).click();
  const won = page.getByTestId("lottery-card").filter({ hasText: "E2E複数商品1" });
  await expect(won).toContainText(/E2E複数商品1\s*1BOX/);
  await won.getByRole("button", { name: "購入済み" }).click();
  await expect(won).toContainText("購入・受取済み");
  await page.goto("/finance");
  const row = page.getByTestId("ledger-row").filter({ hasText: "E2E複数商品1" });
  await expect(row).toHaveCount(1);
  await expect(page.getByTestId("ledger-row").filter({ hasText: "E2E複数商品2" })).toHaveCount(0);
});

test("ユーザー設定: 表示名・色・マーク・通知先を変更でき、ヘッダーとカードに反映される", async ({ page }) => {
  await login(page);
  await page.goto("/settings/users");
  await page.getByRole("button", { name: "Cの設定を編集" }).click();
  const dlg = page.getByRole("dialog");
  await dlg.getByLabel("表示名").fill("サブ");
  // アイコンは20種類以上のコンパクトなグリッド。鳥も選べる（選び直しても保存前の状態は変わらない）
  expect(await dlg.getByRole("group", { name: "アイコンのマーク" }).or(dlg.locator("fieldset").filter({ hasText: "アイコンのマーク" })).getByRole("button").count()).toBeGreaterThanOrEqual(20);
  await dlg.getByRole("button", { name: "とり" }).click();
  await expect(dlg.getByRole("button", { name: "とり" })).toHaveAttribute("aria-pressed", "true");
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

test("商品画像: 画像なしはプレースホルダー、手動アップロードで縦横比を保って表示、差し替え・商品編集もできる", async ({ page }) => {
  await login(page);
  // 画像なしの商品を（抽選登録の自動仮登録で）用意
  await page.getByRole("button", { name: "＋登録" }).click();
  const dialog = page.getByRole("dialog");
  await fillMasters(dialog, "E2E画像電機", "E2E画像店", "E2E画像商品");
  await dialog.getByRole("button", { name: "保存" }).click();
  await expect(dialog).toHaveCount(0);
  // 抽選カード: 画像が無くても問題なく表示（共通プレースホルダー）
  await page.getByRole("tab", { name: /全情報/ }).click();
  const card = page.getByTestId("lottery-card").filter({ hasText: "E2E画像商品" });
  await expect(card.getByTestId("image-placeholder")).toBeVisible();

  await page.goto("/settings/masters");
  await page.getByRole("tab", { name: "商品", exact: true }).click();
  const row = page.getByTestId("master-row").filter({ hasText: "E2E画像商品" });
  await expect(row.getByTestId("image-placeholder")).toBeVisible();
  await row.getByRole("button", { name: /の画像を管理/ }).click();
  const dlg = page.getByRole("dialog");
  await expect(dlg.getByTestId("image-slot-box").getByTestId("image-placeholder")).toBeVisible();

  // BOX画像（425x500）をアップロード → 縦横比を保って表示される（正方形に変形されない）
  await dlg.getByLabel("BOX画像を選択").setInputFiles({ name: "x_b.png", mimeType: "image/png", buffer: makePng(425, 500, [200, 60, 60]) });
  const box = dlg.getByTestId("image-slot-box").getByRole("img", { name: /BOX/ });
  await expect(box).toBeVisible();
  await expect(dlg.getByTestId("image-slot-box")).toContainText("手動で登録");
  await expect(dlg.getByTestId("image-slot-pack").getByTestId("image-placeholder")).toBeVisible(); // 片方だけでも問題なし
  const b = (await box.boundingBox())!;
  expect(Math.abs(b.width / b.height - 425 / 500)).toBeLessThan(0.03);

  // パック画像（266x500）も追加し、BOXを差し替え
  await dlg.getByLabel("パック画像を選択").setInputFiles({ name: "x_p.png", mimeType: "image/png", buffer: makePng(266, 500, [60, 60, 200]) });
  const pack = dlg.getByTestId("image-slot-pack").getByRole("img", { name: /パック/ });
  await expect(pack).toBeVisible();
  const pb = (await pack.boundingBox())!;
  expect(Math.abs(pb.width / pb.height - 266 / 500)).toBeLessThan(0.03);
  await dlg.getByLabel("BOX画像を選択").setInputFiles({ name: "x_b2.png", mimeType: "image/png", buffer: makePng(425, 500, [60, 200, 60]) });
  await expect(dlg.getByTestId("image-slot-box")).toContainText("手動で登録");
  // 画像以外・大きすぎるファイルは拒否される
  await dlg.getByLabel("単品・セット画像を選択").setInputFiles({ name: "x.png", mimeType: "image/png", buffer: Buffer.from("not an image") });
  await expect(dlg.getByRole("alert")).toContainText("PNG・JPEG・WebP");
  await page.keyboard.press("Escape");

  // 一覧のサムネイルと抽選カードに表示され、再読込後も保持される
  await page.reload();
  await page.getByRole("tab", { name: "商品", exact: true }).click();
  await expect(page.getByTestId("master-row").filter({ hasText: "E2E画像商品" }).getByRole("img", { name: /E2E画像商品 BOX/ })).toBeVisible();
  await page.goto("/lotteries");
  await page.getByRole("tab", { name: /全情報/ }).click();
  await expect(page.getByTestId("lottery-card").filter({ hasText: "E2E画像商品" }).getByRole("img", { name: /E2E画像商品 BOX/ })).toBeVisible();
  await page.screenshot({ path: "docs/screenshots/stage4a-card-mobile.png" });

  // 商品情報の編集（定価・入数）。仮登録は確定扱いになる。単品の入数は未設定のまま
  await page.goto("/settings/masters");
  await page.getByRole("tab", { name: "商品", exact: true }).click();
  const r2 = page.getByTestId("master-row").filter({ hasText: "E2E画像商品" });
  await expect(r2.getByTestId("provisional-badge")).toBeVisible();
  await r2.getByRole("button", { name: "編集" }).click();
  await page.getByLabel(/商品コード（任意/).fill("E2E-IMG");
  await page.getByLabel(/BOX定価/).fill("5400");
  await page.getByRole("button", { name: "保存" }).click();
  await expect(r2.getByTestId("provisional-badge")).toHaveCount(0);
  await expect(r2).toContainText("E2E-IMG");
});

test("通知設定の画面: 端末の状態とプロフィール別の通知ルール", async ({ page }) => {
  await login(page);
  await page.goto("/settings/notifications");
  await expect(page.getByText("この端末", { exact: true })).toBeVisible();
  await expect(page.getByRole("group", { name: /通知ルール/ })).toBeVisible();
  // 日付のみの期限の扱いを設定できる（時刻を仮定しない）
  await page.getByLabel("時刻が不明（日付のみ）の期限").selectOption("none");
  await page.getByRole("button", { name: "通知ルールを保存" }).click();
  await expect(page.getByRole("status")).toContainText("通知設定を保存しました");
  await page.reload();
  await expect(page.getByLabel("時刻が不明（日付のみ）の期限")).toHaveValue("none");
});

test("AIで読み取る: 文章→確認→フォーム入力→保存（未設定の環境では案内を表示し、手動登録は使える）", async ({ page }) => {
  // 本番URL（E2E_BASE_URL）ではAPIキーが設定済みで、実際のAIが呼ばれて費用が発生するため実行しない。
  // 実AIの検証は e2e/ai-live.spec.ts（docs/ai-live-verification.md）。ここはモックエンジンまたは未設定の環境（ローカル・CI）での画面の確認。
  test.skip(!!process.env.E2E_BASE_URL, "本番では実AIの検証（ai-live）で確認する。費用を発生させない");
  await login(page);
  await page.getByRole("button", { name: "＋登録" }).click();
  const dialog = page.getByRole("dialog").first();
  await dialog.getByTestId("ai-open").click();
  const ai = page.getByRole("dialog").filter({ hasText: "AIで読み取る" }).last();
  // 4つの入力方法
  await expect(ai.getByRole("tab")).toHaveCount(4);
  await ai.getByRole("tab", { name: "文章" }).click();
  await ai.getByLabel("告知の文章を貼り付け").fill("【複数商品】抽選販売のお知らせ。サンプル電機 三宮店。応募は1月20日まで。");
  await ai.getByRole("button", { name: "読み取る" }).click();

  const result = ai.getByTestId("ai-result");
  const fail = ai.getByTestId("ai-fail");
  await expect(result.or(fail)).toBeVisible({ timeout: 20000 });
  if (await fail.isVisible()) {
    // AI APIが未設定の環境（本番など）: 壊れずに案内し、手動登録に戻れる
    await expect(fail).toContainText("設定されていません");
    await ai.getByRole("button", { name: "閉じる", exact: true }).click();
    await fillMasters(dialog, "E2E電機", "E2E店", "E2Eテスト商品");
    await expect(dialog.getByRole("button", { name: "保存" })).toBeEnabled();
    return;
  }

  // モックエンジン: 実際のAI解析ではないことが明示される
  await expect(ai.getByTestId("ai-mock-banner")).toContainText("モック");
  // 項目別の一覧。読み取れなかった項目は「—」。長い警告文は常時出さず、要確認は印と件数だけ
  await expect(result.getByTestId("ai-result-list")).toContainText("読み取り結果です。保存前に内容を確認してください。");
  await expect(result.getByTestId("ai-row").first()).toBeVisible();
  await expect(result).toContainText("複数商品の応募方式は、フォームで選んでください");
  await page.screenshot({ path: "docs/screenshots/stage4b-ai-result-mobile.png" });
  await ai.getByRole("button", { name: "フォームに入力" }).click();

  // フォーム: 候補として入力され、要確認が表示される。方式が未確定のままでは保存できない
  await expect(dialog.getByTestId("ai-filled-note")).toBeVisible();
  await expect(dialog.getByTestId("ai-flag").first()).toContainText(/要確認|仮登録/);
  // 印をタップすると理由が展開される（常時の長い警告文は出さない）
  await expect(dialog.getByTestId("ai-flag-detail")).toHaveCount(0);
  await dialog.getByTestId("ai-flag").first().click();
  await expect(dialog.getByTestId("ai-flag-detail")).toBeVisible();
  await openFormDetails(dialog);
  await expect(dialog.getByLabel("抽選の方式", { exact: true })).toHaveValue("");
  await expect(dialog.getByRole("combobox", { name: "商品2", exact: true })).toHaveValue("サンプル拡張パック「ほしぞら」");
  await dialog.getByRole("button", { name: "保存" }).click();
  await expect(dialog.getByRole("alert").filter({ hasText: "応募方式" })).toBeVisible();
  await page.screenshot({ path: "docs/screenshots/stage4b-ai-form-mobile.png" });

  // 方式を選べば保存でき、通常のカードとして表示される（未登録のマスターは仮登録）
  await dialog.getByLabel("抽選の方式", { exact: true }).selectOption({ label: "C. 複数商品が対象（当選はいずれか1商品まで）" });
  await dialog.getByLabel("応募締切の日付").fill("2027-01-20");
  await dialog.getByLabel("応募締切の時刻").fill("23:59");
  await dialog.getByRole("button", { name: "保存" }).click();
  await expect(dialog).toHaveCount(0);
  const card = page.getByTestId("lottery-card").filter({ hasText: "テスト拡張パック「ひかりの森」" });
  await expect(card).toHaveCount(1);

  // 同じ内容を再度読み取ると、登録済みとして重複の注意が出る（二重登録の防止）
  await page.getByRole("button", { name: "＋登録" }).click();
  const d2 = page.getByRole("dialog").first();
  await d2.getByTestId("ai-open").click();
  const ai2 = page.getByRole("dialog").filter({ hasText: "AIで読み取る" }).last();
  await ai2.getByLabel("告知の文章を貼り付け").fill("【複数商品】抽選販売のお知らせ。サンプル電機 三宮店。応募は1月20日まで。");
  await ai2.getByRole("button", { name: "読み取る" }).click();
  await expect(ai2.getByTestId("ai-duplicates")).toBeVisible({ timeout: 20000 });
  await ai2.getByRole("button", { name: "フォームに入力" }).click();
  await expect(d2.getByTestId("dup-warning")).toContainText("重複");
  await openFormDetails(d2);
  await d2.getByLabel("抽選の方式", { exact: true }).selectOption({ label: "C. 複数商品が対象（当選はいずれか1商品まで）" });
  await d2.getByRole("button", { name: "保存" }).click();
  await expect(d2.getByTestId("dup-warning")).toBeVisible();
  await expect(d2.getByText("「重複ではないことを確認した」にチェックしてください")).toBeVisible();
});

test("商品マスター: 検索・絞り込み、セット構成の登録、画像の表示調整（倍率・位置）", async ({ page }) => {
  await login(page);
  // 抽選登録の自動仮登録で2商品を用意（セット商品と構成商品）
  await page.getByRole("button", { name: "＋登録" }).click();
  const dialog = page.getByRole("dialog");
  await fillMasters(dialog, "E2Eセット電機", "E2Eセット店", "E2Eセット商品");
  await openFormDetails(dialog);
  await dialog.getByLabel("抽選の方式", { exact: true }).selectOption({ label: "B. 1回の応募で複数商品に参加（商品ごとに当落）" });
  await dialog.getByRole("combobox", { name: "商品2", exact: true }).fill("E2E構成商品");
  await dialog.getByRole("button", { name: "保存" }).click();
  await expect(dialog).toHaveCount(0);

  await page.goto("/settings/masters");
  await page.getByRole("tab", { name: "商品", exact: true }).click();
  // 検索（名称・コード・略称）で絞り込める
  await page.getByRole("searchbox", { name: "商品を検索" }).fill("ｅ2ｅ構成");
  await expect(page.getByTestId("master-row")).toHaveCount(1);
  await expect(page.getByTestId("product-count")).toContainText("1件");
  await page.getByRole("searchbox", { name: "商品を検索" }).fill("");

  // セット構成: 構成商品を追加して保存→開き直しても保持。未登録のうちは空
  const setRow = page.getByTestId("master-row").filter({ hasText: "E2Eセット商品" });
  await setRow.getByRole("button", { name: /セット構成を管理/ }).click();
  const dlg = page.getByRole("dialog");
  await expect(dlg).toContainText("構成は未登録です");
  await dlg.getByLabel("構成に追加する商品").selectOption({ label: "E2E構成商品" });
  await dlg.getByRole("button", { name: "追加" }).click();
  await dlg.getByLabel("E2E構成商品の数量").fill("3");
  await dlg.getByRole("button", { name: "保存" }).click();
  await expect(dlg).toHaveCount(0);
  await expect(setRow.getByRole("button", { name: /セット構成を管理/ })).toContainText("(1)");
  await setRow.getByRole("button", { name: /セット構成を管理/ }).click();
  await expect(page.getByTestId("set-component")).toContainText("E2E構成商品");
  await expect(page.getByLabel("E2E構成商品の数量")).toHaveValue("3");
  // 自分自身は構成に追加できない（候補に出ない）
  await expect(page.getByLabel("構成に追加する商品").locator("option", { hasText: "E2Eセット商品" })).toHaveCount(0);
  await page.keyboard.press("Escape");

  // 画像の表示調整: 画像を入れてから倍率・位置を保存でき、再読込後も保持される
  const compRow = page.getByTestId("master-row").filter({ hasText: "E2E構成商品" });
  await compRow.getByRole("button", { name: /の画像を管理/ }).click();
  const img = page.getByRole("dialog");
  await img.getByLabel("BOX画像を選択").setInputFiles({ name: "x_b.png", mimeType: "image/png", buffer: makePng(425, 500, [200, 60, 60]) });
  await expect(img.getByTestId("image-slot-box")).toContainText("手動で登録");
  const adjust = img.getByTestId("image-adjust");
  await adjust.getByLabel("倍率").fill("1.5");
  await adjust.getByLabel("横位置").fill("10");
  await adjust.getByRole("button", { name: "調整を保存" }).click();
  await expect(adjust.getByRole("status")).toContainText("保存しました");
  await page.reload();
  await page.getByRole("tab", { name: "商品", exact: true }).click();
  await page.getByTestId("master-row").filter({ hasText: "E2E構成商品" }).getByRole("button", { name: /の画像を管理/ }).click();
  await expect(page.getByTestId("image-adjust").getByLabel("倍率")).toHaveValue("1.5");
  await expect(page.getByTestId("image-adjust").getByLabel("横位置")).toHaveValue("10");
});

test("抽選フォーム: 日時は空欄=不明/日付のみ/0:00を区別、初期値は未確認の印、スワイプで最小化・再開、下書きは再読込で破棄、購入・受取の期間、リセット、他端末の更新を保存前に検出", async ({ page, context }) => {
  test.setTimeout(120_000); // 端末2台分の操作を含む長いシナリオ
  await login(page);
  await page.getByRole("button", { name: "＋登録" }).click();
  const form = page.getByTestId("lottery-form");
  await expect(form).toBeVisible();

  // 初期値（応募方法=Web・受取方法=店頭）は未確認の仮設定として印が付く
  await expect(form.getByLabel("応募方法", { exact: true })).toHaveValue("web");
  await expect(form.getByLabel("受取方法", { exact: true })).toHaveValue("store");
  await expect(form.getByTestId("tag-default")).toHaveCount(2);
  // 登録フォームは縦に長すぎない（スマホ1画面+αに収まる）。日時は2カラム
  const body = await form.locator("form > div").first().evaluate((e) => e.scrollHeight);
  const vp = page.viewportSize()!;
  expect(body).toBeLessThan(vp.height * 1.9);
  // 同じ行に2つ並ぶ（開く動きの途中で測らないよう、安定するまで再計測する）
  await expect
    .poll(async () => {
      const [dl, an] = [(await form.getByLabel("応募開始の日付").boundingBox())!, (await form.getByLabel("応募締切の日付").boundingBox())!];
      return Math.abs(dl.y - an.y);
    })
    .toBeLessThan(4);

  await fillMasters(form, "E2Eフォーム電機", "E2Eフォーム店", "E2Eフォーム商品");
  await form.getByLabel("応募締切の日付").fill("2026-02-01"); // 時刻なし = 日付のみ
  await expect(form).toContainText("時刻は未設定");
  await form.getByLabel("当選発表の日付").fill("2026-02-05");
  await form.getByLabel("当選発表の時刻").fill("00:00"); // 0:00 は「時刻あり」
  // 時刻だけで日付が空の項目は保存できない
  await form.getByLabel("購入・受取終了の時刻").fill("10:00");
  await form.getByRole("button", { name: "保存" }).click();
  await expect(form.getByRole("alert").filter({ hasText: "時刻だけでは登録できません" })).toBeVisible();
  await form.getByLabel("購入・受取終了の時刻").fill("");
  // 購入・受取の開始が終了より後ろなら保存できない
  await form.getByLabel("購入・受取開始の日付").fill("2026-02-20");
  await form.getByLabel("購入・受取終了の日付").fill("2026-02-10");
  await form.getByRole("button", { name: "保存" }).click();
  await expect(form.getByRole("alert").filter({ hasText: "購入・受取の開始が終了より後" })).toBeVisible();
  await form.getByLabel("購入・受取終了の日付").fill("2026-02-25");

  // 右上の閉じる・最小化ボタンは無い。上部のハンドルを下へスワイプすると最小化し、一覧を見ながら入力を保持できる
  await expect(form.getByRole("button", { name: /^最小化/ })).toHaveCount(0);
  await expect(form.getByRole("button", { name: "閉じる", exact: true })).toHaveCount(0);
  const hb = (await form.getByTestId("sheet-handle").boundingBox())!;
  await page.mouse.move(hb.x + hb.width / 2, hb.y + hb.height / 2);
  await page.mouse.down();
  await page.mouse.move(hb.x + hb.width / 2, hb.y + hb.height / 2 + 60, { steps: 5 });
  await page.mouse.move(hb.x + hb.width / 2, hb.y + hb.height / 2 + 160, { steps: 5 });
  await page.mouse.up();
  await expect(form).toHaveCount(0);
  const bar = page.getByTestId("form-minimized");
  await expect(bar).toContainText("E2Eフォーム電機 E2Eフォーム店");
  await page.getByRole("tab", { name: /全情報/ }).click(); // 最小化中も一覧を操作できる
  await bar.getByRole("button", { name: /を再開/ }).click(); // タップで再開（上スワイプでも再開できる）
  await expect(page.getByTestId("lottery-form").getByLabel("応募締切の日付")).toHaveValue("2026-02-01");
  await expect(page.getByTestId("lottery-form").getByLabel("購入・受取開始の日付")).toHaveValue("2026-02-20");

  // 長期の下書きは保存しない: 端末には残らず、再読込すると入力は破棄され、新規は初期状態
  expect(await page.evaluate(() => Object.keys(localStorage).filter((k) => k.startsWith("tcg.draft.")))).toEqual([]);
  await page.reload();
  await expect(page.getByTestId("draft-resume")).toHaveCount(0);
  await expect(page.getByTestId("form-minimized")).toHaveCount(0);
  await page.getByRole("button", { name: "＋登録" }).click();
  const form2 = page.getByTestId("lottery-form");
  await expect(form2.getByRole("combobox", { name: "店舗", exact: true })).toHaveValue("");
  await fillMasters(form2, "E2Eフォーム電機", "E2Eフォーム店", "E2Eフォーム商品");
  await form2.getByLabel("当選発表の時刻").fill("00:00"); // 日付なしの時刻は保存時に弾かれる（リセットの確認用に値を入れる）

  // リセット: 確認のうえ初期状態に戻る
  await form2.getByRole("button", { name: "入力をリセット" }).click();
  await expect(form2.getByTestId("form-confirm")).toBeVisible();
  await form2.getByRole("button", { name: "リセットする" }).click();
  await expect(form2.getByRole("combobox", { name: "店舗", exact: true })).toHaveValue("");
  await expect(form2.getByLabel("当選発表の時刻")).toHaveValue("");

  // 入力し直して保存 → 下書きは消え、日付のみ/0:00 が区別されて表示される。初期値のままの項目は「未確認」
  await fillMasters(form2, "E2Eフォーム電機", "E2Eフォーム店", "E2Eフォーム商品");
  await form2.getByLabel("応募締切の日付").fill("2026-02-01");
  await form2.getByLabel("当選発表の日付").fill("2026-02-05");
  await form2.getByLabel("当選発表の時刻").fill("00:00");
  await form2.getByLabel("購入・受取開始の日付").fill("2026-02-20");
  await form2.getByLabel("購入・受取終了の日付").fill("2026-02-25");
  await form2.getByLabel("受取方法", { exact: true }).selectOption("shipping"); // 選び直した項目は確認済み（印が外れる）
  await expect(form2.getByTestId("tag-default")).toHaveCount(1);
  await form2.getByRole("button", { name: "保存" }).click();
  await expect(page.getByTestId("lottery-form")).toHaveCount(0);

  await page.getByRole("tab", { name: /全情報/ }).click();
  const card = page.getByTestId("lottery-card").filter({ hasText: "E2Eフォーム店" });
  const sheet = await openDetail(page, card);
  await expect(sheet.getByRole("group", { name: "日時" }).or(sheet.getByLabel("日時"))).toContainText("2/1（時刻未確認）");
  await expect(sheet.getByLabel("日時")).toContainText("2/5 00:00");
  await expect(sheet.getByLabel("日時")).toContainText("購入・受取期間"); // 開始〜終了
  await expect(sheet.getByLabel("日時")).toContainText("2/20");
  await expect(sheet.getByLabel("方法")).toContainText("Web");
  await expect(sheet.getByLabel("方法").getByText("初期値・未確認")).toHaveCount(1); // 応募方法だけが未確認の初期値
  await closeSheet(page);

  // 編集: 別の端末（別タブ）で先に更新されると、保存の前に気づける
  const other = await context.newPage();
  await other.goto("/lotteries");
  await other.getByRole("tab", { name: /全情報/ }).click();
  await page.getByRole("tab", { name: /全情報/ }).click();
  const sheetA = await openDetail(page, page.getByTestId("lottery-card").filter({ hasText: "E2Eフォーム店" }));
  await sheetA.getByRole("button", { name: "編集" }).click();
  const edit = page.getByTestId("lottery-form");
  await expect(edit).toContainText("抽選を編集");
  await openFormDetails(edit);
  await edit.getByLabel("メモ").fill("端末Aで編集");
  // 端末B: 発表延期にして更新日時を進める
  const sheetB = await openDetail(other, other.getByTestId("lottery-card").filter({ hasText: "E2Eフォーム店" }));
  await sheetB.getByRole("button", { name: "発表延期にする" }).click();
  await expect(other.getByTestId("lottery-card").filter({ hasText: "E2Eフォーム店" })).toContainText("発表延期");
  // 端末A: 保存しようとすると競合を知らせる。最新を読み込むと自分の入力は破棄、上書きなら保存される
  await edit.getByRole("button", { name: "保存" }).click();
  const conflict = edit.getByRole("alert").filter({ hasText: "別の端末などで更新されました" });
  await expect(conflict).toBeVisible();
  await edit.getByRole("button", { name: "このまま上書き保存" }).click();
  await expect(page.getByTestId("lottery-form")).toHaveCount(0);
  await other.close();
  // 詳細パネルは開いたまま。保存した内容が反映されている
  await expect(sheetA).toContainText("端末Aで編集");
  await page.screenshot({ path: "docs/screenshots/stage45-detail-mobile.png" });
});

test("購入記録: 収支・抽選の購入と同じ記録。登録・編集・削除がどの画面からでも反映され、二重計上されない", async ({ page }) => {
  test.setTimeout(90_000);
  page.on("dialog", (d) => d.accept()); // 削除の確認
  await login(page);

  // 抽選で当選→購入済み → 購入記録に自動で入る（金額は未入力）
  await page.getByRole("button", { name: "＋登録" }).click();
  const form = page.getByTestId("lottery-form");
  await fillMasters(form, "E2E購入電機", "E2E購入店", "E2E購入商品");
  await form.getByLabel("Aの応募状況").selectOption("won");
  await form.getByRole("button", { name: "保存" }).click();
  await expect(form).toHaveCount(0);
  await page.getByRole("tab", { name: /当選/ }).click();
  const card = page.getByTestId("lottery-card").filter({ hasText: "E2E購入商品" });
  await card.getByRole("button", { name: "購入済み" }).click();
  await expect(card).toContainText("購入・受取済み");

  await page.getByRole("navigation", { name: "メイン" }).last().getByRole("link", { name: "購入記録" }).click();
  await expect(page).toHaveURL(/\/purchases$/);
  const rows = page.getByTestId("purchase-row").filter({ hasText: "E2E購入商品" });
  await expect(rows).toHaveCount(1); // 購入済みを何度押しても1件
  await expect(rows).toContainText("金額未入力");
  await expect(rows).toContainText("抽選当選");
  // この商品だけに絞る（同じ世帯の他のテストの購入が混ざらないように）。絞り込みは折りたたまれている
  await page.getByTestId("filter-toggle").click();
  await page.getByLabel("商品で絞り込み").selectOption({ label: "E2E購入商品" });
  await expect(page.getByTestId("purchase-count")).toHaveText("1件");
  await expect(page.getByTestId("purchase-amount")).toHaveText("0円"); // 未入力は0円の支出として数えない（件数は別）
  await expect(page.getByText(/金額が未入力の購入が1件/)).toBeVisible();

  // 購入記録から金額を編集 → 収支にも反映（同じ取引を参照）
  await rows.click();
  const dlg = page.getByRole("dialog");
  await dlg.getByLabel("購入金額1").fill("3000");
  await dlg.getByRole("button", { name: "保存" }).click();
  await expect(dlg).toHaveCount(0);
  await expect(rows).toContainText("3,000円");
  await expect(page.getByTestId("purchase-amount")).toHaveText("3,000円");

  // 購入記録から手動登録 → 一覧・商品別の累計・収支に反映
  await page.getByRole("button", { name: "＋購入を記録" }).click();
  const add = page.getByRole("dialog");
  await add.getByRole("combobox", { name: "商品1", exact: true }).fill("E2E購入商品");
  await add.getByLabel("数量1").fill("2");
  await add.getByLabel("単位1").selectOption("pack");
  await add.getByLabel("購入金額1").fill("800");
  await add.getByRole("button", { name: "保存" }).click();
  await expect(add).toHaveCount(0);
  await page.getByLabel("商品で絞り込み").selectOption({ label: "E2E購入商品" });
  await expect(page.getByTestId("purchase-count")).toHaveText("2件");
  await expect(page.getByTestId("purchase-amount")).toHaveText("3,800円");
  await page.getByRole("tab", { name: "商品別の累計" }).click();
  const total = page.getByTestId("product-total-row").filter({ hasText: "E2E購入商品" });
  await expect(total).toContainText("BOX×1");
  await expect(total).toContainText("パック×2");
  await expect(total).toContainText("入数未設定"); // 仮登録の商品は入数が不明なのでパック換算しない
  await expect(total).toContainText("3,800円"); // 金額は二重計上されない（BOX 3,000 + パック 800）
  await page.getByRole("tab", { name: "購入履歴" }).click();

  // 収支にも同じ2件（二重に増えない）
  await page.goto("/finance");
  await expect(page.getByTestId("ledger-row").filter({ hasText: "E2E購入商品" })).toHaveCount(2);
  const yen = (t: string) => Number(t.replace(/[^\d]/g, ""));
  const expenseBefore = yen(await page.getByTestId("sum-expense").innerText());

  // 収支から支出を登録 → 購入記録にも出る
  await page.getByRole("button", { name: "＋支出" }).click();
  const exp = page.getByRole("dialog");
  await exp.getByRole("combobox", { name: "商品1", exact: true }).fill("E2E収支起点商品");
  await exp.getByLabel("購入金額1").fill("1200");
  await exp.getByRole("button", { name: "保存" }).click();
  await expect(exp).toHaveCount(0);
  await expect(page.getByTestId("sum-expense")).toHaveText(`${(expenseBefore + 1200).toLocaleString("ja-JP")}円`);
  await page.goto("/purchases");
  await expect(page.getByTestId("purchase-row").filter({ hasText: "E2E収支起点商品" })).toContainText("1,200円");

  // 購入記録から削除 → 収支からも消える
  await page.getByTestId("purchase-row").filter({ hasText: "E2E収支起点商品" }).click();
  await page.getByRole("dialog").getByRole("button", { name: "削除" }).click();
  await expect(page.getByTestId("purchase-row").filter({ hasText: "E2E収支起点商品" })).toHaveCount(0);
  await page.goto("/finance");
  await expect(page.getByTestId("ledger-row").filter({ hasText: "E2E収支起点商品" })).toHaveCount(0);
  await expect(page.getByTestId("sum-expense")).toHaveText(`${expenseBefore.toLocaleString("ja-JP")}円`); // 元の合計に戻る（二重に残らない）
  await page.goto("/purchases");
  await expect(page.getByTestId("purchase-row").first()).toBeVisible();
  await page.screenshot({ path: "docs/screenshots/stage5a-purchases-mobile.png" });

  // 当選率: 上の当選1件が系列別に集計される（応募1・当選1・確定1 → 参考値）
  await page.goto("/records");
  const chain = page.getByTestId("win-by-chain").getByTestId("rate-row").filter({ hasText: "E2E購入電機" });
  await expect(chain).toContainText("100%");
  await expect(chain).toContainText("参考");
  await page.screenshot({ path: "docs/screenshots/stage5a-winrate-mobile.png", fullPage: true });
});

test("対戦記録: 登録→一覧・勝率→編集→削除。再読込でも保持され、収支・抽選とは独立", async ({ page }) => {
  test.setTimeout(90_000);
  page.on("dialog", (d) => d.accept());
  await login(page);
  await page.goto("/battles");
  await expect(page).toHaveURL(/\/battles$/);
  await expect(page.getByText("対戦記録はまだありません")).toBeVisible();

  const record = async (result: "勝ち" | "負け" | "引き分け", myDeck: string, oppDeck: string) => {
    await page.getByRole("button", { name: "＋対戦を記録" }).click();
    const f = page.getByTestId("battle-form");
    await f.getByRole("radio", { name: result }).click();
    await f.getByLabel("使用デッキ").fill(myDeck);
    await f.getByLabel("相手デッキ").fill(oppDeck);
    await f.getByLabel("対戦形式").fill("ジムバトル");
    await f.getByRole("button", { name: "保存" }).click();
    await expect(f).toHaveCount(0);
  };
  await record("勝ち", "E2Eデッキ", "相手デッキX");
  await record("負け", "E2Eデッキ", "相手デッキY");
  await expect(page.getByTestId("battle-row")).toHaveCount(2);
  await expect(page.getByTestId("battle-対戦")).toHaveText("2");
  await expect(page.getByTestId("battle-勝率")).toHaveText("50%");

  // 必須項目（勝敗）が無いと保存できない
  await page.getByRole("button", { name: "＋対戦を記録" }).click();
  await page.getByTestId("battle-form").getByRole("button", { name: "保存" }).click();
  await expect(page.getByTestId("battle-form").getByRole("alert")).toContainText("勝敗");
  await page.getByTestId("battle-form").getByRole("button", { name: "閉じる", exact: true }).click();

  // 編集: 負け → 勝ち に変更すると勝率が変わる
  await page.getByTestId("battle-row").filter({ hasText: "相手デッキY" }).click();
  await page.getByTestId("battle-form").getByRole("radio", { name: "勝ち" }).click();
  await page.getByTestId("battle-form").getByRole("button", { name: "保存" }).click();
  await expect(page.getByTestId("battle-勝率")).toHaveText("100%");

  // 再読込しても保持
  await page.reload();
  await expect(page.getByTestId("battle-row")).toHaveCount(2);
  await expect(page.getByTestId("battle-list")).toContainText("E2Eデッキ");
  await page.screenshot({ path: "docs/screenshots/stage5a-battles-mobile.png" });

  // 削除（非表示）→ 件数が減る
  await page.getByTestId("battle-row").first().click();
  await page.getByTestId("battle-form").getByRole("button", { name: "削除" }).click();
  await expect(page.getByTestId("battle-row")).toHaveCount(1);
  // 収支とは独立（支出・収入に影響しない）
  await page.goto("/finance");
  await expect(page.getByTestId("ledger-row").filter({ hasText: "E2Eデッキ" })).toHaveCount(0);
});

test("店舗の位置・交通費・直線距離・カード表示項目・AI料金管理（自宅の位置は通常表示しない）", async ({ page }) => {
  test.setTimeout(120_000);
  page.on("dialog", (d) => d.accept());
  await login(page);

  // 店舗マスターを用意（抽選登録の自動仮登録）
  await page.getByRole("button", { name: "＋登録" }).click();
  const form = page.getByTestId("lottery-form");
  await fillMasters(form, "E2E位置電機", "E2E位置店", "E2E位置商品");
  await form.getByRole("button", { name: "保存" }).click();
  await expect(form).toHaveCount(0);

  // 自宅の位置: 未設定 → 住所は普段は表示されない。手入力で設定（外部の住所検索は押さない限り使わない）
  await page.goto("/settings");
  await openAccordion(page, "acc-location");
  const home = page.getByTestId("home-location");
  await expect(home.getByTestId("home-status")).toContainText("未設定");
  await expect(home.getByRole("textbox")).toHaveCount(0); // 住所の入力欄（=住所の表示）は開くまで出ない
  await home.getByRole("button", { name: "住所を表示して変更" }).click();
  await home.getByLabel("自宅の住所").fill("E2E架空市1-2-3");
  await home.getByRole("button", { name: "緯度・経度を手入力" }).click();
  await home.getByLabel("緯度").fill("34.6948");
  await home.getByLabel("経度").fill("135.1955");
  await home.getByRole("button", { name: "保存", exact: true }).click();
  await expect(home.getByTestId("home-status")).toContainText("設定済み");
  await expect(page.getByTestId("travel-review")).toHaveCount(0); // 初回は見直し不要

  // 店舗: 住所・都道府県・位置・往復交通費を登録。緯度だけでは保存できない
  await page.goto("/settings/masters");
  await page.getByRole("tab", { name: "店舗", exact: true }).click();
  const row = page.getByTestId("master-row").filter({ hasText: "E2E位置店" });
  await expect(row.getByTestId("store-place")).toContainText("位置未設定");
  await row.getByRole("button", { name: "編集" }).click();
  const dlg = page.getByRole("dialog");
  await dlg.getByLabel(/都道府県/).fill("大阪府");
  await dlg.getByLabel(/店舗の住所/).fill("大阪府大阪市北区E2E");
  await dlg.getByLabel(/緯度/).fill("34.7025");
  await dlg.getByRole("button", { name: "保存" }).click();
  await expect(dlg.getByRole("alert")).toContainText("緯度と経度は両方");
  await dlg.getByLabel(/経度/).fill("135.4959");
  await dlg.getByLabel(/往復交通費/).fill("1280");
  await dlg.getByRole("button", { name: "保存" }).click();
  await expect(dlg).toHaveCount(0);
  await expect(row.getByTestId("store-place")).toContainText("往復交通費 1,280円");
  await expect(row.getByTestId("store-place")).toContainText(/自宅から直線 \d+km/);

  // 抽選カード: 受取方法が店頭なら都道府県ラベル（距離はカードに出さない）。交通費は既定では非表示
  await page.goto("/lotteries");
  await page.getByRole("tab", { name: /全情報/ }).click();
  const card = page.getByTestId("lottery-card").filter({ hasText: "E2E位置店" });
  await expect(card.getByTestId("card-place")).toContainText("大阪府");
  await expect(card.getByTestId("card-distance")).toHaveCount(0);
  await expect(card.getByTestId("card-place")).not.toContainText("¥1,280");
  await page.screenshot({ path: "docs/screenshots/stage5b-card-mobile.png" });

  // 表示項目の設定（ユーザーごと）: 受取場所を隠し、交通費を表示。再読込後も保持され、締切の警告などは常に表示
  await page.goto("/settings/display");
  const cf = page.getByTestId("card-fields");
  // 変更はサーバーに保存される。保存の完了を待ってから移動する
  const saved = () => page.waitForResponse((r) => r.request().method() === "POST" && r.url().includes("/settings/display"));
  await Promise.all([saved(), cf.getByLabel("受取場所（都道府県／通販）").uncheck()]);
  await Promise.all([saved(), cf.getByLabel("往復交通費").check()]);
  await page.goto("/lotteries");
  await page.getByRole("tab", { name: /全情報/ }).click();
  const card2 = page.getByTestId("lottery-card").filter({ hasText: "E2E位置店" });
  await expect(card2.getByTestId("card-place")).not.toContainText("大阪府");
  await expect(card2.getByTestId("card-place")).toContainText("¥1,280");
  await expect(card2.getByTestId("apply-status")).toBeVisible(); // ★・ユーザー別状態の操作は設定に関係なく表示

  // 距離の区分は後から変更できる（昇順4つの正の数）。不正な値は保存されない
  await page.goto("/settings");
  await openAccordion(page, "acc-location");
  const cd2 = page.getByTestId("distance-bands");
  await cd2.getByLabel("距離区分の上限2").fill("3");
  await cd2.getByRole("button", { name: "距離の区分を保存" }).click();
  await expect(cd2.getByRole("alert")).toContainText("小さい順");
  await cd2.getByLabel("距離区分の上限2").fill("20");
  await cd2.getByRole("button", { name: "距離の区分を保存" }).click();
  await expect(cd2.getByRole("status")).toContainText("保存しました");
  await page.reload();
  await openAccordion(page, "acc-location");
  await expect(page.getByTestId("distance-bands").getByLabel("距離区分の上限2")).toHaveValue("20");
  await page.goto("/settings/display");
  await expect(page.getByTestId("card-fields").getByLabel("受取場所（都道府県／通販）")).not.toBeChecked();

  // 自宅の位置を変えると、交通費の見直しを促す（自動計算はしない）
  await page.goto("/settings");
  await openAccordion(page, "acc-location");
  const home2 = page.getByTestId("home-location");
  await home2.getByRole("button", { name: "住所を表示して変更" }).click();
  await expect(home2.getByLabel("自宅の住所")).toHaveValue("E2E架空市1-2-3");
  await home2.getByRole("button", { name: "緯度・経度を手入力" }).click();
  await home2.getByLabel("緯度").fill("34.9");
  await home2.getByLabel("経度").fill("135.4");
  await home2.getByRole("button", { name: "保存", exact: true }).click();
  await expect(page.getByTestId("travel-review")).toContainText("往復交通費");
  await page.getByTestId("travel-review").getByRole("button", { name: "見直した" }).click();
  await expect(page.getByTestId("travel-review")).toHaveCount(0);
  // 位置情報の削除 → 距離は出なくなる
  await home2.getByRole("button", { name: "位置情報を削除" }).click();
  await expect(home2.getByTestId("home-status")).toContainText("未設定");
  await page.goto("/lotteries");
  await page.getByRole("tab", { name: /全情報/ }).click();
  await expect(page.getByTestId("lottery-card").filter({ hasText: "E2E位置店" }).getByTestId("card-distance")).toHaveCount(0); // カードに距離は出ない

  // AI利用状況・料金: 回数・推定料金・予算・警告。予算を超えたら警告と自動解析の停止を表示
  await page.goto("/settings");
  await openAccordion(page, "acc-ai");
  const ai = page.getByTestId("ai-usage");
  await expect(ai).toContainText("使用モデル");
  await expect(ai.getByTestId("ai-cost")).toHaveText(/円$/);
  await expect(ai).toContainText("推定額");
  await expect(ai).toContainText("Anthropic Console");
  await ai.getByLabel("AIの月間予算（円）").fill("0");
  await ai.getByRole("button", { name: "保存", exact: true }).click();
  await expect(ai.getByTestId("ai-budget-warning")).toContainText("停止");
  await ai.getByLabel("AIの月間予算（円）").fill("3000");
  await ai.getByRole("button", { name: "保存", exact: true }).click();
  await expect(ai.getByTestId("ai-budget-warning")).toHaveCount(0);
  await expect(ai).toContainText("1,000円 / 2,000円 / 2,500円");
  await page.screenshot({ path: "docs/screenshots/stage5b-settings-mobile.png", fullPage: true });
});

test("起動: ログイン後の起動でもロード画面のHTMLを先に返し、準備完了で通常画面へ。起動後の画面遷移では出ない", async ({ page }) => {
  await login(page);
  // 認証確認・世帯の準備を待たずに最初に返るHTMLにロード画面が含まれる（ストリーミング）
  const html = await (await page.context().request.get("/lotteries")).text();
  expect(html).toContain('data-testid="splash"');
  expect(html).toContain("読み込み中...");

  await page.reload();
  await expect(page.getByRole("heading", { name: "抽選管理" })).toBeVisible();
  await expect(page.getByTestId("splash")).toHaveCount(0);
  await page.evaluate(() => {
    (window as unknown as { __splashSeen: number }).__splashSeen = 0;
    new MutationObserver(() => {
      if (document.querySelector('[data-testid="splash"]')) (window as unknown as { __splashSeen: number }).__splashSeen++;
    }).observe(document.body, { childList: true, subtree: true });
  });
  const nav = page.getByRole("navigation", { name: "メイン" }).last();
  await nav.getByRole("link", { name: "購入記録" }).click();
  await expect(page).toHaveURL(/\/purchases$/);
  await page.getByTestId("header-settings").click();
  await expect(page).toHaveURL(/\/settings$/);
  await nav.getByRole("link", { name: "抽選管理" }).click();
  await expect(page.getByRole("heading", { name: "抽選管理" })).toBeVisible();
  expect(await page.evaluate(() => (window as unknown as { __splashSeen: number }).__splashSeen)).toBe(0);
  // 未ログインの状態は従来どおりログイン画面へ（認証の挙動は変わらない）
  await page.context().clearCookies();
  await page.goto("/lotteries");
  await expect(page).toHaveURL(/\/login$/);
});

test("Excel取り込み・出力: テンプレート→確認→適用→再取り込みは重複エラー→出力して更新→履歴。エラー一覧と店舗の系列エラーも確認できる", async ({ page }) => {
  const ExcelJS = (await import("exceljs")).default;
  const stamp = Date.now().toString(36);
  await login(page);
  await page.goto("/settings/masters");
  await page.getByTestId("link-master-import").click();
  await expect(page.getByRole("heading", { name: "Excel取り込み・出力" })).toBeVisible();

  // テンプレートのダウンロード（ログイン中のみ）
  const tpl = await page.context().request.get("/api/master-import?kind=products&type=template");
  expect(tpl.status()).toBe(200);
  expect(tpl.headers()["content-type"]).toContain("spreadsheetml");
  const tplBuf = Buffer.from(await tpl.body());
  const book = async (rows: string[][]) => {
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(tplBuf as unknown as ArrayBuffer);
    const ws = wb.getWorksheet("商品")!;
    rows.forEach((r, i) => r.forEach((v, c) => (ws.getCell(i + 2, c + 1).value = v === "" ? null : v)));
    return Buffer.from(await wb.xlsx.writeBuffer());
  };
  const upload = (name: string, buffer: Buffer) => page.getByTestId("import-file").setInputFiles({ name, mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", buffer });
  const nameA = `E2E取込商品A${stamp}`;
  const nameB = `E2E取込商品B${stamp}`;

  // 新規2件: 確認 → 適用
  await upload("new.xlsx", await book([["", "", "", nameA, `略称A${stamp}`, "", "2026-12-05", "", "30", "5400", "", ""], ["", "", "", nameB, "", "", "", "", "", "", "", ""]]));
  await expect(page.getByTestId("import-preview")).toBeVisible();
  await expect(page.getByTestId("count-new")).toHaveText("2");
  await expect(page.getByTestId("count-error")).toHaveText("0");
  await expect(page.getByTestId("import-rows")).toContainText("（自動採番）");
  await page.getByTestId("import-apply").click();
  await expect(page.getByTestId("import-done")).toContainText("新規 2件");
  await expect(page.getByTestId("import-done")).toContainText(/PR\d{6}/);

  // 同じファイルをもう一度: 同名の商品が既にあるためエラー。適用できず、エラー一覧をダウンロードできる
  await upload("new.xlsx", await book([["", "", "", nameA, "", "", "", "", "", "", "", ""]]));
  await expect(page.getByTestId("count-error")).toHaveText("1");
  await expect(page.getByTestId("import-rows")).toContainText("同じ名前の商品が既にあります");
  await expect(page.getByTestId("import-apply")).toBeDisabled();
  const [dl] = await Promise.all([page.waitForEvent("download"), page.getByRole("button", { name: "エラー一覧をダウンロード" }).click()]);
  expect(dl.suggestedFilename()).toContain("errors");

  // 出力 → 1件のメモを書き換えて取り込む（他の行は変更なし）
  const exp = await page.context().request.get("/api/master-import?kind=products&type=export");
  expect(exp.status()).toBe(200);
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(Buffer.from(await exp.body()) as unknown as ArrayBuffer);
  const ws = wb.getWorksheet("商品")!;
  let hit = 0;
  ws.eachRow((row, n) => {
    if (n > 1 && String(row.getCell(4).value) === nameB) {
      row.getCell(12).value = `更新メモ${stamp}`;
      hit++;
    }
  });
  expect(hit).toBe(1);
  await upload("export-edited.xlsx", Buffer.from(await wb.xlsx.writeBuffer()));
  await expect(page.getByTestId("count-update")).toHaveText("1");
  await expect(page.getByTestId("count-error")).toHaveText("0");
  await expect(page.getByTestId("import-rows")).toContainText(`更新メモ${stamp}`);
  await page.getByTestId("import-apply").click();
  await expect(page.getByTestId("import-done")).toContainText("更新 1件");

  // 履歴（ファイル名・件数）
  await page.reload();
  await expect(page.getByTestId("import-history")).toContainText("export-edited.xlsx");
  await expect(page.getByTestId("import-history")).toContainText("new.xlsx");

  // 店舗: 未登録の系列はエラー。商品用のファイルは拒否
  await page.getByRole("tab", { name: "店舗" }).click();
  const stpl = Buffer.from(await (await page.context().request.get("/api/master-import?kind=stores&type=template")).body());
  const swb = new ExcelJS.Workbook();
  await swb.xlsx.load(stpl as unknown as ArrayBuffer);
  swb.getWorksheet("店舗")!.getCell(2, 2).value = `存在しない系列${stamp}`;
  swb.getWorksheet("店舗")!.getCell(2, 3).value = "E2E店";
  await upload("stores.xlsx", Buffer.from(await swb.xlsx.writeBuffer()));
  await expect(page.getByTestId("import-rows")).toContainText("登録されていません");
  await expect(page.getByTestId("import-apply")).toBeDisabled();
  await upload("wrong-kind.xlsx", await book([["", "", "", "x", "", "", "", "", "", "", "", ""]]));
  await expect(page.getByTestId("import-error")).toContainText("商品用");

  // 未ログインでは取得できない
  await page.context().clearCookies();
  const anon = await page.context().request.get("/api/master-import?kind=products&type=export", { maxRedirects: 0 });
  expect([301, 302, 303, 307, 308, 401]).toContain(anon.status());
  expect(anon.headers()["content-type"] ?? "").not.toContain("spreadsheetml");
});

test("コレクション: 手入力・画像からAI登録・重複は所有記録の追加・一括登録・3/4/5列と一覧・お気に入りと並び替え・相場と差額・削除（購入記録は残る）", async ({ page }) => {
  test.skip(!!process.env.E2E_BASE_URL, "本番では実AIの検証で確認する。費用を発生させない");
  test.setTimeout(180_000);
  await login(page);
  await page.goto("/collection");
  await expect(page.getByTestId("collection-empty")).toBeVisible();

  // 手入力で登録（所持2枚・購入金額1枚15,000円）
  await page.getByTestId("add-card").click();
  const form = page.getByTestId("card-form");
  await form.getByLabel("カード名").fill("E2Eピカチュウex");
  await form.getByLabel("カード番号").fill("201/165");
  await form.getByLabel("商品コード").fill("e2e1");
  await form.getByLabel("レアリティ").fill("SAR");
  await form.getByLabel("所持枚数").fill("2");
  await form.getByLabel("購入金額").fill("15000");
  await form.getByTestId("card-save").click();
  await expect(form).toHaveCount(0);
  await expect(page.getByTestId("card-tile")).toHaveCount(1);
  await expect(page.getByTestId("tile-qty")).toHaveText("×2");
  await expect(page.getByTestId("collection-summary")).toContainText("1種・2枚");
  await expect(page.getByTestId("collection-summary")).toContainText("30,000円");

  // 同じカード（商品コード・番号・レアリティ）は新規にせず、所有記録を追加（1枚・18,000円）
  await page.getByTestId("add-card").click();
  const f2 = page.getByTestId("card-form");
  await f2.getByLabel("カード名").fill("E2Eピカチュウex");
  await f2.getByLabel("カード番号").fill("201/165");
  await f2.getByLabel("商品コード").fill("E2E1");
  await f2.getByLabel("レアリティ").fill("sar");
  await expect(f2.getByTestId("card-match")).toContainText("所有記録を追加");
  await f2.getByLabel("購入金額").fill("18000");
  await f2.getByTestId("card-save").click();
  await expect(f2).toHaveCount(0);
  await expect(page.getByTestId("card-tile")).toHaveCount(1); // 新しいカードにはならない
  await expect(page.getByTestId("tile-qty")).toHaveText("×3");

  // 画像1枚: AI（モック）が読み取って入力する。読み取れた項目だけ入り、保存すると画像つきのカードになる
  await page.getByTestId("add-card").click();
  const f3 = page.getByTestId("card-form");
  await expect(f3.getByTestId("card-ai-toggle")).toBeChecked(); // 画像があるときAI読み取りは既定でON
  await f3.getByTestId("card-file").setInputFiles({ name: "c1.png", mimeType: "image/png", buffer: makePng(60, 84, [200, 120, 40]) });
  await expect(f3.getByLabel("カード名")).toHaveValue(/テスト/, { timeout: 20000 });
  await expect(f3.getByTestId("card-preview").locator("img")).toBeVisible();
  await expect(f3.getByText("外部サイトとの照合は行っていません")).toBeVisible(); // 実際にWeb照合していないことを明示
  await f3.getByLabel("カード名").fill("E2E画像カード");
  await f3.getByLabel("カード番号").fill("9/9");
  await f3.getByLabel("商品コード").fill("e2e9");
  await f3.getByLabel("レアリティ").fill("SR");
  await f3.getByTestId("card-save").click();
  await expect(f3).toHaveCount(0);
  await expect(page.getByTestId("card-tile")).toHaveCount(2);
  const imgTile = page.getByTestId("card-tile").filter({ has: page.getByRole("img", { name: "E2E画像カード" }) });
  await expect(imgTile).toHaveCount(1); // サムネイル画像が表示される

  // 複数画像: 画像1枚＝カード1種類として一括登録。同じ画像は重複の候補（既定で除外）
  const png = (c: number) => ({ name: `b${c}.png`, mimeType: "image/png", buffer: makePng(50 + c * 7, 70, [c * 40, 90, 160]) });
  await page.getByTestId("add-card").click();
  await page.getByTestId("card-form").getByTestId("card-file").setInputFiles([png(1), png(2), png(1)]);
  const bulk = page.getByTestId("card-bulk");
  await expect(bulk.getByTestId("bulk-item")).toHaveCount(3);
  await expect(bulk.locator('[data-testid="bulk-item"][data-status="done"]')).toHaveCount(3, { timeout: 30000 });
  await expect(bulk).toContainText("重複の可能性");
  const saveBtn = bulk.getByTestId("bulk-save");
  await expect(saveBtn).toContainText("2件を登録"); // 重複の1件は既定で除外
  // 1件ずつ修正できる（名前を直す）
  await bulk.getByTestId("bulk-item").first().getByRole("button").first().click();
  await bulk.getByLabel("画像1のカード名").fill("E2E一括A");
  await bulk.getByLabel("画像1のカード番号").fill("11/11");
  await bulk.getByTestId("bulk-item").nth(1).getByRole("button").first().click();
  await bulk.getByLabel("画像2のカード名").fill("E2E一括B");
  await bulk.getByLabel("画像2のカード番号").fill("12/12");
  await saveBtn.click();
  await expect(bulk.getByTestId("bulk-summary")).toContainText("2件を登録しました");
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("card-tile")).toHaveCount(4);

  // 表示: 既定4列。3/5列とテキスト一覧に切り替えられ、再読込後も保持（プロフィール別）
  await expect(page.getByTestId("card-grid")).toHaveAttribute("data-cols", "4");
  await page.getByTestId("cols").click(); // 4→5→3 と切り替わる
  await expect(page.getByTestId("card-grid")).toHaveAttribute("data-cols", "5");
  await page.getByTestId("cols").click();
  await expect(page.getByTestId("card-grid")).toHaveAttribute("data-cols", "3");
  await page.getByTestId("more-menu").click();
  await page.getByTestId("view-toggle").click();
  await expect(page.getByTestId("card-row")).toHaveCount(4);
  await page.waitForTimeout(800);
  await page.reload();
  await expect(page.getByTestId("card-row")).toHaveCount(4);
  await page.getByTestId("more-menu").click();
  await page.getByTestId("view-toggle").click();
  await page.getByTestId("cols").click(); // 3→4

  // 検索・お気に入り・並び替え
  await page.getByTestId("search-toggle").click();
  await page.getByLabel("コレクションを検索").fill("一括");
  await expect(page.getByTestId("card-tile")).toHaveCount(2);
  await page.getByLabel("コレクションを検索").fill("");
  await page.getByTestId("card-tile").filter({ has: page.getByRole("img", { name: "E2E画像カード" }) }).getByTestId("tile-fav").click();
  await page.getByTestId("card-tile").filter({ hasText: "×3" }).getByTestId("tile-fav").click();
  await page.getByTestId("fav-filter").click();
  await expect(page.getByTestId("card-tile")).toHaveCount(2);
  await page.getByTestId("more-menu").click();
  await page.getByTestId("reorder-toggle").click();
  const order = page.getByTestId("reorder-list").locator("li");
  const first = await order.first().innerText();
  await order.nth(1).getByRole("button", { name: /を上へ/ }).click();
  await expect.poll(async () => (await order.first().innerText()) !== first).toBe(true);
  await page.getByTestId("more-menu").click();
  await page.getByTestId("reorder-toggle").click();
  await page.getByTestId("fav-filter").click();

  // 詳細: 参考相場の登録と購入額との差額（3枚の購入額 15,000×2＋18,000＝48,000円）
  await page.getByTestId("card-tile").filter({ hasText: "×3" }).getByRole("button", { name: /の詳細を開く/ }).click();
  const detail = page.getByTestId("card-detail");
  await expect(detail.getByTestId("holdings").locator("li")).toHaveCount(2);
  await expect(detail.getByTestId("diff-sale")).toHaveText("—"); // 相場が未設定の間は差額を出さない（0円にしない）
  await detail.getByLabel("相場の価格").fill("20000");
  await detail.getByLabel("相場の情報源").fill("E2E店");
  await detail.getByTestId("price-add").click();
  await expect(detail.getByTestId("detail-msg")).toContainText("登録しました");
  await expect(detail.getByTestId("price-history")).toContainText("販売 20,000円");
  await expect(detail.getByTestId("diff-sale")).toHaveText("+12,000円"); // 20,000×3 − 48,000
  await expect(detail.getByTestId("diff-buyback")).toHaveText("—"); // 買取相場は未設定

  // 削除: 取得記録1件／カード全体を確認ダイアログのあとで。購入記録・収支には触れない
  await detail.getByTestId("holdings").locator("li").first().getByRole("button", { name: "この記録を削除" }).click();
  await expect(page.getByTestId("card-confirm")).toContainText("購入記録・収支の履歴は削除されません");
  await page.getByTestId("confirm-ok").click();
  await expect(detail.getByTestId("holdings").locator("li")).toHaveCount(1);
  await detail.getByTestId("card-delete").click();
  await page.getByTestId("confirm-ok").click();
  await expect(detail).toHaveCount(0);
  await expect(page.getByTestId("card-tile")).toHaveCount(3);

  // 下部メニュー: コレクションは直接開ける（隠れる機能が1つだけなので「その他」は出ない）
  await page.goto("/lotteries");
  await page.getByTestId("bottom-nav").getByRole("link", { name: "コレクション" }).click();
  await expect(page).toHaveURL(/\/collection$/);
});

test("まとめてAI読み取り: 文章・画像（A=1件に複数枚/B=1枚ずつ）・ジョブの状態の保持・完了通知・確認して保存・一括保存・重複（AIはモック）", async ({ page }) => {
  test.skip(!!process.env.E2E_BASE_URL, "本番では実AIの検証で確認する。費用を発生させない");
  test.setTimeout(180_000);
  await login(page);
  await page.goto("/lotteries/bulk");
  const bulk = page.getByTestId("bulk-ai");
  await expect(bulk).toBeVisible();

  // 入力欄は初期5行（1行＝1件の抽選）。文章は「文章で入力」、画像は1行に複数枚（1件にまとめる）、URLと画像は同じ行で両立しない
  await expect(bulk.getByTestId("bulk-row")).toHaveCount(5);
  const t = (n: number) => `【抽選販売のお知らせ${n}】サンプル電機 三宮店。応募は1月20日23:59まで。`;
  for (const n of [1, 2]) {
    await bulk.getByRole("button", { name: `${n}件目を文章で入力` }).click();
    await bulk.getByLabel(`${n}件目の文章`).fill(t(n));
  }
  const png = (c: number) => ({ name: `j${c}.png`, mimeType: "image/png", buffer: makePng(44 + c * 5, 66, [c * 30, 100, 150]) });
  await bulk.getByLabel("3件目の画像を選択").setInputFiles([png(1), png(2)]); // 2枚で1件
  await expect(bulk.getByLabel("3件目のURL")).toHaveAttribute("placeholder", "画像2枚");
  await bulk.getByLabel("4件目の画像を選択").setInputFiles(png(3));
  await bulk.getByLabel("5件目の画像を選択").setInputFiles(png(4));
  // 入力欄を追加できる。未入力の行は解析されない
  await bulk.getByTestId("row-add").click();
  await expect(bulk.getByTestId("bulk-row")).toHaveCount(6);
  await bulk.getByLabel("6件目のURL").fill("https://example.invalid/a");
  await expect(bulk.getByRole("button", { name: "6件目に画像を登録" })).toBeDisabled(); // URL入力中は画像不可
  await bulk.getByRole("button", { name: "6件目をリセット" }).click();
  await expect(bulk.getByLabel("6件目のURL")).toHaveValue("");

  await bulk.getByTestId("bulk-start").click();
  await expect(page).toHaveURL(/\/lotteries\/bulk\?job=/);
  const detail = page.getByTestId("job-detail");
  await expect(detail.getByTestId("job-item")).toHaveCount(5);

  // 解析は裏で進む: 他の画面へ移動しても続き、完了すると小さな通知が出る（タップで結果へ）
  await page.goto("/purchases");
  const toast = page.getByTestId("ai-job-toast");
  await expect(toast).toBeVisible({ timeout: 60000 });
  await expect(toast).toContainText("AI読み取りが完了しました");
  await page.goto("/lotteries");
  await expect(page.getByTestId("bulk-badge")).toBeVisible(); // 未確認の結果がある（再読み込み後も）
  await page.getByTestId("register").click();
  await page.getByTestId("lottery-form").getByTestId("bulk-open").click();
  await expect(page).toHaveURL(/\/lotteries\/bulk$/);
  await page.getByTestId("job-row").first().click();
  const d2 = page.getByTestId("job-detail");
  await expect(d2.locator('[data-testid="job-item"][data-status="done"]')).toHaveCount(5, { timeout: 30000 });
  await expect(d2.getByTestId("job-status")).toContainText("確認待ち");
  // 確認画面を開いたので、未確認のバッジは消える
  await page.goto("/lotteries");
  await expect(page.getByTestId("bulk-badge")).toHaveCount(0);
  await page.goto("/lotteries/bulk");
  await page.getByTestId("job-row").first().click();

  // 1件ずつ確認・修正して保存（解析結果がフォームに入力される。まだ登録されていない）
  const d3 = page.getByTestId("job-detail");
  await expect(d3.getByTestId("job-item").first()).toContainText("サンプル電機");
  await d3.getByTestId("job-item").first().getByTestId("item-open").click();
  const form = page.getByTestId("lottery-form");
  await expect(form.getByRole("combobox", { name: "系列", exact: true })).toHaveValue("サンプル電機");
  await form.getByLabel("応募締切の日付").fill("2027-01-20");
  // 同じ内容の抽選が既にある場合（他のテストの登録）は、重複ではないことの確認が必要
  if (await form.getByLabel("重複ではないことを確認した").count()) await form.getByLabel("重複ではないことを確認した").check();
  await form.getByRole("button", { name: "保存" }).click();
  await expect(form).toHaveCount(0);
  await expect(d3.locator('[data-testid="job-item"][data-status="saved"]')).toHaveCount(1, { timeout: 15000 });

  // 1件を除外し、残りを選択してまとめて保存（重複の可能性が高いものは個別確認になる）
  await d3.locator('[data-testid="job-item"][data-status="done"]').first().getByTestId("item-skip").click();
  await expect(d3.locator('[data-testid="job-item"][data-status="skipped"]')).toHaveCount(1);
  await d3.getByRole("button", { name: "すべて選択" }).click();
  await d3.getByTestId("bulk-save-selected").click();
  await expect(d3.getByTestId("save-report")).toBeVisible({ timeout: 30000 });
  // 先に保存した抽選と同じ（同じ店舗・商品・締切）ものは、重複の可能性が高いので自動では保存せず、個別の確認になる
  await expect(d3.getByTestId("save-report")).toContainText("重複の可能性が高い");
  const savedCount = await d3.locator('[data-testid="job-item"][data-status="saved"]').count();
  expect(savedCount).toBeGreaterThanOrEqual(1);
  await expect(d3.locator('[data-testid="job-item"][data-status="done"] [data-testid="item-open"]')).toHaveCount(5 - savedCount - 1);

  // 再読み込みしても状態・結果が残る
  await page.reload();
  await expect(page.getByTestId("job-detail").locator('[data-testid="job-item"][data-status="saved"]')).toHaveCount(savedCount);
});

/** 幅w×高さhの単色PNG。縦長画像用に、1行ずつ複製して高速に作る */
function makeTallPng(w: number, h: number): Buffer {
  const row = Buffer.alloc(w * 3 + 1, 235);
  row[0] = 0;
  const raw = Buffer.alloc(row.length * h);
  for (let y = 0; y < h; y++) row.copy(raw, y * row.length);
  const chunk = (type: string, data: Buffer) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body));
    return Buffer.concat([len, body, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr.set([8, 2, 0, 0, 0], 8);
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}

test("縦長画像(786×10,810px): ブラウザで幅を保って11枚に分割し、1件の抽選として解析する（単体のAI読み取り・まとめて登録の両方。AIはモック）", async ({ page }) => {
  test.skip(!!process.env.E2E_BASE_URL, "本番では実AIの検証で確認する。費用を発生させない");
  test.setTimeout(150_000);
  await login(page);
  const tall = { name: "long.png", mimeType: "image/png", buffer: makeTallPng(786, 10810) };

  // 単体: 送信される画像は11枚（長辺を縮小して幅116pxになる従来方式ではない）
  await page.getByRole("button", { name: "＋登録" }).click();
  await page.getByRole("dialog").first().getByTestId("ai-open").click();
  const ai = page.getByRole("dialog").filter({ hasText: "AIで読み取る" }).last();
  await ai.getByRole("tab", { name: "画像" }).click();
  await ai.getByLabel("告知画像を選択").setInputFiles(tall);
  // 送信される画像を記録する（fetchのFormDataを見る）
  await page.evaluate(() => {
    const w = window as unknown as { __sent: string[]; fetch: typeof fetch };
    w.__sent = [];
    const orig = w.fetch.bind(window);
    w.fetch = (input, init) => {
      if (String(input).includes("/api/lottery-extract") && init?.body instanceof FormData) w.__sent = init.body.getAll("images").map((f) => (f as File).name + ":" + (f as File).size);
      return orig(input, init);
    };
  });
  await ai.getByRole("button", { name: "読み取る" }).click();
  await expect.poll(() => page.evaluate(() => (window as unknown as { __sent: string[] }).__sent.length)).toBe(11);
  const sent = await page.evaluate(() => (window as unknown as { __sent: string[] }).__sent);
  expect(sent.map((x) => x.split(":")[0])).toEqual(Array.from({ length: 11 }, (_, i) => `part-${String(i + 1).padStart(2, "0")}.jpg`)); // 上から順の番号つき
  expect(Math.max(...sent.map((x) => Number(x.split(":")[1])))).toBeLessThan(400_000); // 1枚ずつは小さい（合計4MBの上限に収まる）
  // 分割の案内は解析中だけ表示される（モックのAIは即答するため、見えるのは一瞬）。結果が出ていれば案内は役目を終えている
  const notes = ai.getByTestId("prep-notes");
  if (await notes.count()) await expect(notes).toContainText("11枚に分割");
  await expect(ai.getByTestId("ai-result").or(ai.getByTestId("ai-fail"))).toBeVisible({ timeout: 30000 });
  await page.keyboard.press("Escape");
  await page.keyboard.press("Escape");

  // まとめて登録: 1行に縦長1枚 → 11枚で1件。ジョブは1件として解析される
  await page.goto("/lotteries/bulk");
  const bulk = page.getByTestId("bulk-ai");
  await bulk.getByLabel("1件目の画像を選択").setInputFiles(tall);
  await expect(bulk.getByTestId("prep-notes")).toContainText("1件目: 縦長の画像（786×10810px）を11枚に分割");
  await expect(bulk.getByTestId("bulk-row").first().getByTestId("row-image")).toContainText("11");
  await bulk.getByTestId("bulk-start").click();
  await expect(page).toHaveURL(/\/lotteries\/bulk\?job=/);
  const detail = page.getByTestId("job-detail");
  await expect(detail.getByTestId("job-item")).toHaveCount(1);
  await expect(detail.locator('[data-testid="job-item"][data-status="done"], [data-testid="job-item"][data-status="failed"]')).toHaveCount(1, { timeout: 60000 });
});

test("iPhone共有: 未ログインで共有を開くとログイン後に共有へ戻り、X投稿のURLを確認して解析（確認待ち）に渡せる。設定に手順がある", async ({ page }) => {
  test.skip(!!process.env.E2E_BASE_URL, "本番では実AIの検証で確認する。費用を発生させない");
  test.setTimeout(90_000);
  const shared = "https://twitter.com/e2e_shop/status/1234567890123456?s=20&t=abc";
  // 未ログイン: ログインへ。共有の行き先は引き継がれる
  await page.goto(`/share?url=${encodeURIComponent(shared)}`);
  await expect(page).toHaveURL(/\/login\?next=%2Fshare/);
  await page.getByLabel("メールアドレス").fill(email);
  await page.getByLabel("パスワード").fill(password);
  await page.getByRole("button", { name: "ログイン" }).click();
  // ログイン後は共有へ戻る。URLは標準の形にそろう（追跡用のクエリは捨てる）
  await expect(page).toHaveURL(/\/share\?url=/);
  await expect(page.getByTestId("share-url")).toHaveText("https://x.com/e2e_shop/status/1234567890123456");
  // 開いただけでは解析を始めない（ジョブは増えていない）
  const before = await page.evaluate(async () => ((await (await fetch("/api/ai-jobs")).json()) as { jobs: unknown[] }).jobs.length);
  await page.getByTestId("share-start").click();
  await expect(page).toHaveURL(/\/lotteries\/bulk\?job=/);
  await expect(page.getByTestId("job-detail").getByTestId("job-item")).toHaveCount(1);
  const after = await page.evaluate(async () => ((await (await fetch("/api/ai-jobs")).json()) as { jobs: unknown[] }).jobs.length);
  expect(after).toBe(before + 1);

  // 不正なURL・X以外は理由を表示し、解析は始められない
  await page.goto(`/share?url=${encodeURIComponent("https://example.com/a/status/1234567890")}`);
  await expect(page.getByTestId("share-invalid")).toContainText("投稿のURLではありません");
  await expect(page.getByTestId("share-start")).toHaveCount(0);

  // 設定: ショートカットの手順と、開くURLの前半（このアプリのアドレス）
  await page.goto("/settings");
  await page.getByTestId("acc-share").getByRole("button", { name: /iPhoneの共有から登録/ }).click();
  await expect(page.getByTestId("share-prefix")).toHaveText(/^http.*\/share\?url=$/);
  await expect(page.getByTestId("share-setup")).toContainText("URLエンコード");
});

test("Stage 5I: 当落発表を期間で指定でき（チェックした時だけ終了日欄）、一覧に『開始〜終了』で出る。解除すると単一日に戻る", async ({ page }) => {
  await login(page);
  await page.getByRole("button", { name: "＋登録" }).click();
  const dialog = page.getByRole("dialog");
  await fillMasters(dialog, "E2E期間電機", "E2E期間店", "E2E期間商品");
  await dialog.getByLabel("応募締切の日付").fill("2099-02-01");
  await dialog.getByLabel("応募締切の時刻").fill("23:59");
  // 通常は日付欄1つだけ。入力欄を常時2つ出さない
  await expect(dialog.getByLabel("当選発表の終了日")).toHaveCount(0);
  await dialog.getByLabel("当選発表の日付").fill("2099-02-07");
  // 終了日が開始日より前のときは保存できない
  await dialog.getByLabel("期間で指定").check();
  await dialog.getByLabel("当選発表の終了日").fill("2099-02-05");
  await dialog.getByRole("button", { name: "保存" }).click();
  await expect(dialog.getByRole("alert").filter({ hasText: "終了日が開始日より前" })).toBeVisible();
  await dialog.getByLabel("当選発表の終了日").fill("2099-02-10");
  await dialog.getByRole("button", { name: "保存" }).click();
  await expect(dialog).toHaveCount(0);

  await page.getByRole("tab", { name: /全情報/ }).click();
  const card = page.getByTestId("lottery-card").filter({ hasText: "E2E期間商品" });
  await expect(card).toContainText("2099/2/7〜2099/2/10");
  // 再読込しても保持される。詳細にも期間で出る
  await page.reload();
  await page.getByRole("tab", { name: /全情報/ }).click();
  const card2 = page.getByTestId("lottery-card").filter({ hasText: "E2E期間商品" });
  await expect(card2).toContainText("2099/2/7〜2099/2/10");
  const sheet = await openDetail(page, card2);
  await expect(sheet.getByLabel("日時")).toContainText("〜2099/2/10");

  // 編集: チェックを外すと終了日を消して単一日に戻る。開始日はそのまま
  await sheet.getByRole("button", { name: "編集" }).click();
  const edit = page.getByRole("dialog").filter({ has: page.getByLabel("当選発表の日付") });
  await expect(edit.getByLabel("当選発表の終了日")).toHaveValue("2099-02-10"); // 期間のある抽選は最初から開いている
  await edit.getByLabel("期間で指定").uncheck();
  await expect(edit.getByLabel("当選発表の終了日")).toHaveCount(0);
  await edit.getByRole("button", { name: "保存" }).click();
  await expect(edit).toHaveCount(0);
  await page.reload();
  await page.getByRole("tab", { name: /全情報/ }).click();
  const card3 = page.getByTestId("lottery-card").filter({ hasText: "E2E期間商品" });
  await expect(card3).toContainText("2099/2/7");
  await expect(card3).not.toContainText("2099/2/10");
});

test("Stage 5I: プロフィール別の応募状況は表示専用、応募操作は現在のプロフィールだけ。他のプロフィールの記録はサーバーが拒否する", async ({ page }) => {
  await login(page);
  await page.getByRole("tab", { name: /全情報/ }).click();
  const card = page.getByTestId("lottery-card").filter({ hasText: "E2E期間商品" });
  const status = card.getByTestId("apply-status");
  await expect(status).toBeVisible();
  await expect(status.getByRole("button")).toHaveCount(0); // 表示専用
  const mine = card.getByTestId("my-apply");
  const myAccount = await mine.getAttribute("data-account");
  expect(myAccount).toBeTruthy();
  await mine.click();
  await expect(mine).toHaveAttribute("data-state", "applied");
  await expect(status.locator(`[data-account="${myAccount}"]`)).toHaveAttribute("data-status", "applied");
  // 他のプロフィールは応募済みにならない
  await expect(status.locator('[data-status="applied"]')).toHaveCount(1);
  // 発表前の応募済みに「未確認」は出さない
  await expect(card).not.toContainText("未確認");
  // 解除は確認つき
  await mine.click();
  await page.getByRole("button", { name: "解除する" }).click();
  await expect(mine).toHaveAttribute("data-state", "unapplied");
});

test("Stage 5I: 商品画像は軽量サムネイルを内容ハッシュ入りURLで配信し、長期キャッシュされる。未ログインは取得できない", async ({ page, playwright, baseURL }) => {
  test.setTimeout(120_000);
  const sharp = (await import("sharp")).default;
  const noise = await sharp((await import("node:crypto")).randomBytes(700 * 900 * 3), { raw: { width: 700, height: 900, channels: 3 } }).png().toBuffer();
  await login(page);
  await page.getByRole("button", { name: "＋登録" }).click();
  const dialog = page.getByRole("dialog");
  await fillMasters(dialog, "E2E速度電機", "E2E速度店", "E2E速度商品");
  await dialog.getByRole("button", { name: "保存" }).click();
  await expect(dialog).toHaveCount(0);
  await page.goto("/settings/masters");
  await page.getByRole("tab", { name: "商品", exact: true }).click();
  await page.getByTestId("master-row").filter({ hasText: "E2E速度商品" }).getByRole("button", { name: /の画像を管理/ }).click();
  const dlg = page.getByRole("dialog");
  await dlg.getByLabel("BOX画像を選択").setInputFiles({ name: "noise.png", mimeType: "image/png", buffer: noise });
  await expect(dlg.getByTestId("image-slot-box")).toContainText("手動で登録");
  await page.keyboard.press("Escape");

  await page.goto("/lotteries");
  await page.getByRole("tab", { name: /全情報/ }).click();
  const img = page.getByTestId("lottery-card").filter({ hasText: "E2E速度商品" }).getByRole("img", { name: /E2E速度商品 BOX/ });
  await expect(img).toBeVisible();
  const src = (await img.getAttribute("src"))!;
  expect(src).toMatch(/^\/api\/product-image\/[0-9a-f-]{36}\?v=[0-9a-f]{12}&s=thumb$/);

  // 配信: サムネイル(WebP)は元画像より大幅に軽く、内容ハッシュ入りURLなので長期キャッシュ（再訪問で再取得しない）
  const thumb = await page.request.get(src);
  expect(thumb.status()).toBe(200);
  expect(thumb.headers()["content-type"]).toBe("image/webp");
  expect(thumb.headers()["cache-control"]).toContain("immutable");
  expect(thumb.headers()["cache-control"]).toContain("private");
  const full = await page.request.get(src.replace("s=thumb", "s=full"));
  expect(full.status()).toBe(200);
  expect(full.headers()["content-type"]).toBe("image/png");
  const thumbBytes = (await thumb.body()).length;
  const fullBytes = (await full.body()).length;
  expect(fullBytes).toBeGreaterThan(500_000);
  expect(thumbBytes).toBeLessThan(fullBytes / 5);
  // 条件つき再取得は本体を返さない
  const again = await page.request.get(src, { headers: { "If-None-Match": thumb.headers()["etag"] } });
  expect(again.status()).toBe(304);
  // 再読込してもURLは変わらない（読み込みのたびに変わる署名URLではない）
  await page.reload();
  await page.getByRole("tab", { name: /全情報/ }).click();
  await expect(page.getByTestId("lottery-card").filter({ hasText: "E2E速度商品" }).getByRole("img", { name: /E2E速度商品 BOX/ })).toHaveAttribute("src", src);

  // 未ログイン・存在しないIDでは画像を返さない
  const anon = await playwright.request.newContext({ baseURL });
  const denied = await anon.get(src, { maxRedirects: 0 });
  expect(denied.status()).not.toBe(200);
  expect(denied.headers()["content-type"] ?? "").not.toContain("image/");
  await anon.dispose();
  const missing = await page.request.get("/api/product-image/00000000-0000-4000-8000-000000000000?s=thumb");
  expect(missing.status()).toBe(404);
  const bad = await page.request.get("/api/product-image/not-a-uuid");
  expect(bad.status()).toBe(400);
});

test("表示領域: 抽選登録のボトムシートは、開いた直後・最下部・入力中・閉じて開き直した後も、保存ボタンが表示領域内で覆われない（ライト・ダーク）", async ({ page, isMobile }) => {
  test.skip(!isMobile, "ボトムシートはスマホ幅");
  test.setTimeout(240_000);
  await login(page);
  const vpBottom = () => page.evaluate(() => (window.visualViewport ? window.visualViewport.offsetTop + window.visualViewport.height : window.innerHeight));
  const check = async (dialog: ReturnType<Page["getByRole"]>) => {
    const save = dialog.getByRole("button", { name: "保存" });
    await expect(save).toBeVisible();
    await expect
      .poll(async () => {
        const b = (await dialog.boundingBox())!;
        return Math.abs(b.y + b.height - (await vpBottom()));
      })
      .toBeLessThan(1.5); // シートは表示領域の下端に接している
    const sb = (await save.boundingBox())!;
    expect(sb.y + sb.height).toBeLessThanOrEqual((await vpBottom()) + 0.5);
    const hit = await save.evaluate((el) => {
      const r = el.getBoundingClientRect();
      const top = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
      return !!top && el.contains(top);
    });
    expect(hit).toBe(true); // 保存ボタンのいちばん手前は、保存ボタン自身
  };
  for (const theme of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme: theme });
    for (let round = 0; round < 2; round++) {
      await page.getByRole("button", { name: "＋登録" }).click();
      const dialog = page.getByRole("dialog");
      await check(dialog); // 開いた直後
      await dialog.getByRole("combobox", { name: "系列", exact: true }).focus(); // 入力欄にフォーカス
      await check(dialog);
      await dialog.locator("form").evaluate((f) => f.querySelectorAll("*").forEach((el) => { if ((el as HTMLElement).scrollHeight > (el as HTMLElement).clientHeight + 4) (el as HTMLElement).scrollTo?.({ top: 99999 }); })); // 最下部までスクロール
      await check(dialog);
      await page.waitForTimeout(4500); // 測り直しの期間が終わってから、キーボードが隠す分を再現（測り直し中は実測値で上書きされるため）
      await page.evaluate(() => document.documentElement.style.setProperty("--kb-inset", "300px"));
      await expect
        .poll(async () => {
          const b = (await dialog.boundingBox())!;
          return Math.round((await vpBottom()) - (b.y + b.height));
        })
        .toBe(300);
      const sb = (await dialog.getByRole("button", { name: "保存" }).boundingBox())!;
      const db = (await dialog.boundingBox())!;
      expect(sb.y + sb.height, `dialog=${JSON.stringify(db)} save=${JSON.stringify(sb)} vp=${await vpBottom()}`).toBeLessThanOrEqual((await vpBottom()) - 300 + 0.5); // キーボードの上に出る
      await page.evaluate(() => document.documentElement.style.removeProperty("--kb-inset"));
      await check(dialog); // キーボードを閉じた直後
      // 最小化→再開、閉じて開き直し
      await page.reload(); // 入力途中の下書きは再読込で破棄される。開き直しても同じ表示になる
    }
  }
});
