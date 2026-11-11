import { createClient } from "@supabase/supabase-js";
import { expect, test, type Page } from "@playwright/test";

/**
 * Stage 7R: 設定画面（マスター管理・自動収集）の表示時間の実測（実Supabaseのテスト世帯・本番に近い規模の架空データ）。改善の前後で同じ計測を行い比較する。
 *   E2E_SPEC=perf-7r.supabase.spec.ts npm run test:e2e:supabase
 * 計測: 設定画面からのリンクのタップ → URL切替(urlMs)／ 画面の主要な要素が出るまで(readyMs)／ 受信したデータ量。CPU 4倍遅い条件。
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
const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)] ?? 0;
const fat = (i: number) => ({
  input: { chain: { name: `P系列${i % 30}` }, store: { name: `P店${i}` }, items: [{ product: { name: `P商品${i % 20}` } }], applyDeadline: { precision: "date_only", date: "2026-12-01" } },
  fields: { body: "x".repeat(3600) },
  xpost: { text: "y".repeat(1000) },
  evidence: { e: "z".repeat(950) },
  reeval: [{ t: "r".repeat(500) }],
  listInfo: { l: "l".repeat(320) },
  flags: {},
  summary: { chain: "exact", store: "exact", items: [] },
});

test("設定画面の表示時間（マスター管理・自動収集）", async ({ page }) => {
  test.setTimeout(400_000);
  page.setDefaultTimeout(40_000);
  await login(page);
  const hid = await household();
  const a = admin();
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Emulation.setCPUThrottlingRate", { rate: 4 });
  const cIns = await a.from("chains").insert(Array.from({ length: 60 }, (_, i) => ({ household_id: hid, name: `P系列${i}` })) as never).select("id");
  const cids = (cIns.data ?? []).map((c) => c.id as string);
  await a.from("stores").insert(Array.from({ length: 120 }, (_, i) => ({ household_id: hid, chain_id: cids[i % cids.length], name: `P店舗${i}`, prefecture: "大阪府", address_optional: "大阪府大阪市北区梅田1-1-1 ".repeat(3), memo: "メモ".repeat(40) })) as never);
  await a.from("products").insert(Array.from({ length: 55 }, (_, i) => ({ household_id: hid, official_name: `P商品${i} 拡張パック`, packs_per_box: 30 })) as never);
  const statuses = ["excluded", "duplicate", "auto_registered", "excluded", "duplicate"];
  const rows = Array.from({ length: 1000 }, (_, i) => ({ household_id: hid, dedupe_key: `https://p7r.example.invalid/${i}`, source_url: `https://p7r.example.invalid/${i}`, title: `P候補${i}`, status: statuses[i % 5], job_state: statuses[i % 5] === "excluded" ? "skipped" : "completed", kind: "new", reasons: ["架空"], draft: fat(i), resolved_at: new Date(Date.now() - (i % 40) * 86_400_000).toISOString() }));
  for (let i = 0; i < rows.length; i += 200) expect((await a.from("collection_candidates").insert(rows.slice(i, i + 200) as never)).error).toBeNull();
  const result: Record<string, unknown> = {};
  try {
    for (const [name, href, ready] of [
      ["masters", "/settings/masters", '[data-testid="master-search"], [role="tablist"]'],
      ["collection", "/settings/collection", 'text=動作状況'],
    ] as const) {
      const urls: number[] = [];
      const readys: number[] = [];
      const bytes: number[] = [];
      for (let round = 0; round < 3; round++) {
        await page.goto("/settings");
        await expect(page.getByRole("heading", { name: "設定" }).first()).toBeVisible();
        await page.waitForLoadState("networkidle");
        let recv = 0;
        const onResp = async (r: import("@playwright/test").Response) => {
          if (new URL(r.url()).origin === new URL(page.url()).origin && !/\/_next\/static|\.(png|jpg|svg|ico|woff2?)$/.test(r.url())) recv += Number((await r.headerValue("content-length")) ?? 0) || (await r.body().catch(() => Buffer.alloc(0))).length;
        };
        page.on("response", onResp);
        const t0 = Date.now();
        await page.locator(`a[href="${href}"]`).first().click();
        await page.waitForURL(new RegExp(`${href}$`));
        urls.push(Date.now() - t0);
        await page.locator(ready).first().waitFor({ state: "visible" });
        // 読み込み表示ではなく本体が出るまで（スケルトンの role=status が消える）
        await expect(page.locator('[role="status"][aria-label="読み込み中"]')).toHaveCount(0);
        readys.push(Date.now() - t0);
        await page.waitForLoadState("networkidle");
        page.off("response", onResp);
        bytes.push(recv);
      }
      result[name] = { urlMs: median(urls), readyMs: median(readys), urlAll: urls, readyAll: readys, receivedBytesMedian: median(bytes) };
    }
    console.log("PERF7R " + JSON.stringify(result));
  } finally {
    await a.from("collection_candidates").delete().like("dedupe_key", "https://p7r.example.invalid/%");
    await a.from("stores").delete().in("chain_id", cids);
    await a.from("chains").delete().in("id", cids);
    await a.from("products").delete().like("official_name", "P商品%");
  }
});
