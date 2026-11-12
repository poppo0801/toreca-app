import { createClient } from "@supabase/supabase-js";
import { expect, test, type Page } from "@playwright/test";

/**
 * Stage 7C の画面確認（実Supabaseのテスト世帯・架空データ）。
 *   E2E_SPEC=stage7c.supabase.spec.ts npm run test:e2e:supabase
 *  - バックグラウンド復帰（時計を進めて hidden→visible）: データだけを静かに再取得し、タブ・プロフィール・開いたダイアログと入力を保つ。オフライン中は取得せず、接続が戻ったら取得する
 *  - 端末のメモリ解放後の再起動を想定し、タブ・フィルターを控えから復元
 *  - エラーの記録（端末内・サーバーログ送信API）と新バージョン確認API
 *  - 動作状況の初期折りたたみ、コレクション詳細の整理、収支の金額右寄せ
 * ※ iPhone実機でのバックグラウンド復帰・ホームバーの切替は、この自動テストでは再現できない（実機確認が必要）。
 */
const email = process.env.E2E_EMAIL!;
const password = process.env.E2E_PASSWORD!;
const admin = () => createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false, autoRefreshToken: false } });

async function login(page: Page) {
  await page.goto("/login");
  await page.getByLabel("メールアドレス").fill(email);
  await page.getByLabel("パスワード").fill(password);
  await page.getByRole("button", { name: "ログイン" }).click();
  await expect(page).toHaveURL(/\/lotteries$/);
}
async function household(): Promise<string> {
  const a = admin();
  const { data: list } = await a.auth.admin.listUsers({ perPage: 200 });
  const user = list?.users.find((u) => u.email === email);
  if (!user) throw new Error("test user not found");
  const { data: hm } = await a.from("household_members").select("household_id").eq("user_id", user.id).limit(1).maybeSingle();
  if (!hm) throw new Error("household not found");
  return hm.household_id;
}
const setVisibility = (page: Page, v: "hidden" | "visible") =>
  page.evaluate((state) => {
    Object.defineProperty(document, "visibilityState", { value: state, configurable: true });
    document.dispatchEvent(new Event("visibilitychange"));
  }, v);
const advance = (page: Page, ms: number) => page.evaluate((d) => void ((window as unknown as { __skew: number }).__skew += d), ms);
const isDataPost = (req: { method: () => string; headers: () => Record<string, string> }) => req.method() === "POST" && !!req.headers()["next-action"];

test("バックグラウンド復帰: 長く離れたあとはデータだけ静かに再取得し、タブ・プロフィール・入力中のダイアログを保つ。オフライン中は取得せず、接続が戻ったら取得する", async ({ page, context }) => {
  test.setTimeout(120_000);
  // 時間の経過を再現する: Date.now() に加算するずれ（window.__skew）を持たせる。タイマーは止めない
  await page.addInitScript(() => {
    const real = Date.now.bind(Date);
    (window as unknown as { __skew: number }).__skew = 0;
    Date.now = () => real() + (window as unknown as { __skew: number }).__skew;
  });
  await login(page);
  await page.getByRole("tab", { name: /応募済み/ }).click();
  const posts: string[] = [];
  page.on("request", (r) => isDataPost(r) && posts.push(r.url()));
  await page.waitForTimeout(500);

  // 登録フォームを開いて入力しておく（入力中の復帰）
  await page.getByTestId("register").click();
  const dialog = page.getByRole("dialog").first();
  await expect(dialog).toBeVisible();
  const memo = dialog.getByRole("combobox", { name: "系列" });
  await memo.fill("復帰テスト系列");

  // 数分離れて戻る → データを再取得（画面は作り直さない）
  const before = posts.length;
  await setVisibility(page, "hidden");
  await advance(page, 5 * 60_000);
  const waitPost = page.waitForResponse((r) => isDataPost(r.request()), { timeout: 15_000 });
  await setVisibility(page, "visible");
  await (await waitPost).finished();
  await page.waitForTimeout(500); // 取得が反映されるまで
  expect(posts.length).toBeGreaterThan(before);
  await expect(page.getByTestId("recoverable-error")).toHaveCount(0);
  await expect(dialog).toBeVisible(); // 開いていたダイアログは閉じない
  await expect(memo).toHaveValue("復帰テスト系列"); // 入力も消えない
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "破棄して閉じる" }).click(); // 入力済みのフォームは破棄の確認が出る（現行仕様）
  await expect(page.getByRole("tab", { name: /応募済み/ })).toHaveAttribute("aria-selected", "true"); // タブも保つ

  // 一時的な通信切断: 復帰しても取得せず、エラー画面にもならない。接続が戻ったら取得する
  await context.setOffline(true);
  await setVisibility(page, "hidden");
  await advance(page, 10 * 60_000);
  const n1 = posts.length;
  await setVisibility(page, "visible");
  await page.waitForTimeout(1500);
  expect(posts.length).toBe(n1);
  await expect(page.getByTestId("recoverable-error")).toHaveCount(0);
  await expect(page.getByTestId("splash")).toHaveCount(0);
  await context.setOffline(false);
  await page.waitForFunction(() => navigator.onLine);
  await page.evaluate(() => window.dispatchEvent(new Event("online")));
  await expect.poll(() => posts.length, { timeout: 15_000 }).toBeGreaterThan(n1); // 接続が戻ったら取得する（ブラウザ自身の online イベントでも、上の発火でも1回だけ）
  await expect(page.getByRole("tab", { name: /応募済み/ })).toHaveAttribute("aria-selected", "true");
});

test("端末のメモリ解放後の再起動を想定: セッションの控えが無くても、直前のタブを端末の控えから復元する", async ({ page }) => {
  await login(page);
  await page.getByRole("tab", { name: /当選/ }).click();
  await expect(page.getByRole("tab", { name: /当選/ })).toHaveAttribute("aria-selected", "true");
  await page.evaluate(() => window.sessionStorage.clear()); // 再起動で sessionStorage が失われた状態
  await page.reload();
  await expect(page.getByRole("tab", { name: /当選/ })).toHaveAttribute("aria-selected", "true");
});

test("エラーの記録と確認API: 端末内に記録され設定で確認できる。サーバーへ送る記録は整理され、不正な入力は拒否。新バージョン確認は秘密情報を返さない", async ({ page, playwright }) => {
  await login(page);
  await expect(page.getByRole("tab", { name: /要チェック/ })).toBeVisible(); // 画面の準備ができてから
  // 古いJSの読み込み失敗 → 新バージョンの通知は出さない設定外（BUILD_ID=dev）でも記録はされる
  await page.evaluate(() => window.dispatchEvent(new ErrorEvent("error", { error: new Error("Loading chunk 7 failed. token=eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.abcdefghijk") })));
  await page.goto("/settings/display");
  const log = page.getByTestId("client-error-log");
  await log.locator("summary").click();
  await expect(log).toContainText("古い画面");
  await expect(log).not.toContainText("eyJ");

  // ログ送信API（ログイン済みのみ）
  const ok = await page.request.post("/api/client-log", { data: { at: new Date().toISOString(), kind: "network", path: "/lotteries", afterResume: true, online: true, build: "abc1234", where: "load", message: "TypeError: Load failed" } });
  expect(ok.status()).toBe(204);
  expect((await page.request.post("/api/client-log", { data: { kind: "x" } })).status()).toBe(400);
  const anon = await playwright.request.newContext({ baseURL: page.url().split("/").slice(0, 3).join("/") });
  const ver = await anon.get("/api/version");
  expect(ver.status()).toBe(200);
  expect(Object.keys(await ver.json())).toEqual(["build"]);
  await anon.dispose();
});

test("設定とUI: 自動収集の「①動作状況」は初期に閉じていて、見出しで開閉できる", async ({ page }) => {
  await login(page);
  await page.goto("/settings/collection");
  const status = page.getByTestId("status");
  await expect(status).toBeVisible();
  const head = page.getByTestId("status-toggle");
  await expect(head).toHaveAttribute("aria-expanded", "false");
  await head.click();
  await expect(head).toHaveAttribute("aria-expanded", "true");
  await expect(page.locator("#status-body")).toBeVisible();
  await head.click();
  await expect(head).toHaveAttribute("aria-expanded", "false");
});

test("収支: 金額は右端にそろい、桁数が違っても右端が同じ。長い商品名でも金額と重ならない", async ({ page }) => {
  test.setTimeout(120_000);
  await login(page);
  const hid = await household();
  const a = admin();
  const today = new Date(Date.now() + 9 * 3600_000).toISOString().slice(0, 10);
  const mk = async (label: string, amount: number) => {
    const p = (await a.from("purchases").insert({ household_id: hid, category: "expense", source_kind: "manual", purchased_date: today, channel: "store" } as never).select("id").single()).data!.id as string;
    await a.from("purchase_items").insert({ household_id: hid, purchase_id: p, quantity: 1, unit: "piece", product_label: label, amount_paid: amount } as never);
    return p;
  };
  const ids = [await mk("7C短い", 9), await mk("7C" + "とても長い商品名".repeat(8), 1234567), await mk("7C中くらい", 45600)];
  try {
    await page.goto("/finance");
    const rows = page.getByTestId("ledger-row").filter({ hasText: "7C" });
    await expect(rows).toHaveCount(3);
    const boxes = [];
    for (let i = 0; i < 3; i++) {
      const row = rows.nth(i);
      const amount = (await row.getByTestId("row-amount").boundingBox())!;
      const title = (await row.getByTestId("row-title").boundingBox())!;
      const card = (await row.boundingBox())!;
      expect(title.x + title.width).toBeLessThanOrEqual(amount.x + 0.5); // 重ならない
      boxes.push({ right: amount.x + amount.width, card: card.x + card.width, align: await row.getByTestId("row-amount").evaluate((e) => getComputedStyle(e).textAlign) });
    }
    for (const b of boxes) {
      expect(b.align).toBe("right");
      expect(Math.abs(b.right - boxes[0].right)).toBeLessThan(1); // 金額の右端が全カードで同じ
      expect(b.card - b.right).toBeLessThan(20);
    }
    await expect(rows.filter({ hasText: "-9円" })).toHaveCount(1); // 表示形式（符号・円）は従来どおり
  } finally {
    for (const p of ids) {
      await a.from("purchase_items").delete().eq("purchase_id", p);
      await a.from("purchases").delete().eq("id", p);
    }
  }
});

test("コレクション詳細: 収録パック別の集計と「一部のカードだけ」の説明が無く、余白がある。カードの収録パック情報は残る", async ({ page }) => {
  test.setTimeout(120_000);
  await login(page);
  const hid = await household();
  const a = admin();
  const ins = await a.from("card_masters").insert({ household_id: hid, name: "7C-カード", card_number: "1/9", set_code: "7C", rarity: "RR" } as never).select("id").single();
  expect(ins.error).toBeNull();
  const id = ins.data!.id as string;
  try {
    await page.goto("/collection");
    await expect(page.getByTestId("card-tile")).toHaveCount(1);
    await page.getByTestId("summary-line").click();
    const stats = page.getByTestId("collection-stats");
    await expect(stats).toBeVisible();
    await expect(stats).not.toContainText("収録パック別");
    await expect(stats).not.toContainText("一部のカードだけ");
    const dl = (await stats.locator("dl").boundingBox())!;
    const box = (await stats.boundingBox())!;
    expect(dl.x - box.x).toBeGreaterThanOrEqual(12); // 左右の余白
    // カード登録フォームの収録パック入力は残る
    expect((await a.from("card_masters").select("id").eq("id", id)).data).toHaveLength(1);
  } finally {
    await a.from("card_masters").delete().eq("id", id);
  }
});
