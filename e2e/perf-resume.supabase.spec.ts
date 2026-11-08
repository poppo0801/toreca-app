import { createClient } from "@supabase/supabase-js";
import { expect, test, type Page } from "@playwright/test";

/**
 * Stage 7D: 画面ごとのメモリ・DOM・イベントリスナーの計測と、バックグラウンド復帰を繰り返したときの増加の確認（実Supabaseのテスト世帯・架空データ）。
 *   E2E_SPEC=perf-resume.supabase.spec.ts npm run test:e2e:supabase
 * 本番のマスター規模（系列60・店舗120・商品55）に近い架空データを入れて、/settings/masters を含む各画面の JS ヒープ・DOM ノード・リスナー数を測る。
 * 復帰（hidden→visible）を10回繰り返してもヒープ・ノード・リスナーが増え続けないこと（リーク・重複登録がないこと）を確認する。
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

interface Metrics {
  heapMB: number;
  nodes: number;
  listeners: number;
  documents: number;
}
async function metrics(page: Page): Promise<Metrics> {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("HeapProfiler.enable");
  await cdp.send("HeapProfiler.collectGarbage");
  await cdp.send("Performance.enable");
  const { metrics: m } = await cdp.send("Performance.getMetrics");
  const get = (n: string) => m.find((x) => x.name === n)?.value ?? 0;
  await cdp.detach();
  return { heapMB: Math.round((get("JSHeapUsedSize") / 1e6) * 10) / 10, nodes: get("Nodes"), listeners: get("JSEventListeners"), documents: get("Documents") };
}
const setVisibility = (page: Page, v: "hidden" | "visible") =>
  page.evaluate((state) => {
    Object.defineProperty(document, "visibilityState", { value: state, configurable: true });
    document.dispatchEvent(new Event("visibilitychange"));
  }, v);

test("画面ごとのメモリ・DOM・リスナー数（マスター本番規模）と、復帰10回での増加", async ({ page }) => {
  test.setTimeout(240_000);
  await page.addInitScript(() => {
    const real = Date.now.bind(Date);
    (window as unknown as { __skew: number }).__skew = 0;
    Date.now = () => real() + (window as unknown as { __skew: number }).__skew;
  });
  await login(page);
  const hid = await household();
  const a = admin();
  const chains = Array.from({ length: 60 }, (_, i) => ({ household_id: hid, name: `P系列${i}` }));
  const cIns = await a.from("chains").insert(chains as never).select("id");
  expect(cIns.error).toBeNull();
  const cids = (cIns.data ?? []).map((c) => c.id as string);
  const stores = Array.from({ length: 120 }, (_, i) => ({ household_id: hid, chain_id: cids[i % cids.length], name: `P店舗${i}`, prefecture: "大阪府", address_optional: `大阪府大阪市中央区${i}-1-1` }));
  expect((await a.from("stores").insert(stores as never)).error).toBeNull();
  const products = Array.from({ length: 55 }, (_, i) => ({ household_id: hid, official_name: `P商品${i} テスト拡張パック`, packs_per_box: 30 }));
  expect((await a.from("products").insert(products as never)).error).toBeNull();
  const out: Record<string, Metrics> = {};
  try {
    for (const [name, path] of [["lotteries", "/lotteries"], ["collection", "/collection"], ["settings", "/settings"], ["masters", "/settings/masters"], ["finance", "/finance"]] as const) {
      await page.goto(path);
      await page.waitForTimeout(2500);
      out[name] = await metrics(page);
    }
    console.log("PERF screens", JSON.stringify(out));

    // マスター画面で復帰を10回繰り返す（hidden→数分→visible）
    await page.goto("/settings/masters");
    await page.waitForTimeout(2500);
    const start = await metrics(page);
    let posts = 0;
    page.on("request", (r) => r.method() === "POST" && !!r.headers()["next-action"] && posts++);
    for (let i = 0; i < 10; i++) {
      await setVisibility(page, "hidden");
      await page.evaluate((d) => void ((window as unknown as { __skew: number }).__skew += d), 5 * 60_000);
      await setVisibility(page, "visible");
      await page.waitForTimeout(1500);
    }
    const end = await metrics(page);
    console.log("PERF resume x10 masters", JSON.stringify({ start, end, posts }));
    expect(end.listeners).toBeLessThanOrEqual(start.listeners + 20); // リスナーが復帰のたびに増え続けない
    expect(end.nodes).toBeLessThanOrEqual(start.nodes * 1.15 + 200); // DOMが増え続けない
    expect(end.heapMB).toBeLessThanOrEqual(start.heapMB * 1.6 + 10); // ヒープが増え続けない
    expect(posts).toBeLessThanOrEqual(12); // 復帰ごとのデータ取得は1回程度（取得の嵐になっていない）
  } finally {
    await a.from("stores").delete().eq("household_id", hid).like("name", "P店舗%");
    await a.from("products").delete().eq("household_id", hid).like("official_name", "P商品%");
    await a.from("chains").delete().eq("household_id", hid).like("name", "P系列%");
  }
});
