import { createClient } from "@supabase/supabase-js";
import { writeFileSync } from "node:fs";
import sharp from "sharp";
import { expect, test, type Page } from "@playwright/test";

/**
 * コレクションの表示時間の計測（実Supabaseのテスト世帯・架空カード120枚＋サムネイル）。
 *   E2E_SPEC=perf-collection.supabase.spec.ts node scripts/run-e2e-supabase.mjs
 * 計測項目（ページ移動の開始から）:
 *   ui      … 見出し・切替・並び順・登録ボタンが操作できるまで
 *   summary … 購入／買取／枚数の集計行が出るまで
 *   frame   … カードの枠（プレースホルダー含む）が出るまで
 *   firstImg… 最初のカード画像が読み込み完了するまで
 *   allImg  … 画面内のカード画像がすべて読み込み完了するまで
 * 1回目（キャッシュなし）と2回目（再訪問）を比べる。結果は e2e/.results/perf-collection.json に保存する。
 */
const email = process.env.E2E_EMAIL!;
const password = process.env.E2E_PASSWORD!;
const N = 120;
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

async function measure(page: Page, how: "goto" | "spa" | "reload" = "goto") {
  const t0 = Date.now();
  if (how === "goto") await page.goto("/collection", { waitUntil: "commit" });
  else if (how === "reload") await page.reload({ waitUntil: "commit" });
  else await page.locator('[data-nav="collection"]:visible').first().click();
  const since = () => Date.now() - t0;
  const out: Record<string, number> = {};
  await page.getByTestId("add-card").waitFor();
  await page.getByLabel("並び順").first().waitFor();
  out.ui = since();
  await page.getByTestId("collection-summary").waitFor({ timeout: 20_000 }).catch(() => undefined);
  out.summary = since();
  await page.getByTestId("card-tile").first().waitFor({ timeout: 30_000 });
  out.frame = since();
  await page.waitForFunction(() => [...document.querySelectorAll<HTMLImageElement>('[data-testid="card-thumb"] img')].some((i) => i.complete && i.naturalWidth > 0), undefined, { timeout: 30_000 });
  out.firstImg = since();
  await page.waitForFunction(
    () => {
      const imgs = [...document.querySelectorAll<HTMLImageElement>('[data-testid="card-thumb"] img')].filter((i) => {
        const r = i.getBoundingClientRect();
        return r.bottom > 0 && r.top < window.innerHeight;
      });
      return imgs.length > 0 && imgs.every((i) => i.complete && i.naturalWidth > 0);
    },
    undefined,
    { timeout: 30_000 },
  );
  out.allImg = since();
  return out;
}

test("コレクションの表示時間（初回・再訪問）", async ({ page }) => {
  test.setTimeout(240_000);
  await login(page);
  const hid = await household();
  const a = admin();
  const rows: Record<string, unknown>[] = [];
  for (let i = 0; i < N; i++) {
    const hue = (i * 47) % 360;
    const buf = await sharp({ create: { width: 360, height: 504, channels: 3, background: { r: (hue * 3) % 255, g: (hue * 5) % 255, b: (hue * 7) % 255 } } })
      .composite([{ input: Buffer.from(`<svg width="360" height="504"><text x="30" y="260" font-size="60" fill="white">${i}</text></svg>`) }])
      .webp({ quality: 78 })
      .toBuffer();
    const path = `${hid}/perf-${i}-thumb.webp`;
    const up = await a.storage.from("card-images").upload(path, buf, { contentType: "image/webp", upsert: true });
    expect(up.error).toBeNull();
    rows.push({ household_id: hid, name: `計測カード${i}`, card_number: `${i}/120`, set_code: "PF", rarity: "RR", card_type: "", product_name: "計測パック", thumb_path: path, image_path: path, image_sha256: Buffer.from(String(i).padStart(64, "0")).toString("hex").slice(0, 64) });
  }
  const ins = await a.from("card_masters").insert(rows as never);
  expect(ins.error).toBeNull();
  try {
    const first = await measure(page);
    // 再訪問（アプリ内の移動: 別ページへ移ってからメニューで戻る。アプリ内のキャッシュ・ブラウザのキャッシュが効く）
    await page.locator('[data-nav="finance"]:visible').first().click();
    await expect(page.getByRole("heading", { name: "収支" })).toBeVisible();
    const second = await measure(page, "spa");
    // 再読み込み（ブラウザの画像キャッシュだけが効く）
    const third = await measure(page, "reload");
    const result = { cards: N, first, second_spa: second, third_reload: third };
    console.log("PERF " + JSON.stringify(result));
    writeFileSync("e2e/.results/perf-collection.json", JSON.stringify(result, null, 2));
  } finally {
    await a.from("card_masters").delete().eq("household_id", hid).like("name", "計測カード%");
    await a.storage.from("card-images").remove(Array.from({ length: N }, (_, i) => `${hid}/perf-${i}-thumb.webp`));
  }
});
