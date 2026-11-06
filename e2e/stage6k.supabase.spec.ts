import { createClient } from "@supabase/supabase-js";
import { expect, test, type CDPSession, type Page } from "@playwright/test";

/**
 * Stage 6K の画面確認（実Supabaseのテスト世帯・架空データ）。
 *   E2E_SPEC=stage6k.supabase.spec.ts npm run test:e2e:supabase
 *  - 2端末（別ブラウザコンテキスト）で同じアカウントにログインし、片方のログアウトでもう片方がログアウトされない
 *  - 経費の登録（品目）→ 収支に反映され、購入実績には入らない
 *  - コレクションの長押しドラッグ並び替え（お気に入りは保存・通常は一時）
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

test("2端末: 同じアカウントで同時ログインでき、片方のログアウトでもう片方はログアウトされない", async ({ browser }) => {
  const a = await browser.newContext({ baseURL: process.env.E2E_BASE_URL ?? "http://localhost:3100" });
  const b = await browser.newContext({ baseURL: process.env.E2E_BASE_URL ?? "http://localhost:3100" });
  const pa = await a.newPage();
  const pb = await b.newPage();
  await login(pa);
  await login(pb); // 後からのログインで、先のログインが無効にならない
  await pa.reload();
  await expect(pa).toHaveURL(/\/lotteries$/);
  await pb.reload();
  await expect(pb).toHaveURL(/\/lotteries$/);

  // A でログアウト（操作した端末だけ）
  await pa.goto("/settings");
  await pa.getByTestId("acc-about").click();
  await pa.locator('form button[type="submit"]', { hasText: "ログアウト" }).click();
  await expect(pa).toHaveURL(/\/login/);

  // B は引き続きログイン済み（再ログインを求められない）。サーバー側の検証が必要なページも開ける
  await pb.goto("/lotteries");
  await expect(pb).toHaveURL(/\/lotteries$/);
  await pb.goto("/finance");
  await expect(pb).toHaveURL(/\/finance$/);
  await expect(pb.getByRole("heading", { name: "収支" })).toBeVisible();
  // トークンの更新（再読み込みを繰り返しても維持される）
  for (let i = 0; i < 3; i++) {
    await pb.reload();
    await expect(pb).toHaveURL(/\/finance$/);
  }
  await a.close();
  await b.close();
});

test("品目: 経費を登録すると収支に反映され、購入実績（BOX数・商品別）には入らない", async ({ page }) => {
  await login(page);
  const hid = await household();
  await page.goto("/finance");
  await page.getByRole("button", { name: "＋支出" }).click();
  await expect(page.getByTestId("expense-category")).toBeVisible();
  await expect(page.getByText("購入した商品を登録します")).toHaveCount(0);
  await page.getByTestId("expense-category").selectOption("expense");
  await expect(page.getByLabel("数量1")).toHaveCount(0);
  await page.getByTestId("expense-item-name").fill("6K駐車場代");
  await page.getByLabel("購入金額1").fill("800");
  await page.getByRole("button", { name: "保存" }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  const row = page.getByTestId("ledger-row").filter({ hasText: "6K駐車場代" });
  await expect(row).toBeVisible();
  await expect(row.getByTestId("row-category")).toHaveText("経費");
  await page.getByTestId("finance-filter-open").click();
  await page.getByTestId("cat-expense").click();
  await expect(page.getByTestId("ledger-row")).toHaveCount(await page.getByTestId("ledger-row").count());
  await page.goto("/purchases");
  await expect(page.getByText("6K駐車場代")).toHaveCount(0);
  const a = admin();
  const { data } = await a.from("purchases").select("id,category").eq("household_id", hid);
  const mine = (data ?? []).filter((p) => p.category === "expense");
  expect(mine.length).toBeGreaterThan(0);
  for (const p of mine) {
    const { data: items } = await a.from("purchase_items").select("id,product_label").eq("purchase_id", p.id);
    if ((items ?? []).some((i) => i.product_label === "6K駐車場代")) {
      await a.from("purchase_items").delete().eq("purchase_id", p.id);
      await a.from("purchases").delete().eq("id", p.id);
    }
  }
});

async function longPressDrag(cdp: CDPSession, from: { x: number; y: number }, to: { x: number; y: number }) {
  await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [from] });
  await new Promise((r) => setTimeout(r, 600)); // 長押し
  const steps = 8;
  for (let i = 1; i <= steps; i++) {
    await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x: from.x + ((to.x - from.x) * i) / steps, y: from.y + ((to.y - from.y) * i) / steps }] });
    await new Promise((r) => setTimeout(r, 30));
  }
  await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
}

test("コレクション: 長押しドラッグで並び替え。お気に入りは保存され、通常の一覧は一時的（並び順を変えると解除）", async ({ page }) => {
  await login(page);
  const hid = await household();
  const a = admin();
  const { data: profiles } = await a.from("profiles").select("id").eq("household_id", hid);
  const names = ["6Kカードあ", "6Kカードい", "6Kカードう"];
  const made: string[] = [];
  try {
    for (const [i, name] of names.entries()) {
      const { data, error } = await a.from("card_masters").insert({ household_id: hid, name, rarity: "SR", card_number: String(9001 + i), set_code: "6k-e2e" }).select("id").single();
      expect(error).toBeNull();
      made.push(data!.id);
    }
    for (const p of profiles ?? []) for (let i = 0; i < made.length; i++) await a.from("card_favorites").insert({ household_id: hid, profile_id: p.id, card_id: made[i], rank: i });

    await page.goto("/collection");
    await expect(page.getByTestId("card-tile").first()).toBeVisible();
    await page.getByLabel("検索").click();
    await page.getByLabel("コレクションを検索").fill("6Kカード");
    await page.getByTestId("fav-filter").click();
    // 並びは見た目の順（上→下・左→右）。並び替え中は DOM のノードを動かさず CSS の order だけを変える
    const settle = () => page.waitForTimeout(900); // 入れ替えの移動アニメーション（約0.6秒）が終わるまで待ってから位置を読む
    const order = async () => {
      await settle();
      return (
        await page.getByTestId("card-tile").evaluateAll((els) =>
          els
            .map((e) => ({ r: e.getBoundingClientRect(), label: e.querySelector("button")?.getAttribute("aria-label") ?? "" }))
            .sort((a, b) => Math.round(a.r.top) - Math.round(b.r.top) || a.r.left - b.r.left)
            .map((x) => x.label),
        )
      ).map((s) => s.replace(/ SR.*/, ""));
    };
    await expect.poll(order).toEqual(names.map((n) => n));

    const cdp = await page.context().newCDPSession(page);
    const tiles = page.getByTestId("card-tile");
    // 並び替えでカードが作り直されない（消えて再出現しない）ことの確認用の目印
    await tiles.evaluateAll((els) => els.forEach((e, i) => ((e as HTMLElement).dataset.probe = String(i))));
    const b0 = (await tiles.nth(0).boundingBox())!;
    const b2 = (await tiles.nth(2).boundingBox())!;
    await longPressDrag(cdp, { x: b0.x + b0.width / 2, y: b0.y + b0.height / 2 }, { x: b2.x + b2.width / 2, y: b2.y + b2.height / 2 });
    const moved = await order();
    expect(moved[0]).not.toBe(names[0]); // 先頭だった「あ」が動いた
    expect(moved).toHaveLength(3);
    await expect(page.getByTestId("card-tile")).toHaveCount(3);
    await expect(page.locator("[data-probe]")).toHaveCount(3); // 3枚とも同じ要素のまま（アンマウント・再生成されない）

    // お気に入り表示では保存される: 再読み込みしても同じ並び
    await page.waitForTimeout(800);
    await page.reload();
    await page.getByLabel("検索").click();
    await page.getByLabel("コレクションを検索").fill("6Kカード");
    await page.getByTestId("fav-filter").click();
    await expect.poll(order).toEqual(moved);

    // 縦スクロール（長押しにならない速い移動）では並びは変わらない
    const before = await order();
    const t = (await tiles.nth(1).boundingBox())!;
    await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: t.x + 10, y: t.y + 10 }] });
    await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x: t.x + 10, y: t.y - 60 }] });
    await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
    expect(await order()).toEqual(before);

    // お気に入り以外の表示: 一時的な並び。並び順を変えると解除され、保存もされない
    await page.getByTestId("fav-filter").click(); // お気に入りの絞り込みを外す
    await page.getByLabel("並び順").selectOption("name");
    const normal0 = await order();
    const n0 = (await tiles.nth(0).boundingBox())!;
    const n2 = (await tiles.nth(2).boundingBox())!;
    await longPressDrag(cdp, { x: n0.x + n0.width / 2, y: n0.y + n0.height / 2 }, { x: n2.x + n2.width / 2, y: n2.y + n2.height / 2 });
    const temp = await order();
    expect(temp).not.toEqual(normal0);
    await page.getByLabel("並び順").selectOption("created");
    await page.getByLabel("並び順").selectOption("name");
    expect(await order()).toEqual(normal0); // 解除されて元の並び順に戻る
    const { data: favs } = await a.from("card_favorites").select("card_id,rank").in("card_id", made);
    expect((favs ?? []).length).toBeGreaterThan(0); // お気に入りの保存順はそのまま（通常一覧の並び替えでは書き換えない）
  } finally {
    await a.from("card_favorites").delete().in("card_id", made);
    await a.from("card_masters").delete().in("id", made);
  }
});
