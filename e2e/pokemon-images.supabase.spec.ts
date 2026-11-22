import { createClient } from "@supabase/supabase-js";
import { expect, test } from "@playwright/test";

/**
 * ポケモン画像の認証つき配信（非公開バケット pokemon-images。ローカルSupabase・架空の小さな画像）。
 *   事前: docs/sql/pokemon_images_bucket.sql をローカルDBに適用
 *   E2E_SPEC=pokemon-images.supabase.spec.ts npm run test:e2e:supabase
 *  - 未ログイン: 401（画像を返さない）。ログイン後: 自世帯の画像だけ 200・Cache-Control private・webp。無い番号は404、不正な番号は400
 *  - Storage RLS: 他世帯のフォルダ・匿名は読めない。バケットは非公開（公開URLで取得できない）
 */
const email = process.env.E2E_EMAIL!;
const password = process.env.E2E_PASSWORD!;
const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const admin = () => createClient(url, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false, autoRefreshToken: false } });
// 最小のWebP（1x1）
const WEBP = Buffer.from("UklGRhoAAABXRUJQVlA4TA0AAAAvAAAAEAcQERGIiP4HAA==", "base64");

test("ポケモン画像: 認証・世帯の分離・キャッシュ・入力検査", async ({ page, browser }) => {
  test.setTimeout(120_000);
  // ログイン後
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
  const other = "11111111-1111-4111-8111-111111111111";
  const up1 = await a.storage.from("pokemon-images").upload(`${hid}/official/0025.webp`, WEBP, { contentType: "image/webp", upsert: true });
  expect(up1.error?.message).toBeUndefined();
  const up2 = await a.storage.from("pokemon-images").upload(`${other}/official/0025.webp`, WEBP, { contentType: "image/webp", upsert: true });
  expect(up2.error?.message).toBeUndefined();

  // 未ログイン（別のコンテキスト）: 401
  const anon = await browser.newContext();
  const r0 = await anon.request.get("/api/pokemon-image/25");
  expect(r0.headers()["content-type"] ?? "").not.toContain("image/webp"); // ログイン画面への転送（画像は返さない）
  expect((await r0.body()).equals(WEBP)).toBe(false);
  await anon.close();

  const ok = await page.request.get("/api/pokemon-image/25");
  expect(ok.status()).toBe(200);
  expect(ok.headers()["content-type"]).toContain("image/webp");
  expect(ok.headers()["cache-control"]).toContain("private");
  expect(ok.headers()["cache-control"]).not.toContain("public");
  expect((await ok.body()).length).toBe(WEBP.length);
  expect((await page.request.get("/api/pokemon-image/26")).status()).toBe(404); // 無い番号
  expect((await page.request.get("/api/pokemon-image/abc")).status()).toBe(400);
  expect((await page.request.get("/api/pokemon-image/0")).status()).toBe(400);
  expect((await page.request.get("/api/pokemon-image/12345")).status()).toBe(400);
  expect((await page.request.get("/api/pokemon-image/..%2F25")).status()).not.toBe(200); // パス推測

  // Storage RLS: 利用者のセッションで他世帯のフォルダは読めない（自世帯は読める）。匿名・公開URLは不可
  const anonClient = createClient(url, (process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY)!, { auth: { persistSession: false } });
  const signed = await anonClient.auth.signInWithPassword({ email, password });
  expect(signed.error).toBeNull();
  expect((await anonClient.storage.from("pokemon-images").download(`${hid}/official/0025.webp`)).error).toBeNull();
  expect((await anonClient.storage.from("pokemon-images").download(`${other}/official/0025.webp`)).error).not.toBeNull();
  const noauth = createClient(url, (process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY)!, { auth: { persistSession: false } });
  expect((await noauth.storage.from("pokemon-images").download(`${hid}/official/0025.webp`)).error).not.toBeNull();
  const pub = await fetch(`${url}/storage/v1/object/public/pokemon-images/${hid}/official/0025.webp`);
  expect(pub.status).not.toBe(200);
  // 書き込みはできない（アップロードは管理側のみ）
  expect((await anonClient.storage.from("pokemon-images").upload(`${hid}/official/0099.webp`, WEBP, { contentType: "image/webp" })).error).not.toBeNull();

  await a.storage.from("pokemon-images").remove([`${hid}/official/0025.webp`, `${other}/official/0025.webp`]);
});
