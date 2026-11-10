import { createClient } from "@supabase/supabase-js";
import { expect, test, type Page, type Request } from "@playwright/test";

/**
 * Stage 7O: 操作ごとの所要時間・通信回数の実測（実Supabaseのテスト世帯・本番に近い規模の架空データ）。改善の前後で同じ計測を行い比較する。
 *   E2E_SPEC=perf-7o.supabase.spec.ts npm run test:e2e:supabase
 * 計測: 下部メニューのタップ → URLが切り替わるまで（画面の切替）／ → サーバーへの通信（RSC・Server Action・API）の本数と合計時間／ 応募済み・保存の反応と完了、復帰時の通信。
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

interface Net {
  n: number;
  ms: number;
  kind: Record<string, number>;
}
/** ページ内の fetch を記録する（Service Worker 経由でも確実に数える）。静的ファイル・画像は除く */
async function installRecorder(page: Page) {
  await page.addInitScript(() => {
    const w = window as unknown as { __net: { kind: string; ms: number }[]; __long: number[] };
    w.__net = [];
    w.__long = [];
    try {
      new PerformanceObserver((list) => {
        for (const e of list.getEntries()) w.__long.push(Math.round(e.duration));
      }).observe({ entryTypes: ["longtask"] });
    } catch {
      /* 未対応 */
    }
    const real = window.fetch.bind(window);
    window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url, location.href);
      const method = (init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase();
      const skip = url.origin !== location.origin || url.pathname.startsWith("/_next/static") || /\.(png|jpg|jpeg|webp|svg|ico|js|css|woff2?|webmanifest)$/.test(url.pathname) || /^\/api\/(product-image|default-image|chain-logo)/.test(url.pathname);
      const kind = skip ? "" : url.pathname.startsWith("/api/") ? "api" : method === "POST" ? "action" : url.searchParams.has("_rsc") || (init?.headers && JSON.stringify(init.headers).toLowerCase().includes("rsc")) ? "rsc" : "other";
      const t0 = performance.now();
      try {
        return await real(input, init);
      } finally {
        if (kind) w.__net.push({ kind, ms: Math.round(performance.now() - t0) });
      }
    };
  });
  return {
    reset: () =>
      page.evaluate(() => {
        const w = window as unknown as { __net: unknown[]; __long: number[] };
        w.__net.length = 0;
        w.__long.length = 0;
      }),
    /** 直近の reset 以降のメインスレッドの長いタスク（50ms超）の合計・最大 */
    longTasks: () =>
      page.evaluate(() => {
        const l = (window as unknown as { __long: number[] }).__long;
        return { count: l.length, totalMs: l.reduce((a, b) => a + b, 0), maxMs: Math.max(0, ...l) };
      }),
    snapshot: async (): Promise<Net> => {
      const log = await page.evaluate(() => (window as unknown as { __net: { kind: string; ms: number }[] }).__net.slice());
      const kind: Record<string, number> = {};
      for (const l of log) kind[l.kind] = (kind[l.kind] ?? 0) + 1;
      return { n: log.length, ms: log.reduce((x, l) => x + l.ms, 0), kind };
    },
  };
}
const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)] ?? 0;

test("操作ごとの所要時間と通信回数（ページ切替・設定・応募済み・復帰）", async ({ page }) => {
  test.setTimeout(300_000);
  page.setDefaultTimeout(30_000);
  const net = await installRecorder(page);
  await login(page);
  const hid = await household();
  const a = admin();
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Emulation.setCPUThrottlingRate", { rate: 4 }); // CPU 4倍遅い（iPhone相当の目安）
  // 本番に近い規模: 系列60・店舗120・商品55・抽選120（商品・★・応募付き）
  const cIns = await a.from("chains").insert(Array.from({ length: 60 }, (_, i) => ({ household_id: hid, name: `O系列${i}` })) as never).select("id");
  const cids = (cIns.data ?? []).map((c) => c.id as string);
  const sIns = await a.from("stores").insert(Array.from({ length: 120 }, (_, i) => ({ household_id: hid, chain_id: cids[i % cids.length], name: `O店舗${i}`, prefecture: "大阪府" })) as never).select("id,chain_id");
  const pIns = await a.from("products").insert(Array.from({ length: 55 }, (_, i) => ({ household_id: hid, official_name: `O商品${i} 拡張パック`, packs_per_box: 30 })) as never).select("id");
  const pids = (pIns.data ?? []).map((p) => p.id as string);
  const stores = sIns.data ?? [];
  const lots = await a
    .from("lotteries")
    .insert(
      Array.from({ length: 120 }, (_, i) => ({ household_id: hid, chain_id: stores[i % stores.length].chain_id, store_id: stores[i % stores.length].id, apply_deadline_precision: "date_time", apply_deadline_at: new Date(Date.now() + (i + 1) * 86_400_000).toISOString(), receive_method: "store", apply_method: "web", event_state: "open", limit_basis: "account", limit_max_count: 5, source_kind: "manual" })) as never,
    )
    .select("id");
  const lids = (lots.data ?? []).map((l) => l.id as string);
  await a.from("lottery_items").insert(lids.map((id, i) => ({ household_id: hid, lottery_id: id, product_id: pids[i % pids.length], quantity: 1, unit: "box" })) as never);
  await a.from("lottery_management").insert(lids.map((id) => ({ household_id: hid, lottery_id: id, is_managed: true, managed_source: "manual" })) as never);
  const result: Record<string, unknown> = {};
  try {
    const tInit = Date.now();
    await page.goto("/lotteries");
    await expect(page.getByTestId("lottery-card").first()).toBeVisible();
    result.coldStart = { toFirstCardMs: Date.now() - tInit, long: await net.longTasks() };
    await page.waitForTimeout(1500);

    // ---- ページ切替（下部メニュー/「その他」）を2周
    const routes: [string, string][] = [["/purchases", "購入記録"], ["/finance", "収支"], ["/records", "対戦"], ["/collection", "コレクション"], ["/lotteries", "抽選"]];
    const nav: Record<string, number[]> = {};
    const navNet: Record<string, Net[]> = {};
    const navLong: Record<string, { count: number; totalMs: number; maxMs: number }[]> = {};
    for (let round = 0; round < 2; round++) {
      for (const [href] of routes) {
        const link = page.locator(`a[href="${href}"]`).first();
        if (!(await link.isVisible())) continue;
        await net.reset();
        const t0 = Date.now();
        await link.click();
        await page.waitForURL(new RegExp(`${href}$`));
        const tUrl = Date.now() - t0;
        await page.waitForLoadState("networkidle");
        (nav[href] ??= []).push(tUrl);
        (navLong[href] ??= []).push(await net.longTasks());
        (navNet[href] ??= []).push(await net.snapshot());
        await page.waitForTimeout(300);
      }
    }
    result.navigation = Object.fromEntries(Object.entries(nav).map(([k, v]) => [k, { urlMs: median(v), requests: navNet[k].map((n) => `${n.n}本/${n.ms}ms ${JSON.stringify(n.kind)}`)[1], longTasks: navLong[k][1] }]));

    // ---- 設定画面の表示
    await net.reset();
    const t1 = Date.now();
    await page.goto("/settings");
    await expect(page.getByRole("heading", { name: "設定" }).first()).toBeVisible();
    result.settingsDirectLoad = { ms: Date.now() - t1, net: await net.snapshot() };
    await page.goto("/lotteries");
    await expect(page.getByTestId("lottery-card").first()).toBeVisible();
    await net.reset();
    const t2 = Date.now();
    await page.locator('a[href="/settings"]').first().click();
    await page.waitForURL(/\/settings$/);
    result.settingsNav = { urlMs: Date.now() - t2 };
    await page.waitForLoadState("networkidle");
    result.settingsNavNet = await net.snapshot();

    // ---- 応募済みの変更（押してから「応募済み」表示まで）
    await page.goto("/lotteries");
    await expect(page.getByTestId("lottery-card").first()).toBeVisible();
    const times: number[] = [];
    const reactions: number[] = [];
    for (let i = 0; i < 3; i++) {
      await page.waitForLoadState("networkidle");
      // 未応募のカードを1枚選び、押してから「応募済み」の表示になるまでを測る
      const target = page.locator('[data-testid="lottery-card"]').filter({ has: page.locator('[data-testid="my-apply"][data-state="unapplied"]') }).first();
      const id = await target.getAttribute("data-lottery-id");
      const mine = page.locator(`[data-lottery-id="${id}"] [data-testid="my-apply"]`).first();
      await net.reset();
      const s0 = Date.now();
      await mine.click();
      // 反応: ボタンのスピナー（押した直後）→ 保存完了（応募済みの表示）
      await expect(mine.getByTestId("my-apply-spinner")).toBeVisible({ timeout: 5_000 });
      reactions.push(Date.now() - s0);
      await expect(mine).toHaveAttribute("data-state", "applied", { timeout: 15_000 });
      times.push(Date.now() - s0);
      result["apply#" + i + "long"] = await net.longTasks();
      await page.waitForLoadState("networkidle");
      result["apply#" + i + "net"] = await net.snapshot();
    }
    result.applyUiMs = times;
    result.applyReactionMs = reactions;
    // 保存の確認: 応募済みの記録が3件、実際にDBへ保存されている（楽観的な表示だけでなく）
    await expect.poll(async () => ((await a.from("applications").select("id").in("lottery_id", lids).eq("state", "applied")).data ?? []).length, { timeout: 15_000 }).toBe(3);

    // ---- バックグラウンド復帰（hidden→visible）1回あたりの通信
    const vis = (v: "hidden" | "visible") =>
      page.evaluate((state) => {
        Object.defineProperty(document, "visibilityState", { value: state, configurable: true });
        document.dispatchEvent(new Event("visibilitychange"));
        window.dispatchEvent(new Event(state === "visible" ? "focus" : "blur"));
        if (state === "visible") window.dispatchEvent(new PageTransitionEvent("pageshow", { persisted: true }));
      }, v);
    for (const [label, wait] of [["short", 5_000], ["long", 70_000]] as const) {
      await vis("hidden");
      await page.evaluate((ms) => ((window as unknown as { __skew?: number }).__skew = ms), wait);
      await net.reset();
      await vis("visible");
      await page.waitForTimeout(4000);
      result[`resume-${label}`] = await net.snapshot();
    }
    console.log("PERF7O " + JSON.stringify(result, null, 1));
  } finally {
    await a.from("lottery_management").delete().in("lottery_id", lids);
    await a.from("lottery_items").delete().in("lottery_id", lids);
    await a.from("applications").delete().in("lottery_id", lids);
    await a.from("lotteries").delete().in("id", lids);
    await a.from("stores").delete().in("chain_id", cids);
    await a.from("chains").delete().in("id", cids);
    await a.from("products").delete().in("id", pids);
  }
});
