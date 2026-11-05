import { createClient } from "@supabase/supabase-js";
import { expect, test, type CDPSession, type Page } from "@playwright/test";
import { writeFileSync, mkdirSync } from "node:fs";

/**
 * Stage 6J の画面確認（実Supabaseのテスト世帯・架空データ）。幅 320・375・390・430px。
 *   E2E_SPEC=stage6j.spec.ts npm run test:e2e:supabase
 */
const email = process.env.E2E_EMAIL!;
const password = process.env.E2E_PASSWORD!;
const WIDTHS = [320, 375, 390, 430];

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

const FLEX = { precision: "unknown", date: "", time: "" };
/** AI解析済みの草稿と同じ形の入力（編集フォームが読むすべての項目） */
const fullInput = (i: number, prefix: string, due: string) => ({
  chain: { id: null, name: `6J系列${prefix}${i}` },
  store: { id: null, name: `6J${prefix}${i}店`, prefecture: "" },
  multiMode: "single",
  campaignId: null,
  newCampaign: null,
  items: [{ product: { id: null, name: "テスト拡張パック" }, quantity: 1, unit: "box" }],
  applyStart: FLEX,
  applyDeadline: { precision: "date_only", date: due.slice(0, 10), time: "" },
  resultDate: FLEX,
  resultEndDate: "",
  procedureStart: FLEX,
  procedureDeadline: FLEX,
  procedureSplit: false,
  lotteryKind: "normal",
  validUntil: "",
  receiveMethod: "store",
  applyMethod: "web",
  conditionsText: "",
  verificationText: "",
  announcementMethod: "",
  announcementMethods: [],
  announcementTarget: "",
  announcementInferred: false,
  requirementTags: [],
  requirementLogic: "and",
  requirementDetails: {},
  announcementUrl: "",
  sourceUrls: [],
  eventState: "open",
  limitBasis: "account",
  limitMaxCount: 1,
  memo: "",
  isManaged: true,
  applications: [],
  appliedAt: "",
});

/** 候補を入れる。manual=要手動確認、そうでなければ通常の確認待ち（review） */
async function seed(hid: string, n: number, kind: "manual" | "review", prefix: string): Promise<void> {
  const due = new Date(Date.now() + 2 * 86_400_000).toISOString();
  const rows = Array.from({ length: n }, (_, k) => {
    const i = k + 1;
    return {
      household_id: hid,
      dedupe_key: `x:6j-${prefix}-${i}`,
      title: `6J候補${prefix}${i}`,
      source_url: `https://example.invalid/6j/${prefix}/${i}`,
      status: "pending",
      job_state: "review",
      kind: "new",
      ...(kind === "manual" ? { triage: "manual", manual_state: "open", manual_reason: "店舗を特定できません", manual_since: new Date().toISOString() } : {}),
      due_at: due,
      reasons: ["確認待ち"],
      draft: { input: fullInput(i, prefix, due) },
    };
  });
  const { error } = await admin().from("collection_candidates").insert(rows as never);
  if (error) throw new Error("seed: " + JSON.stringify(error));
}

const noOverflow = async (page: Page) => {
  await page.waitForTimeout(450);
  const o = await page.evaluate(() => {
    const cw = document.documentElement.clientWidth;
    const off = [...document.querySelectorAll("body *")].filter((e) => e.getBoundingClientRect().right > cw + 0.5 && e.getBoundingClientRect().width > 0).slice(0, 4).map((e) => `${e.tagName.toLowerCase()}[${e.getAttribute("data-testid") ?? e.className.toString().slice(0, 40)}]`);
    return { sw: document.documentElement.scrollWidth, cw, off };
  });
  expect(o.sw, `横スクロールが出ています（${o.sw} > ${o.cw}）: ${o.off.join(" ")}`).toBeLessThanOrEqual(o.cw);
};

/** 実機と同じ「タッチ」で横にスワイプする（Chromium の CDP。pointerType=touch になる） */
async function touchSwipe(cdp: CDPSession, page: Page, x: number, y: number, dx: number, dy = 0) {
  await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x, y }] });
  const steps = 8;
  for (let i = 1; i <= steps; i++) {
    await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x: x + (dx * i) / steps, y: y + (dy * i) / steps }] });
    await page.waitForTimeout(8);
  }
  await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
}

test.describe("Stage 6J 画面", () => {
  test("下部メニュー: 幅によらず表示領域の下端に接し、ページ全体はスクロールしない。スクロールしてもメニュー・ヘッダーは動かない", async ({ page }) => {
    await login(page);
    for (const w of WIDTHS) {
      await page.setViewportSize({ width: w, height: 800 });
      await page.reload();
      const nav = page.getByTestId("bottom-nav");
      await expect(nav).toBeVisible();
      const vpBottom = await page.evaluate(() => window.innerHeight);
      const n0 = (await nav.boundingBox())!;
      expect(Math.abs(n0.y + n0.height - vpBottom), `下端に接していません（w=${w}）`).toBeLessThan(1.5);
      const h0 = (await page.locator("header").boundingBox())!;
      const m = await page.evaluate(() => {
        const s = document.getElementById("app-scroll")!;
        const de = document.documentElement;
        return { docScrollable: de.scrollHeight > de.clientHeight + 1, innerScrollable: s.scrollHeight > s.clientHeight };
      });
      expect(m.docScrollable).toBe(false);
      await page.evaluate(() => { const s = document.getElementById("app-scroll")!; s.scrollTo(0, s.scrollHeight); });
      await page.waitForTimeout(80);
      expect(await nav.boundingBox()).toEqual(n0);
      expect(await page.locator("header").boundingBox()).toEqual(h0);
      // 表示領域が低くなっても（起動直後の低い状態・キーボードの模擬）、メニューは追従して下端に接し続ける
      await page.setViewportSize({ width: w, height: 800 - 59 });
      await page.waitForTimeout(80);
      const n1 = (await nav.boundingBox())!;
      expect(Math.abs(n1.y + n1.height - (800 - 59))).toBeLessThan(1.5);
      await noOverflow(page);
      void m.innerScrollable;
      if (w === 375) await page.screenshot({ path: "docs/screenshots/stage6j-nav-375.png" });
    }
  });

  test("赤丸バッジはタブ名の左（文字に重ねない）。全タブで位置がそろう", async ({ page }) => {
    await login(page);
    for (const w of WIDTHS) {
      await page.setViewportSize({ width: w, height: 800 });
      await page.reload();
      const tabs = page.getByRole("tab");
      await expect(tabs).toHaveCount(4);
      const boxes = await tabs.evaluateAll((els) => els.map((e) => e.getBoundingClientRect().height));
      expect(new Set(boxes.map((h) => Math.round(h))).size).toBe(1);
      for (const dot of await page.locator('[data-testid^="tab-dot-"]').all()) {
        const d = (await dot.boundingBox())!;
        const row = (await dot.locator("xpath=..").boundingBox())!;
        expect(d.x + d.width).toBeLessThanOrEqual(row.x + row.width / 2);
      }
      await noOverflow(page);
    }
  });

  test("要手動確認と収集候補: 直接編集・スワイプ・ページ切替（実際のタッチ操作）", async ({ page }) => {
    await login(page);
    const hid = await household();
    await seed(hid, 4, "manual", "m");
    await seed(hid, 25, "review", "r");
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto("/settings/collection");
    const cdp = await page.context().newCDPSession(page);

    // --- 要手動確認 → 編集して登録: 収集候補を開かずに編集フォームが直接開く。キャンセルで元の画面に戻る
    await expect(page.getByTestId("manual-row").first()).toBeVisible();
    await page.getByTestId("manual-detail").first().click();
    await page.getByTestId("manual-edit").first().click();
    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible();
    await expect(page.getByTestId("candidates")).toHaveAttribute("data-open", "false");
    await expect(dialog.locator('input[value^="6J"], textarea').first()).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(dialog).toHaveCount(0);
    await expect(page.getByTestId("manual-review")).toBeVisible();

    // --- 右スワイプで編集フォーム（詳細パネルを閉じた行の、上部の見出し部分から）
    await page.getByTestId("manual-detail").first().click();
    const row = page.getByTestId("manual-row").first();
    await row.scrollIntoViewIfNeeded();
    const rb = (await row.boundingBox())!;
    await touchSwipe(cdp, page, rb.x + 30, rb.y + 14, 140);
    await expect(page.getByRole("dialog")).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.getByRole("dialog")).toHaveCount(0);

    // --- 左スワイプで除外: 直ちに一覧と件数から消え、候補は物理削除されずに「除外」になる
    const banner = page.getByTestId("manual-banner");
    const before = await page.getByTestId("manual-row").count();
    const rb2 = (await page.getByTestId("manual-row").first().boundingBox())!;
    const t0 = Date.now();
    await touchSwipe(cdp, page, rb2.x + rb2.width - 40, rb2.y + rb2.height / 2, -150);
    await expect(page.getByTestId("manual-row")).toHaveCount(before - 1, { timeout: 2000 });
    const tHide = Date.now() - t0;
    await expect(banner).toContainText(`${before - 1}件`);
    // 縦スクロールは除外にならない
    const rb3 = (await page.getByTestId("manual-row").first().boundingBox())!;
    await touchSwipe(cdp, page, rb3.x + 100, rb3.y + 20, 6, -60);
    await page.waitForTimeout(300);
    await expect(page.getByTestId("manual-row")).toHaveCount(before - 1);
    await expect.poll(async () => (await admin().from("collection_candidates").select("id,status,manual_state").eq("household_id", hid).like("dedupe_key", "x:6j-m-%")).data?.filter((r) => r.status === "excluded").length).toBe(1);
    expect((await admin().from("collection_candidates").select("id").eq("household_id", hid).like("dedupe_key", "x:6j-m-%")).data).toHaveLength(4); // 物理削除なし

    // --- 収集候補: ページ切替（10件/ページ）
    await page.getByTestId("candidates-toggle").click();
    await expect(page.getByTestId("candidate-row")).toHaveCount(10);
    await expect(page.getByTestId("page-info")).toContainText(/1 \/ 3 ページ/);
    await page.getByTestId("page-next").click();
    await expect(page.getByTestId("page-info")).toContainText(/2 \/ 3 ページ/);
    await expect(page.getByTestId("candidate-row")).toHaveCount(10);
    // 2ページ目で左スワイプ除外 → 2ページ目に留まり、件数が直ちに減る
    const countBefore = Number(await page.getByTestId("cand-count-pending").innerText());
    const cr = page.getByTestId("candidate-row").first();
    await cr.scrollIntoViewIfNeeded();
    const cb = (await cr.boundingBox())!;
    await touchSwipe(cdp, page, cb.x + cb.width - 40, cb.y + 20, -150);
    await expect(page.getByTestId("cand-count-pending")).toHaveText(String(countBefore - 1), { timeout: 2000 });
    await expect(page.getByTestId("page-info")).toContainText(/2 \/ 3 ページ/);
    // 右スワイプで編集フォーム
    const cr2 = page.getByTestId("candidate-row").first();
    const cb2 = (await cr2.boundingBox())!;
    await touchSwipe(cdp, page, cb2.x + 30, cb2.y + 20, 150);
    await expect(page.getByRole("dialog")).toBeVisible();
    await page.keyboard.press("Escape");
    for (const w of WIDTHS) {
      await page.setViewportSize({ width: w, height: 800 });
      await noOverflow(page);
    }
    void tHide;
    await page.setViewportSize({ width: 390, height: 844 });
    await page.screenshot({ path: "docs/screenshots/stage6j-candidates-390.png" });
    writeResult("swipe", { manualExcludeToHiddenMs: tHide });
  });

  test("起動時ポップアップ: 対象プロフィール(固定ID)だけに表示。ボタンは2つだけで、押すと直接移動する（遷移時間を計測）", async ({ page }) => {
    await login(page);
    const hid = await household();
    const a = admin();
    const { data: profs } = await a.from("profiles").select("id,label").eq("household_id", hid).order("sort_order");
    const mine = profs!.find((p) => p.label === "A")!;
    const other = profs!.find((p) => p.label === "B")!;
    await seed(hid, 2, "manual", "n");
    await a.from("collection_runs").insert({ household_id: hid, trigger: "cron", status: "done", started_at: new Date().toISOString(), finished_at: new Date().toISOString(), new_count: 2 } as never);
    const settings = async (id: string | null) => {
      const cur = await a.from("collection_settings").select("id").eq("household_id", hid).limit(1).maybeSingle();
      if (cur.data) await a.from("collection_settings").update({ result_notice_profile_id: id } as never).eq("id", cur.data.id);
      else await a.from("collection_settings").insert({ household_id: hid, result_notice_profile_id: id } as never);
    };
    // 1) 対象が別のプロフィール(B)のとき、現在のプロフィール(A)には表示しない
    await settings(other.id);
    await page.evaluate(() => sessionStorage.clear());
    await page.goto("/lotteries");
    await expect(page.getByRole("tablist", { name: "抽選の表示切替" })).toBeVisible();
    await page.waitForTimeout(800);
    await expect(page.getByTestId("run-notice")).toHaveCount(0);
    // 2) 対象がAのとき表示される。ボタンは「確認する」「閉じる」の2つだけ
    await settings(mine.id);
    await page.evaluate(() => sessionStorage.clear());
    await page.goto("/lotteries");
    const notice = page.getByTestId("run-notice");
    await expect(notice).toBeVisible();
    // 操作ボタンは「閉じる」「確認する」の2つだけ（案件ごとの「元情報」リンクは情報の一部。詳細・登録された抽選・確認待ちへ等のボタンは無い）
    const buttons = await notice.locator("button, a").evaluateAll((els) => els.map((e) => (e.textContent ?? "").trim()).filter((t) => t && t !== "Close" && !t.startsWith("元情報")));
    expect(buttons).toEqual(["閉じる", "確認する"]);
    // 3) 確認する → すぐ閉じて要手動確認へ。遷移の時間を計測する
    const t0 = Date.now();
    await page.getByTestId("run-notice-confirm").click();
    await expect(notice).toHaveCount(0);
    const tClose = Date.now() - t0;
    await page.waitForURL(/\/settings\/collection/);
    const tUrl = Date.now() - t0;
    await expect(page.getByTestId("manual-review").or(page.getByTestId("collection-loading"))).toBeVisible();
    const tFirst = Date.now() - t0;
    await expect(page.getByTestId("manual-review")).toBeVisible();
    const tFull = Date.now() - t0;
    writeResult("popup", { closeMs: tClose, urlChangedMs: tUrl, firstContentMs: tFirst, fullMs: tFull });
    expect(tClose).toBeLessThan(600);
    // 同じ起動中は繰り返し表示しない
    await page.goto("/lotteries");
    await page.waitForTimeout(800);
    await expect(page.getByTestId("run-notice")).toHaveCount(0);
    await settings(null);
  });

  test("起動の計測: 最初のHTML(ロード画面)が届くまでの時間と、画面が出るまでの時間", async ({ page, context }) => {
    await login(page);
    const cookies = await context.cookies();
    const results: Record<string, number>[] = [];
    for (let i = 0; i < 3; i++) {
      const p = await context.newPage();
      await context.addCookies(cookies);
      const t0 = Date.now();
      await p.goto("/lotteries", { waitUntil: "commit" });
      const tCommit = Date.now() - t0;
      await p.getByTestId("splash").or(p.getByRole("tablist", { name: "抽選の表示切替" })).first().waitFor();
      const tFirstVisual = Date.now() - t0;
      await p.getByRole("tablist", { name: "抽選の表示切替" }).waitFor({ timeout: 20_000 });
      const tContent = Date.now() - t0;
      const nav = await p.evaluate(() => {
        const n = performance.getEntriesByType("navigation")[0] as PerformanceNavigationTiming;
        const fcp = performance.getEntriesByName("first-contentful-paint")[0]?.startTime ?? 0;
        return { ttfb: Math.round(n.responseStart), domContentLoaded: Math.round(n.domContentLoadedEventEnd), fcp: Math.round(fcp) };
      });
      results.push({ commitMs: tCommit, firstVisualMs: tFirstVisual, contentMs: tContent, ...nav });
      await p.close();
    }
    writeResult("startup", { runs: results });
    expect(results[0].contentMs).toBeLessThan(15_000);
  });
});

function writeResult(name: string, data: Record<string, unknown>) {
  mkdirSync("e2e/.results", { recursive: true });
  writeFileSync(`e2e/.results/stage6j-${name}.json`, JSON.stringify(data, null, 2));
  console.log(`[stage6j:${name}] ${JSON.stringify(data)}`);
}
