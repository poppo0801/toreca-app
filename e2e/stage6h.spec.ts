import { createClient } from "@supabase/supabase-js";
import { expect, test, type Page } from "@playwright/test";

/**
 * Stage 6H の画面確認（実Supabaseのテスト世帯・架空データ）。幅 320・375・390・430px で、はみ出し・配置・高さ・内部スクロールを確かめる。
 *   E2E_SPEC=stage6h.spec.ts npm run test:e2e:supabase
 */
const email = process.env.E2E_EMAIL!;
const password = process.env.E2E_PASSWORD!;
const WIDTHS = [320, 375, 390, 430];

async function login(page: Page) {
  await page.goto("/login");
  await page.getByLabel("メールアドレス").fill(email);
  await page.getByLabel("パスワード").fill(password);
  await page.getByRole("button", { name: "ログイン" }).click();
  await expect(page).toHaveURL(/\/lotteries$/);
}

const noOverflow = async (page: Page) => {
  await page.waitForTimeout(450); // 画面遷移のスライド表示（0.2秒）が終わってから測る
  const o = await page.evaluate(() => {
    const cw = document.documentElement.clientWidth;
    const off = [...document.querySelectorAll("body *")]
      .filter((e) => e.getBoundingClientRect().right > cw + 0.5 && e.getBoundingClientRect().width > 0)
      .slice(0, 4)
      .map((e) => `${e.tagName.toLowerCase()}[${e.getAttribute("data-testid") ?? e.className.toString().slice(0, 40)}]`);
    return { sw: document.documentElement.scrollWidth, cw, off };
  });
  expect(o.sw, `横スクロールが出ています（${o.sw} > ${o.cw}）: ${o.off.join(" ")}`).toBeLessThanOrEqual(o.cw);
};

/** テスト世帯に、架空の要手動確認の候補を6件入れる（掃除はテスト世帯ごと） */
async function seedManual(): Promise<void> {
  const admin = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false, autoRefreshToken: false } });
  const { data: list } = await admin.auth.admin.listUsers({ perPage: 200 });
  const user = list?.users.find((u) => u.email === email);
  if (!user) throw new Error("test user not found");
  const { data: hm } = await admin.from("household_members").select("household_id").eq("user_id", user.id).limit(1).maybeSingle();
  if (!hm) throw new Error("household not found");
  const due = new Date(Date.now() + 2 * 86_400_000).toISOString();
  const rows = [1, 2, 3, 4, 5, 6].map((i) => ({
    household_id: hm.household_id,
    dedupe_key: `x:6h-e2e-${i}`,
    title: `テスト候補${i}`,
    source_url: `https://example.invalid/6h/${i}`,
    status: "pending",
    job_state: "review",
    kind: "new",
    triage: "manual",
    manual_state: "open",
    manual_reason: "店舗を特定できません",
    manual_since: new Date().toISOString(),
    due_at: due,
    reasons: ["店舗を特定できません"],
    draft: { input: { chain: { id: null, name: `テスト系列${i}` }, store: { id: null, name: `テスト${i}店`, prefecture: "" }, items: [{ product: { id: null, name: "テスト拡張パック" } }], applyDeadline: { precision: "date_only", date: due.slice(0, 10), time: "" } } },
  }));
  const { error } = await admin.from("collection_candidates").insert(rows as never);
  if (error) throw new Error("seed: " + JSON.stringify(error));
}

test.describe("Stage 6H 画面", () => {
  test("抽選一覧: 全情報タブは2行（上=名称／下=件数）で、全タブが同じ高さ。幅によらずはみ出さない", async ({ page }) => {
    await login(page);
    for (const w of WIDTHS) {
      await page.setViewportSize({ width: w, height: 800 });
      await page.reload();
      const tabs = page.getByRole("tab");
      await expect(tabs).toHaveCount(4);
      const boxes = await tabs.evaluateAll((els) => els.map((e) => e.getBoundingClientRect().height));
      expect(new Set(boxes.map((h) => Math.round(h))).size, `タブの高さがそろっていません ${boxes}`).toBe(1);
      const all = page.getByRole("tab", { name: /全情報/ });
      const label = await all.locator("span.inline-flex").first().boundingBox();
      const count = await page.getByTestId("tab-count-all").boundingBox();
      expect(label && count && count.y >= label.y + label.height - 1, `件数が名称の下にありません（w=${w}）`).toBeTruthy();
      await noOverflow(page);
      if (w === 375) await page.screenshot({ path: "docs/screenshots/stage6h-tabs-375.png", clip: { x: 0, y: 0, width: 375, height: 260 } });
    }
  });

  test("コレクション: 右上に［相場更新］［登録］。押しやすい高さで、見出しと重ならない", async ({ page }) => {
    await login(page);
    await page.goto("/collection");
    for (const w of WIDTHS) {
      await page.setViewportSize({ width: w, height: 800 });
      const market = page.getByTestId("market-update-open");
      const add = page.getByTestId("add-card");
      await expect(market).toBeVisible();
      await expect(add).toBeVisible();
      const m = (await market.boundingBox())!;
      const a = (await add.boundingBox())!;
      expect(m.x + m.width, "相場更新は登録の左").toBeLessThanOrEqual(a.x + 1);
      expect(m.height).toBeGreaterThanOrEqual(40);
      expect(a.height).toBeGreaterThanOrEqual(40);
      expect(a.x + a.width, "画面の右端に収まる").toBeLessThanOrEqual(w);
      const h1 = (await page.locator("h1").first().boundingBox())!;
      expect(h1.x + h1.width, "見出しとボタンが重ならない").toBeLessThanOrEqual(m.x + 1);
      await noOverflow(page);
      if (w === 375) await page.screenshot({ path: "docs/screenshots/stage6h-collection-375.png", clip: { x: 0, y: 0, width: 375, height: 220 } });
    }
    await page.getByTestId("market-update-open").click();
    await expect(page.getByTestId("market-run")).toBeVisible();
    await expect(page.getByTestId("more-menu")).toBeVisible();
  });

  test("自動収集: 収集候補は初期に閉じ、要手動確認は約3件の高さで内部スクロール（画面全体と競合しない）", async ({ page }) => {
    await login(page);
    await seedManual(); // 世帯はログイン時に作られるため、ログイン後に入れる
    await page.goto("/settings/collection");
    for (const w of WIDTHS) {
      await page.setViewportSize({ width: w, height: 800 });
      await page.reload();
      await expect(page.getByTestId("candidates")).toHaveAttribute("data-open", "false");
      await expect(page.getByTestId("candidates-summary")).toContainText("候補");
      await noOverflow(page);
      const list = page.getByTestId("manual-scroll").first();
      await expect(list).toBeVisible();
      const m = await list.evaluate((el) => ({ ch: el.clientHeight, sh: el.scrollHeight, rows: el.querySelectorAll('[data-testid="manual-row"]').length }));
      expect(m.rows).toBe(6);
      expect(m.ch, "約3件分（216px以下）に制限").toBeLessThanOrEqual(220);
      expect(m.sh, "内部で縦スクロールできる").toBeGreaterThan(m.ch);
      // 見出し・件数は一覧の外
      await expect(page.getByTestId("manual-banner")).toBeVisible();
      // 一覧の上でホイール → 一覧の中がスクロールし、画面全体は動かない
      await list.scrollIntoViewIfNeeded();
      const y0 = await page.evaluate(() => document.getElementById("app-scroll")!.scrollTop);
      const box = (await list.boundingBox())!;
      await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
      await page.mouse.wheel(0, 80);
      await expect.poll(async () => list.evaluate((el) => el.scrollTop)).toBeGreaterThan(0);
      expect(await page.evaluate(() => document.getElementById("app-scroll")!.scrollTop)).toBe(y0);
      // 詳細・対応（詳細への移動）はそのまま使える
      await list.locator('[data-testid="manual-detail"]').first().click();
      await expect(page.getByTestId("manual-detail-panel")).toBeVisible();
      if (w === 375) await page.screenshot({ path: "docs/screenshots/stage6h-manual-375.png" });
    }
    // 収集候補を開くと従来の操作が使える（タブ・一覧）
    await page.getByTestId("candidates-toggle").click();
    await expect(page.getByTestId("candidates")).toHaveAttribute("data-open", "true");
    await expect(page.getByTestId("cand-tab-pending")).toBeVisible();
  });
});
