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
  await sheet.getByRole("button", { name: "閉じる" }).click();
  await expect(sheet).toHaveCount(0);

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
  await sheet2.getByRole("button", { name: "閉じる" }).click();

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
  await page.getByRole("button", { name: "＋抽選を登録" }).click();
  const dialog = page.getByRole("dialog");
  await fillMasters(dialog, "E2E電機", "E2E店", "E2E複数商品1");
  await openFormDetails(dialog);
  await dialog.getByLabel("抽選の方式").selectOption({ label: "B. 1回の応募で複数商品に参加（商品ごとに当落）" });
  await dialog.getByRole("combobox", { name: "商品2", exact: true }).fill("E2E複数商品2");
  await dialog.getByLabel("単位2").selectOption("pack");
  await dialog.getByLabel("数量2").fill("3");
  await dialog.getByLabel("Aの応募状況").selectOption("applied");
  await dialog.getByRole("button", { name: "保存" }).click();
  await expect(dialog).toHaveCount(0);

  const card = page.getByTestId("lottery-card").filter({ hasText: "E2E複数商品1" });
  await expect(card).toContainText("＋他1商品"); // シンプル表示は省スペース
  const msheet = await openDetail(page, card);
  await expect(msheet).toContainText("商品ごとに当落"); // 方式は詳細パネルで確認
  await expect(msheet).toContainText("E2E複数商品2");
  // 商品1は当選・商品2は落選
  await msheet.getByRole("group", { name: /^A E2E複数商品1.*の結果$/ }).getByRole("button", { name: "当選" }).click();
  await msheet.getByRole("group", { name: /^A E2E複数商品2.*の結果$/ }).getByRole("button", { name: "落選" }).click();
  await expect(msheet.getByTestId("item-result-tag").first()).toContainText("当選");
  await msheet.getByRole("button", { name: "閉じる" }).click();

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

test("商品画像: 画像なしはプレースホルダー、手動アップロードで縦横比を保って表示、差し替え・商品編集もできる", async ({ page }) => {
  await login(page);
  // 画像なしの商品を（抽選登録の自動仮登録で）用意
  await page.getByRole("button", { name: "＋抽選を登録" }).click();
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

test("AIで読み取る: 文章→確認→フォーム入力→保存（未設定の環境では案内を表示し、手動登録は使える）", async ({ page }) => {
  // 本番URL（E2E_BASE_URL）ではAPIキーが設定済みで、実際のAIが呼ばれて費用が発生するため実行しない。
  // 実AIの検証は e2e/ai-live.spec.ts（docs/ai-live-verification.md）。ここはモックエンジンまたは未設定の環境（ローカル・CI）での画面の確認。
  test.skip(!!process.env.E2E_BASE_URL, "本番では実AIの検証（ai-live）で確認する。費用を発生させない");
  await login(page);
  await page.getByRole("button", { name: "＋抽選を登録" }).click();
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
    await ai.getByRole("button", { name: "閉じる" }).click();
    await fillMasters(dialog, "E2E電機", "E2E店", "E2Eテスト商品");
    await expect(dialog.getByRole("button", { name: "保存" })).toBeEnabled();
    return;
  }

  // モックエンジン: 実際のAI解析ではないことが明示される
  await expect(ai.getByTestId("ai-mock-banner")).toContainText("モック");
  await expect(result).toContainText("複数商品の応募方式が告知から判断できませんでした");
  await page.screenshot({ path: "docs/screenshots/stage4b-ai-result-mobile.png" });
  await ai.getByRole("button", { name: "フォームに入力" }).click();

  // フォーム: 候補として入力され、要確認が表示される。方式が未確定のままでは保存できない
  await expect(dialog.getByTestId("ai-filled-note")).toBeVisible();
  await expect(dialog.getByTestId("ai-flag").first()).toContainText("要確認");
  await openFormDetails(dialog);
  await expect(dialog.getByLabel("抽選の方式")).toHaveValue("");
  await expect(dialog.getByRole("combobox", { name: "商品2", exact: true })).toHaveValue("サンプル拡張パック「ほしぞら」");
  await dialog.getByRole("button", { name: "保存" }).click();
  await expect(dialog.getByRole("alert").filter({ hasText: "応募方式" })).toBeVisible();
  await page.screenshot({ path: "docs/screenshots/stage4b-ai-form-mobile.png" });

  // 方式を選べば保存でき、通常のカードとして表示される（未登録のマスターは仮登録）
  await dialog.getByLabel("抽選の方式").selectOption({ label: "C. 複数商品が対象（当選はいずれか1商品まで）" });
  await dialog.getByLabel("応募締切の日付").fill("2027-01-20");
  await dialog.getByLabel("応募締切の時刻").fill("23:59");
  await dialog.getByRole("button", { name: "保存" }).click();
  await expect(dialog).toHaveCount(0);
  const card = page.getByTestId("lottery-card").filter({ hasText: "テスト拡張パック「ひかりの森」" });
  await expect(card).toHaveCount(1);

  // 同じ内容を再度読み取ると、登録済みとして重複の注意が出る（二重登録の防止）
  await page.getByRole("button", { name: "＋抽選を登録" }).click();
  const d2 = page.getByRole("dialog").first();
  await d2.getByTestId("ai-open").click();
  const ai2 = page.getByRole("dialog").filter({ hasText: "AIで読み取る" }).last();
  await ai2.getByLabel("告知の文章を貼り付け").fill("【複数商品】抽選販売のお知らせ。サンプル電機 三宮店。応募は1月20日まで。");
  await ai2.getByRole("button", { name: "読み取る" }).click();
  await expect(ai2.getByTestId("ai-duplicates")).toBeVisible({ timeout: 20000 });
  await ai2.getByRole("button", { name: "フォームに入力" }).click();
  await expect(d2.getByTestId("dup-warning")).toContainText("重複");
  await openFormDetails(d2);
  await d2.getByLabel("抽選の方式").selectOption({ label: "C. 複数商品が対象（当選はいずれか1商品まで）" });
  await d2.getByRole("button", { name: "保存" }).click();
  await expect(d2.getByTestId("dup-warning")).toBeVisible();
  await expect(d2.getByText("「重複ではないことを確認した」にチェックしてください")).toBeVisible();
});

test("商品マスター: 検索・絞り込み、セット構成の登録、画像の表示調整（倍率・位置）", async ({ page }) => {
  await login(page);
  // 抽選登録の自動仮登録で2商品を用意（セット商品と構成商品）
  await page.getByRole("button", { name: "＋抽選を登録" }).click();
  const dialog = page.getByRole("dialog");
  await fillMasters(dialog, "E2Eセット電機", "E2Eセット店", "E2Eセット商品");
  await openFormDetails(dialog);
  await dialog.getByLabel("抽選の方式").selectOption({ label: "B. 1回の応募で複数商品に参加（商品ごとに当落）" });
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

test("抽選フォーム: 日時は空欄=不明/日付のみ/0:00を区別、初期値は未確認の印、最小化・下書き復元・リセット、他端末の更新を保存前に検出", async ({ page, context }) => {
  test.setTimeout(120_000); // 端末2台分の操作を含む長いシナリオ
  await login(page);
  await page.getByRole("button", { name: "＋抽選を登録" }).click();
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
  const [dl, an] = [(await form.getByLabel("応募開始の日付").boundingBox())!, (await form.getByLabel("応募締切の日付").boundingBox())!];
  expect(Math.abs(dl.y - an.y)).toBeLessThan(4); // 同じ行に2つ並ぶ

  await fillMasters(form, "E2Eフォーム電機", "E2Eフォーム店", "E2Eフォーム商品");
  await form.getByLabel("応募締切の日付").fill("2026-02-01"); // 時刻なし = 日付のみ
  await expect(form).toContainText("時刻は未設定");
  await form.getByLabel("当選発表の日付").fill("2026-02-05");
  await form.getByLabel("当選発表の時刻").fill("00:00"); // 0:00 は「時刻あり」
  // 時刻だけで日付が空の項目は保存できない
  await form.getByLabel("購入・受取期限の時刻").fill("10:00");
  await form.getByRole("button", { name: "保存" }).click();
  await expect(form.getByRole("alert").filter({ hasText: "時刻だけでは登録できません" })).toBeVisible();
  await form.getByLabel("購入・受取期限の時刻").fill("");

  // 最小化: 一覧を見られ、再開すると入力が残っている
  await form.getByRole("button", { name: /^最小化（入力は保持されます）/ }).click();
  await expect(form).toHaveCount(0);
  const bar = page.getByTestId("form-minimized");
  await expect(bar).toContainText("E2Eフォーム電機 E2Eフォーム店");
  await page.getByRole("tab", { name: /全情報/ }).click(); // 最小化中も一覧を操作できる
  await bar.click();
  await expect(page.getByTestId("lottery-form").getByLabel("応募締切の日付")).toHaveValue("2026-02-01");

  // 再読込しても下書きが残り、「下書き」から再開できる
  await expect.poll(() => page.evaluate(() => localStorage.getItem("tcg.draft.lottery.new"))).not.toBeNull();
  await page.reload();
  await page.getByTestId("draft-resume").click();
  const form2 = page.getByTestId("lottery-form");
  await expect(form2.getByTestId("draft-restored")).toBeVisible();
  await expect(form2.getByRole("combobox", { name: "店舗", exact: true })).toHaveValue("E2Eフォーム店");
  await expect(form2.getByLabel("当選発表の時刻")).toHaveValue("00:00");

  // リセット: 確認のうえ初期状態に戻り、下書きも消える
  await form2.getByRole("button", { name: "入力をリセット" }).click();
  await expect(form2.getByTestId("form-confirm")).toBeVisible();
  await form2.getByRole("button", { name: "リセットする" }).click();
  await expect(form2.getByRole("combobox", { name: "店舗", exact: true })).toHaveValue("");
  await expect.poll(() => page.evaluate(() => localStorage.getItem("tcg.draft.lottery.new"))).toBeNull();

  // 入力し直して保存 → 下書きは消え、日付のみ/0:00 が区別されて表示される。初期値のままの項目は「未確認」
  await fillMasters(form2, "E2Eフォーム電機", "E2Eフォーム店", "E2Eフォーム商品");
  await form2.getByLabel("応募締切の日付").fill("2026-02-01");
  await form2.getByLabel("当選発表の日付").fill("2026-02-05");
  await form2.getByLabel("当選発表の時刻").fill("00:00");
  await form2.getByLabel("受取方法", { exact: true }).selectOption("shipping"); // 選び直した項目は確認済み（印が外れる）
  await expect(form2.getByTestId("tag-default")).toHaveCount(1);
  await form2.getByRole("button", { name: "保存" }).click();
  await expect(page.getByTestId("lottery-form")).toHaveCount(0);
  await expect.poll(() => page.evaluate(() => localStorage.getItem("tcg.draft.lottery.new"))).toBeNull();
  await expect(page.getByTestId("draft-resume")).toHaveCount(0);

  await page.getByRole("tab", { name: /全情報/ }).click();
  const card = page.getByTestId("lottery-card").filter({ hasText: "E2Eフォーム店" });
  const sheet = await openDetail(page, card);
  await expect(sheet.getByRole("group", { name: "日時" }).or(sheet.getByLabel("日時"))).toContainText("2/1（時刻未確認）");
  await expect(sheet.getByLabel("日時")).toContainText("2/5 00:00");
  await expect(sheet.getByLabel("方法")).toContainText("Web");
  await expect(sheet.getByLabel("方法").getByText("初期値・未確認")).toHaveCount(1); // 応募方法だけが未確認の初期値
  await sheet.getByRole("button", { name: "閉じる" }).click();

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
  await page.getByRole("button", { name: "＋抽選を登録" }).click();
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
  // この商品だけに絞る（同じ世帯の他のテストの購入が混ざらないように）
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
  await page.goto("/settings");
  await page.getByRole("link", { name: "対戦記録" }).click();
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
  await page.getByTestId("battle-form").getByRole("button", { name: "閉じる" }).click();

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
  await page.getByRole("button", { name: "＋抽選を登録" }).click();
  const form = page.getByTestId("lottery-form");
  await fillMasters(form, "E2E位置電機", "E2E位置店", "E2E位置商品");
  await form.getByRole("button", { name: "保存" }).click();
  await expect(form).toHaveCount(0);

  // 自宅の位置: 未設定 → 住所は普段は表示されない。手入力で設定（外部の住所検索は押さない限り使わない）
  await page.goto("/settings");
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

  // 抽選カード: 都道府県ラベルと距離（既定で表示）。交通費は既定では非表示
  await page.goto("/lotteries");
  await page.getByRole("tab", { name: /全情報/ }).click();
  const card = page.getByTestId("lottery-card").filter({ hasText: "E2E位置店" });
  await expect(card.getByTestId("card-place")).toContainText("大阪府");
  await expect(card.getByTestId("card-distance")).toHaveText(/^\d+km$/);
  await expect(card.getByTestId("card-place")).not.toContainText("¥1,280");
  await page.screenshot({ path: "docs/screenshots/stage5b-card-mobile.png" });

  // 表示項目の設定（家族共通）: 都道府県を隠し、交通費を表示。再読込後も保持され、締切の警告などは常に表示
  await page.goto("/settings");
  const cd = page.getByTestId("card-display");
  await cd.getByLabel("都道府県").uncheck();
  await cd.getByLabel("往復交通費").check();
  await cd.getByRole("button", { name: "表示設定を保存" }).click();
  await expect(cd.getByRole("status")).toContainText("保存しました");
  await page.goto("/lotteries");
  await page.getByRole("tab", { name: /全情報/ }).click();
  const card2 = page.getByTestId("lottery-card").filter({ hasText: "E2E位置店" });
  await expect(card2.getByTestId("card-place")).not.toContainText("大阪府");
  await expect(card2.getByTestId("card-place")).toContainText("¥1,280");
  await expect(card2.getByTestId("card-distance")).toBeVisible();
  await expect(card2.getByLabel("応募アカウントの状態")).toBeVisible(); // ★・ユーザー別状態の操作は設定に関係なく表示

  // 距離の区分は後から変更できる（昇順4つの正の数）。不正な値は保存されない
  await page.goto("/settings");
  const cd2 = page.getByTestId("card-display");
  await cd2.getByLabel("距離区分の上限2").fill("3");
  await cd2.getByRole("button", { name: "表示設定を保存" }).click();
  await expect(cd2.getByRole("alert")).toContainText("小さい順");
  await cd2.getByLabel("距離区分の上限2").fill("20");
  await cd2.getByRole("button", { name: "表示設定を保存" }).click();
  await expect(cd2.getByRole("status")).toContainText("保存しました");
  await page.reload();
  await expect(page.getByTestId("card-display").getByLabel("距離区分の上限2")).toHaveValue("20");
  await expect(page.getByTestId("card-display").getByLabel("都道府県")).not.toBeChecked();

  // 自宅の位置を変えると、交通費の見直しを促す（自動計算はしない）
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
  await expect(page.getByTestId("lottery-card").filter({ hasText: "E2E位置店" }).getByTestId("card-distance")).toHaveCount(0);

  // AI利用状況・料金: 回数・推定料金・予算・警告。予算を超えたら警告と自動解析の停止を表示
  await page.goto("/settings");
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
  await nav.getByRole("link", { name: "設定" }).click();
  await expect(page).toHaveURL(/\/settings$/);
  await nav.getByRole("link", { name: "抽選管理" }).click();
  await expect(page.getByRole("heading", { name: "抽選管理" })).toBeVisible();
  expect(await page.evaluate(() => (window as unknown as { __splashSeen: number }).__splashSeen)).toBe(0);
  // 未ログインの状態は従来どおりログイン画面へ（認証の挙動は変わらない）
  await page.context().clearCookies();
  await page.goto("/lotteries");
  await expect(page).toHaveURL(/\/login$/);
});
