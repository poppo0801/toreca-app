import { createClient } from "@supabase/supabase-js";
import { expect, test, type Page } from "@playwright/test";

/**
 * Stage 8F の画面確認（実Supabaseのテスト世帯・架空データ・モバイル幅）。
 *   E2E_SPEC=stage8f.supabase.spec.ts npm run test:e2e:supabase
 *  - AIのグループ候補: 一覧の先頭に1行のバナー → 確認シート（理由・共通点・異なる点・信頼度）→ 承認で、手動と同じ親カードになる（応募・当選は変わらない）
 *  - AIがまとめたグループ: 詳細に理由・信頼度。外すとき理由を選べる（記録され、提案は「解除された」になる）
 *  - 却下: 却下した候補は消え、記録が残る
 *  ※ 判定そのもの（モックAI・検証層・DB）は、単体・結合テストで検証している。ここでは画面の流れを確認する。
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
async function noHorizontalOverflow(page: Page) {
  const over = await page.evaluate(() => {
    const sc = document.getElementById("app-scroll") ?? document.documentElement;
    return { sw: sc.scrollWidth, cw: sc.clientWidth, dw: document.documentElement.scrollWidth, dcw: document.documentElement.clientWidth };
  });
  expect(over.sw, JSON.stringify(over)).toBeLessThanOrEqual(over.cw + 1);
  expect(over.dw, JSON.stringify(over)).toBeLessThanOrEqual(over.dcw + 1);
}

test("AIのグループ候補の承認・却下／AIがまとめたグループの理由と、外す理由の記録", async ({ page }) => {
  test.setTimeout(300_000);
  page.setDefaultTimeout(20_000);
  await login(page);
  const hid = await household();
  const a = admin();
  const ins = async (table: string, row: Record<string, unknown>) => {
    const { data, error } = await a.from(table).insert(row as never).select("id").single();
    expect(error?.message, table).toBeUndefined();
    return (data as { id: string }).id;
  };
  const day = (n: number) => new Date(Date.now() + n * 86_400_000 + 9 * 3600_000).toISOString().slice(0, 10);
  const { data: profs } = await a.from("profiles").select("id,is_admin").eq("household_id", hid).eq("active", true).order("sort_order");
  const me = profs![0];

  const chain = await ins("chains", { household_id: hid, name: "8F電機" });
  const prod = await ins("products", { household_id: hid, official_name: "8F商品アルファ", packs_per_box: 20 });
  const mkStore = (name: string) => ins("stores", { household_id: hid, chain_id: chain, name, prefecture: "兵庫県" });
  const stores = [await mkStore("8F一号店"), await mkStore("8F二号店"), await mkStore("8F三号店"), await mkStore("8F四号店"), await mkStore("8F五号店")];
  const lotBase = { household_id: hid, chain_id: chain, apply_start_precision: "date_only", apply_start_date: day(-1), apply_deadline_precision: "date_only", apply_deadline_date: day(6), result_precision: "date_only", result_date: day(9), receive_method: "store", apply_method: "web", event_state: "open", limit_basis: "account", limit_max_count: 1, source_kind: "manual", registration_path: "manual" };
  const mkLot = async (store: string, over: Record<string, unknown> = {}) => {
    const id = await ins("lotteries", { ...lotBase, store_id: store, ...over });
    await ins("lottery_items", { household_id: hid, lottery_id: id, product_id: prod, quantity: 1, unit: "box" });
    await a.from("lottery_management").upsert({ lottery_id: id, household_id: hid, is_managed: true, managed_source: "manual" } as never, { onConflict: "lottery_id" });
    return id;
  };
  // 候補A: 3店舗（承認待ち）／候補B: 2店舗（却下する）
  const aIds = [await mkLot(stores[0]), await mkLot(stores[1]), await mkLot(stores[2])];
  const bIds = [await mkLot(stores[3]), await mkLot(stores[4], { apply_deadline_date: day(13) })];
  const prop = (key: string, ids: string[], over: Record<string, unknown>) =>
    ins("lottery_group_proposals", { household_id: hid, proposal_key: key, kind: "new_group", status: "pending", tier: "suggest", subject_lottery_id: ids[0], lottery_ids: ids, engine: "mock-grouping:careful", ...over });
  const pA = await prop(`new_group:e2e-a:3`, aIds, { confidence: 85, rationale: "商品・応募期間・発表日が同じ別店舗の抽選 / 項目はすべて一致しているが、同じ企画であることの裏づけが確認できていない", common: ["系列", "対象商品", "応募期間", "発表日"], mismatches: [], missing: [], evidence: { strongSignals: [], basis: ["区分: 承認候補", "同じ企画の独立した裏づけ: なし", "軽微な違い: 応募条件の一方にだけ記載がある項目がある（記載なし。条件が異なるとは限らない）"], sources: [{ url: "https://example.invalid/8f/event-page-1", fetchedAt: "2026-11-14T00:00:00Z" }] } });
  const pB = await prop(`new_group:e2e-b:2`, bIds, { confidence: 70, rationale: "同じキャンペーンだが、店舗ごとに応募締切が異なる", common: ["系列", "対象商品"], mismatches: [{ field: "applyDeadline", detail: "応募締切が異なる", severity: "hard" }], missing: [], evidence: { strongSignals: ["campaign"] } });

  try {
    await page.goto("/lotteries");
    await page.getByRole("tab", { name: /要チェック/ }).click();

    // ---- 一覧の先頭に1行のバナー（ボタンは増やさない）。開くと候補が理由つきで並ぶ
    const banner = page.getByTestId("group-proposals-open");
    await expect(banner).toBeVisible();
    await expect(banner).toContainText("2件");
    await noHorizontalOverflow(page);
    await banner.click();
    const sheet = page.getByTestId("group-proposals-sheet");
    await expect(sheet.getByTestId("group-proposal")).toHaveCount(2);
    const cardB = sheet.getByTestId("group-proposal").filter({ hasText: "2店舗をグループにまとめる" });
    await expect(cardB.getByTestId("group-proposal-mismatch")).toContainText("応募締切が異なる");
    await expect(cardB.getByTestId("group-proposal-confidence")).toContainText("信頼度 70");
    const cardA = sheet.getByTestId("group-proposal").filter({ hasText: "3店舗をグループにまとめる" });
    await expect(cardA.getByTestId("group-proposal-mismatch")).toHaveCount(0);
    await noHorizontalOverflow(page);
    // 8F-4: 判断の根拠・確認した情報源は、折りたたんだ詳細の中（開いても横にはみ出さない）
    await cardA.locator("details summary").click();
    await expect(cardA.getByTestId("group-proposal-basis")).toContainText("区分: 承認候補");
    await expect(cardA).toContainText("確認した情報源: example.invalid（1件）");
    await noHorizontalOverflow(page);
    await page.screenshot({ path: "docs/screenshots/stage8f-proposals.png" });

    // ---- 却下: 候補が消え、記録が残る（同じ組は再提案されない）。抽選・応募は変わらない
    await cardB.getByTestId("group-proposal-reject").click();
    await expect(sheet.getByTestId("group-proposal")).toHaveCount(1);
    await expect.poll(async () => (await a.from("lottery_group_proposals").select("status").eq("id", pB).single()).data?.status).toBe("rejected");
    await expect.poll(async () => ((await a.from("lotteries").select("bulk_group_id").in("id", bIds)).data ?? []).map((x) => x.bulk_group_id)).toEqual([null, null]);

    // ---- 承認: 手動と同じ親カードになる（店舗別の抽選・応募・当選は変わらない）
    await sheet.getByTestId("group-proposal-approve").click();
    await expect(sheet.getByTestId("group-proposal")).toHaveCount(0);
    await expect.poll(async () => (await a.from("lottery_group_proposals").select("status").eq("id", pA).single()).data?.status).toBe("approved");
    const gid = (await a.from("lotteries").select("bulk_group_id").eq("id", aIds[0]).single()).data!.bulk_group_id as string;
    expect(gid).toBeTruthy();
    expect(((await a.from("lotteries").select("bulk_group_id").in("id", aIds)).data ?? []).every((x) => x.bulk_group_id === gid)).toBe(true);
    expect((await a.from("lottery_bulk_groups").select("origin").eq("id", gid).single()).data?.origin).toBe("ai");
    await page.keyboard.press("Escape");
    await expect(page.getByTestId("group-proposals-open")).toHaveCount(0); // 候補が無ければバナーは消える
    const parent = page.getByTestId("group-card");
    await expect(parent).toHaveCount(1);
    await expect(parent.getByTestId("group-count")).toContainText("0/3");

    // ---- AIがまとめたグループの詳細: 理由・信頼度（折りたたみ）。外すとき理由を選ぶ
    await parent.getByTestId("group-toggle").click(); // 展開すると「グループを管理」が出る（8U-2と同じ）
    await parent.getByTestId("group-manage").click();
    const gs = page.getByTestId("lottery-group-sheet");
    const reason = gs.getByTestId("group-ai-reason");
    await expect(reason).toContainText("AIの提案を承認してまとめました");
    await expect(reason).toContainText("信頼度 85");
    await reason.locator("summary").click();
    await expect(reason).toContainText("商品・応募期間・発表日が同じ別店舗の抽選");
    await noHorizontalOverflow(page);
    await page.screenshot({ path: "docs/screenshots/stage8f-group-reason.png" });
    await gs.getByTestId("group-member").filter({ hasText: "8F三号店" }).getByTestId("group-remove").click();
    await gs.getByTestId("group-remove-reason-conditions_differ").click();
    await expect(gs.getByTestId("group-member")).toHaveCount(2);
    // 理由が記録される: 履歴（wasWith・reason）と、提案が「実行後に解除」になる
    await expect.poll(async () => {
      const ev = (await a.from("lottery_group_events").select("detail").eq("lottery_id", aIds[2]).eq("action", "removed").eq("group_id", gid)).data ?? [];
      return (ev[0]?.detail as { reason?: string } | undefined)?.reason;
    }).toBe("conditions_differ");
    await expect.poll(async () => (await a.from("lottery_group_proposals").select("status,revert_reason").eq("id", pA).single()).data).toMatchObject({ status: "reverted" });
    // 外した抽選・応募・当選の記録は残る（抽選は物理削除されない）
    expect(((await a.from("lotteries").select("id").in("id", aIds)).data ?? []).length).toBe(3);
  } finally {
    await a.from("lottery_group_proposals").delete().eq("household_id", hid);
    await a.from("lottery_group_events").delete().eq("household_id", hid);
    await a.from("lotteries").update({ bulk_group_id: null }).eq("household_id", hid);
    await a.from("lottery_bulk_groups").delete().eq("household_id", hid);
    void me;
  }
});
