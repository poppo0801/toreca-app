import { createClient } from "@supabase/supabase-js";
import { expect, test, type Page } from "@playwright/test";

/**
 * Stage 7F の画面確認（実Supabaseのテスト世帯・架空データ・架空のCSV）。外部サイトには接続しない（CSVはファイルの取り込みで渡す）。
 *   E2E_SPEC=stage7f.supabase.spec.ts npm run test:e2e:supabase
 *  - カード: 手動の価格が無いカードも、取得した相場が上部の集計（買取）に反映される／CSVに無いカードは未取得の印が出る
 *  - BOX: 商品コードで自動照合され、買取（シュリンクあり=基準×100%）が集計に反映される／手動の相場を入れると手動が優先され、取得相場の行は消えない
 *  - 同じCSVを再取込しても、取得相場・取得状況の行は増えない
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
async function swipe(page: Page, dir: "left" | "right") {
  await page.getByTestId("collection-swipe").evaluate((el, d) => {
    const r = el.getBoundingClientRect();
    const y = r.top + 60;
    const [x0, x1] = d === "left" ? [r.left + r.width * 0.8, r.left + r.width * 0.3] : [r.left + r.width * 0.2, r.left + r.width * 0.7];
    const mk = (x: number) => new Touch({ identifier: 1, target: el, clientX: x, clientY: y });
    el.dispatchEvent(new TouchEvent("touchstart", { bubbles: true, cancelable: true, touches: [mk(x0)], changedTouches: [mk(x0)] }));
    el.dispatchEvent(new TouchEvent("touchend", { bubbles: true, cancelable: true, touches: [], changedTouches: [mk(x1)] }));
  }, dir);
}

/** 架空のCSV。解析の下限（100行）を満たすため、無関係な行を並べる */
function csv(): string {
  const head = "shop_key,shop,type,kind,set,no,name,rarity,condition,price_jpy,in_stock,source_url,scraped_at";
  const at = "2026-11-08T06:08+09:00";
  const row = (shop: string, type: string, kind: string, set: string, no: string, name: string, rarity: string, cond: string, price: number, stock = 1) => `${shop},${shop}店,${type},${kind},${set},${no},${name},${rarity},${cond},${price},${stock},https://example.invalid/${shop},${at}`;
  const rows = [
    // カードA: 販売3店舗（1,000／1,200／1,100）・買取1店舗（600）・状態Bの実際の販売1店舗（800）
    row("s1", "single", "sell", "7FTST", "001/100", "7F-カードA", "RR", "", 1000),
    row("s2", "single", "sell", "7FTST", "001/100", "7F-カードA", "RR", "状態A", 1200),
    row("s3", "single", "sell", "7FTST", "001/100", "7F-カードA", "RR", "", 1100),
    row("s1", "single", "sell", "7FTST", "001/100", "7F-カードA", "RR", "状態B", 800),
    row("b1", "single", "buy", "7FTST", "001/100", "7F-カードA", "RR", "", 600),
    // BOX: 商品コードつきの表記と、飾りの語つきの表記。買取は未開封2店舗＋シュリンクなし1店舗。限定版は混ぜない
    row("s1", "box", "sell", "", "", "拡張パック『7F相場BOX』(T7FB)", "", "未開封", 9000),
    row("b1", "box", "buy", "", "", "7F相場BOX", "", "未開封", 5500),
    row("b2", "box", "buy", "", "", "MEGA 拡張パック 7F相場BOX BOX", "", "未開封", 6500),
    row("b1", "box", "buy", "", "", "7F相場BOX", "", "シュリンクなし", 4000),
    row("s2", "box", "sell", "", "", "7F相場BOX(ポケモンセンターセット)", "", "未開封", 20000),
  ];
  for (let i = 0; i < 110; i++) rows.push(row("fill", "single", "sell", "FILL", String(i + 1), `無関係${i}`, "C", "", 100 + i));
  return [`# updated: ${at}`, head, ...rows].join("\n");
}

async function importCsv(page: Page) {
  await page.getByTestId("market-file").setInputFiles({ name: "e2e.csv", mimeType: "text/csv", buffer: Buffer.from(csv(), "utf8") });
  await expect(page.getByTestId("market-result")).toBeVisible({ timeout: 30_000 });
}

test("相場の取得: 手動価格が無いカード・BOXも、取得した相場が集計へ反映される。手動が優先され、再取込で増えない", async ({ page }) => {
  test.setTimeout(150_000);
  await login(page);
  const hid = await household();
  const a = admin();
  const made: { card: string[]; product: string[] } = { card: [], product: [] };
  try {
    const mkCard = async (name: string, set: string, no: string) => {
      const { data, error } = await a.from("card_masters").insert({ household_id: hid, name, card_number: no, set_code: set, rarity: "RR" } as never).select("id").single();
      expect(error?.message).toBeUndefined();
      const id = (data as { id: string }).id;
      made.card.push(id);
      const h = await a.from("card_holdings").insert({ household_id: hid, card_id: id, quantity: 2, condition: "A", source: "e2e" } as never);
      expect(h.error?.message).toBeUndefined();
      return id;
    };
    const cA = await mkCard("7F-カードA", "7FTST", "001/100");
    const cB = await mkCard("7F-カードB", "7FNONE", "009/100");
    const prod = await a.from("products").insert({ household_id: hid, official_name: "7F相場BOX", product_code: "T7FB", packs_per_box: 30 }).select("id").single();
    expect(prod.error).toBeNull();
    const pid = prod.data!.id as string;
    made.product.push(pid);

    // ---- BOXをコレクションに登録（シュリンクあり2BOX・手動の相場なし）
    await page.goto("/collection?tab=box");
    await page.getByTestId("add-card").click();
    const form = page.getByTestId("box-form");
    await form.getByLabel("BOXの商品").fill("7F相場BOX");
    await form.getByRole("option", { name: /7F相場BOX/ }).click();
    await form.getByLabel("シュリンク状態").selectOption("shrink");
    await form.getByLabel("BOXの数量").fill("2");
    await form.getByLabel("実際の購入価格").fill("5400");
    await form.getByTestId("box-dialog-save").click();
    await expect(form).toHaveCount(0);
    await expect(page.getByTestId("box-summary-line")).toContainText("買取 —"); // 相場が無い

    // ---- 相場を更新（CSVの取り込み。外部には接続しない）。BOXタブの相場ダイアログから
    await page.getByTestId("market-update-open").click();
    await page.getByTestId("box-open-market").click();
    await importCsv(page);
    await expect(page.getByTestId("market-box-summary")).toContainText("価格取得 1");
    await expect(page.getByTestId("market-box-summary")).toContainText("自動照合 1");
    await page.keyboard.press("Escape");
    // 買取: 基準(未開封)の中央値 (5,500+6,500)/2=6,000 × シュリンクあり100% × 2BOX = 12,000円
    await expect(page.getByTestId("box-summary-line")).toContainText("買取 12,000円");
    await page.getByTestId("box-tile").filter({ hasText: "7F相場BOX" }).getByRole("button").first().click();
    const detail = page.getByTestId("box-detail");
    const info = detail.getByTestId("box-market-info");
    // 相場詳細の整理（Stage 8U-1）: 主要な金額（買取＝売る価格・販売＝買う価格）を別々に大きく表示し、状態別は折りたたみ。金額・店舗数の検証内容は同じ
    await expect(info.getByTestId("market-buyback-base")).toContainText("6,000円");
    await expect(info.getByTestId("market-buyback-base")).toContainText("2店舗");
    await expect(info.getByTestId("market-buyback-no_shrink")).toContainText("買取・シュリンクなし 4,000円（1店舗のみ）"); // 1店舗だけの価格はそう示す（状態別の折りたたみの中）
    await expect(info.getByTestId("market-sale-base")).toContainText("9,000円"); // ポケモンセンターセット(20,000円)は混ざらない
    await expect(info.getByTestId("market-sale-base")).toContainText("1店舗のみ");
    await expect(info).toContainText("照合: 商品コード");
    await expect(detail.getByTestId("state-shrink")).toContainText("取得相場");
    await page.keyboard.press("Escape");

    // ---- DB: 手動の相場は作られず、取得相場は3種（買取×2・販売×1）
    const dbCount = async () => ({
      boxMarket: (await a.from("box_market_prices").select("id").eq("product_id", pid)).data?.length ?? 0,
      boxManual: (await a.from("box_prices").select("id").eq("product_id", pid)).data?.length ?? 0,
      cardMarket: (await a.from("card_market_prices").select("id").eq("card_id", cA)).data?.length ?? 0,
      status: (await a.from("market_status").select("id").in("subject_id", [cA, cB, pid])).data?.length ?? 0,
      manualCard: (await a.from("card_prices").select("id").in("card_id", [cA, cB])).data?.length ?? 0,
    });
    const first = await dbCount();
    expect(first).toMatchObject({ boxMarket: 3, boxManual: 0, manualCard: 0, status: 3 });
    expect(first.cardMarket).toBeGreaterThanOrEqual(3); // 販売A・買取A・販売B

    // ---- カード: 手動価格が無くても、取得した相場が上部の集計に反映される（買取 600×2=1,200）
    await page.goto("/collection");
    await expect(page.getByTestId("summary-line")).toContainText("1,200円");
    await page.getByTestId("card-tile").first().waitFor();
    const flags = page.getByTestId("price-flag");
    // CSVに無いカードBは未取得の印（一覧は買取参考の横）。詳細で理由を確認できる
    await page.getByRole("button", { name: /7F-カードB/ }).first().click();
    await expect(page.getByTestId("price-state")).toContainText("CSVに対象カードなし");
    await page.keyboard.press("Escape");
    await page.getByRole("button", { name: /7F-カードA/ }).first().click();
    await expect(page.getByTestId("ref-sale")).toContainText("取得");
    await expect(page.getByTestId("ref-sale")).toContainText("3店舗");
    await expect(page.getByTestId("ref-buyback")).toContainText("600円");
    await expect(page.getByTestId("ref-buyback")).toContainText("1店舗のみ");
    await page.keyboard.press("Escape");
    void flags;

    // ---- 同じCSVを再取込しても、行は増えない（5分の間隔制限はCSVの取り込みには掛からない）
    await page.getByTestId("market-update-open").click();
    await importCsv(page);
    await page.keyboard.press("Escape");
    expect(await dbCount()).toEqual(first);

    // ---- BOX: 手動の相場を入れると手動が優先され、取得相場の行はそのまま残る
    await page.goto("/collection?tab=box");
    await page.getByTestId("market-update-open").click();
    const prices = page.getByTestId("box-price-dialog");
    await prices.getByLabel("7F相場BOXの相場").fill("10000");
    await prices.getByTestId("box-dialog-save").click();
    await expect(prices).toHaveCount(0);
    await expect(page.getByTestId("box-summary-line")).toContainText("買取 20,000円");
    expect((await dbCount()).boxMarket).toBe(3);
    await swipe(page, "right");
  } finally {
    await a.from("market_status").delete().in("subject_id", [...made.card, ...made.product]);
    await a.from("card_market_prices").delete().in("card_id", made.card);
    await a.from("card_holdings").delete().in("card_id", made.card);
    await a.from("card_masters").delete().in("id", made.card);
    await a.from("box_market_prices").delete().in("product_id", made.product);
    await a.from("box_market_links").delete().in("product_id", made.product);
    await a.from("market_update_runs").delete().eq("household_id", hid);
  }
});
