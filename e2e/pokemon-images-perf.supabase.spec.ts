import { createClient } from "@supabase/supabase-js";
import { expect, test } from "@playwright/test";

/**
 * ポケモン画像配信の速度の計測（ローカルSupabase・小さな画像）。冷間（1回目）と温間（連続30回）の応答時間と、ブラウザのキャッシュの効き方を出力する。
 *   E2E_SPEC=pokemon-images-perf.supabase.spec.ts npm run test:e2e:supabase
 */
const email = process.env.E2E_EMAIL!;
const password = process.env.E2E_PASSWORD!;
const admin = () => createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false, autoRefreshToken: false } });
const WEBP = Buffer.alloc(8000, 1);

test("画像配信の応答時間", async ({ page }) => {
  test.setTimeout(120_000);
  await page.goto("/login");
  await page.getByLabel("メールアドレス").fill(email);
  await page.getByLabel("パスワード").fill(password);
  await page.getByRole("button", { name: "ログイン" }).click();
  await expect(page).toHaveURL(/\/lotteries$/);
  const a = admin();
  const { data: list } = await a.auth.admin.listUsers({ perPage: 200 });
  const user = list!.users.find((u) => u.email === email)!;
  const { data: hm } = await a.from("household_members").select("household_id").eq("user_id", user.id).limit(1).maybeSingle();
  const hid = hm!.household_id as string;
  for (let n = 1; n <= 30; n++) await a.storage.from("pokemon-images").upload(`${hid}/official/${String(n).padStart(4, "0")}.webp`, WEBP, { contentType: "image/webp", upsert: true });
  const times: number[] = [];
  for (let n = 1; n <= 30; n++) {
    const t0 = Date.now();
    const r = await page.request.get(`/api/pokemon-image/${n}`);
    expect(r.status()).toBe(200);
    await r.body();
    times.push(Date.now() - t0);
  }
  const sorted = [...times].sort((x, y) => x - y);
  console.log(`PERF cold=${times[0]}ms median=${sorted[15]}ms p90=${sorted[27]}ms max=${sorted[29]}ms`);
  const h = (await page.request.get("/api/pokemon-image/1")).headers();
  console.log(`PERF cache-control=${h["cache-control"]}`);
  await a.storage.from("pokemon-images").remove(Array.from({ length: 30 }, (_, i) => `${hid}/official/${String(i + 1).padStart(4, "0")}.webp`));
});
