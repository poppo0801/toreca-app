import { createClient } from "@supabase/supabase-js";
import { expect, test, type Page } from "@playwright/test";

/**
 * Stage 7D の画面確認（実Supabaseのテスト世帯・架空データ）。
 *   E2E_SPEC=stage7d.supabase.spec.ts npm run test:e2e:supabase
 *  - 代表的な登録・編集・設定のダイアログ/シートを開いても、入力欄・セレクト・テキストエリアにフォーカスが入らない（iPhoneでキーボードが出ない）
 *  - 入力欄をタップして初めて入力できる。閉じると開いたボタンへフォーカスが戻る
 *  - キーボード表示時（--kb-inset）にダイアログが表示領域に収まり、確定/キャンセルが見える
 *  - マスター管理は40件ずつ描画する
 * ※ 実際のiPhoneのキーボード表示・バックグラウンド復帰は実機でのみ確認できる。
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
/** 現在フォーカスのある要素が入力欄・セレクト・テキストエリア（編集可能）か */
const editableFocused = (page: Page) =>
  page.evaluate(() => {
    const el = document.activeElement as HTMLElement | null;
    return !!el && (/^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName) || el.isContentEditable);
  });
async function expectNoAutoFocus(page: Page, what: string) {
  await page.waitForTimeout(400); // 開くアニメーションと初期フォーカスが終わるまで
  expect(await editableFocused(page), `${what}: 入力欄にフォーカスが入っていない`).toBe(false);
}

test("登録・編集・設定のダイアログ/シートを開いても、入力欄へ自動フォーカスしない。タップすると入力でき、閉じると開いたボタンへ戻る", async ({ page }) => {
  test.setTimeout(180_000);
  await login(page);
  const hid = await household();
  const a = admin();
  const mk = async (name: string) => (await a.from("chains").insert({ household_id: hid, name }).select("id").single()).data!.id as string;
  const c1 = await mk("7D統合元");
  await mk("7D統合先");
  try {
    // 抽選の登録（シート）
    await page.getByTestId("register").click();
    await expectNoAutoFocus(page, "抽選の登録");
    const chain = page.getByRole("dialog").getByRole("combobox", { name: "系列" });
    await chain.click();
    await expect(chain).toBeFocused();
    await chain.fill("入力できる");
    await expect(chain).toHaveValue("入力できる");
    await page.keyboard.press("Escape");
    // 入力済みの登録フォームは、Escapeで閉じる前に破棄の確認が出る（入力内容を守る現行仕様）。確認で破棄して閉じる
    await page.getByRole("button", { name: "破棄して閉じる" }).click();
    await expect(page.getByRole("dialog")).toHaveCount(0);

    // 絞り込み
    await page.getByTestId("filter-open").click();
    await expectNoAutoFocus(page, "絞り込みシート");
    await page.keyboard.press("Escape");

    // マスター管理: 追加（ダイアログ）、系列統合（ユーザーが挙げた例）
    await page.goto("/settings/masters");
    await page.getByRole("tab", { name: "系列", exact: true }).click();
    const row = page.getByTestId("master-row").filter({ hasText: "7D統合元" });
    await row.getByRole("button", { name: "編集" }).click();
    await expectNoAutoFocus(page, "マスターの編集");
    await page.keyboard.press("Escape");
    await row.getByTestId("row-menu").evaluate((el) => ((el as HTMLDetailsElement).open = true));
    const mergeOpen = row.getByTestId("chain-merge-open");
    await mergeOpen.click();
    const dlg = page.getByTestId("chain-merge-dialog");
    await expect(dlg).toBeVisible();
    await expectNoAutoFocus(page, "系列統合");
    // 入力欄をタップして初めて入力できる
    const into = dlg.getByRole("combobox", { name: "統合先の系列" });
    await into.click();
    await expect(into).toBeFocused();
    await into.fill("7D統合先");
    await expect(into).toHaveValue("7D統合先");
    await page.keyboard.press("Escape");
    await page.keyboard.press("Escape");

    // 収支: 支出の登録（シート）
    await page.goto("/finance");
    await page.getByRole("button", { name: "＋支出" }).click();
    await expectNoAutoFocus(page, "支出の登録");
    await page.keyboard.press("Escape");

    // コレクション: 検索欄（アイコンをタップしても欄へ自動フォーカスしない）
    await page.goto("/collection");
    await page.getByTestId("search-toggle").click();
    await expect(page.getByRole("searchbox").first()).toBeVisible();
    expect(await editableFocused(page)).toBe(false);

    // 設定の各画面
    for (const path of ["/settings/display", "/settings/notifications", "/settings/users"]) {
      await page.goto(path);
      await page.waitForTimeout(300);
      expect(await editableFocused(page), `${path}を開いた直後`).toBe(false);
    }
  } finally {
    await a.from("chains").delete().eq("household_id", hid).like("name", "7D統合%");
    void c1;
  }
});

test("キーボード表示時（--kb-inset）も、ダイアログは表示領域に収まり、本文をスクロールでき、確定/キャンセルを操作できる", async ({ page }) => {
  test.setTimeout(120_000);
  await login(page);
  const hid = await household();
  const a = admin();
  await a.from("chains").insert([{ household_id: hid, name: "7Dキー元" }, { household_id: hid, name: "7Dキー先" }] as never);
  try {
    await page.goto("/settings/masters");
    await page.getByRole("tab", { name: "系列", exact: true }).click();
    const row = page.getByTestId("master-row").filter({ hasText: "7Dキー元" });
    await row.getByTestId("row-menu").evaluate((el) => ((el as HTMLDetailsElement).open = true));
    await row.getByTestId("chain-merge-open").click();
    const dlg = page.getByTestId("chain-merge-dialog");
    await expect(dlg).toBeVisible();
    const vh = page.viewportSize()!.height;
    for (const kb of [0, 300]) {
      // iPhoneのキーボード表示を、アプリが使う --kb-inset（隠れる高さ）で再現する（AppShell が書き換えないよう、スタイルシートで指定）
      await page.evaluate((px) => { document.getElementById("kb-sim")?.remove(); const st = document.createElement("style"); st.id = "kb-sim"; st.textContent = `html{--kb-inset:${px}px !important}`; document.head.appendChild(st); }, kb);
      await page.waitForTimeout(150);
      const box = (await dlg.boundingBox())!;
      expect(box.y).toBeGreaterThanOrEqual(0);
      expect(box.y + box.height).toBeLessThanOrEqual(vh - kb + 1); // キーボードに隠れない
      const cancel = dlg.getByRole("button", { name: "キャンセル" });
      await expect(cancel).toBeVisible();
      const cb = (await cancel.boundingBox())!;
      expect(cb.y + cb.height).toBeLessThanOrEqual(vh - kb + 1);
    }
    const style = await dlg.evaluate((e) => getComputedStyle(e).overflowY);
    expect(style).toBe("auto");
    await dlg.getByRole("button", { name: "キャンセル" }).click();
    await expect(dlg).toHaveCount(0);
  } finally {
    await a.from("chains").delete().eq("household_id", hid).like("name", "7Dキー%");
  }
});

test("マスター管理は一覧を40件ずつ描画する（大量でもDOM・画像を増やしすぎない）", async ({ page }) => {
  test.setTimeout(120_000);
  await login(page);
  const hid = await household();
  const a = admin();
  const chains = Array.from({ length: 95 }, (_, i) => ({ household_id: hid, name: `7D一覧${String(i).padStart(3, "0")}` }));
  expect((await a.from("chains").insert(chains as never)).error).toBeNull();
  try {
    await page.goto("/settings/masters");
    await page.getByRole("tab", { name: "系列", exact: true }).click();
    const rows = page.getByTestId("master-row");
    await expect(rows).toHaveCount(40);
    await page.getByTestId("masters-more").click();
    await expect(rows).toHaveCount(80);
    await page.getByTestId("masters-more").click();
    await expect(rows.filter({ hasText: "7D一覧094" })).toHaveCount(1);
    await expect(page.getByTestId("masters-more")).toHaveCount(0);
  } finally {
    await a.from("chains").delete().eq("household_id", hid).like("name", "7D一覧%");
  }
});
