import { createClient } from "@supabase/supabase-js";
import { expect, test, type Page } from "@playwright/test";

/**
 * Stage 8U-1 / 8U-2 の画面確認（実Supabaseのテスト世帯・架空データ。モバイル幅）。
 *   E2E_SPEC=stage8u.supabase.spec.ts npm run test:e2e:supabase
 *  - 8U-2: 複数店舗抽選の親カード（初期は閉じる・件数・展開・子の応募が親の応募済み件数へ反映・グループ管理: 外す/解除）
 *  - 8U-1: シリアルコード応募のバッジ・除外の理由選択・抽選候補ヘッダーの絞り込みボタン・候補の編集の一時保存（閉じても破棄の確認なし）
 *  - 他店舗に複製: 新しい店舗を追加して複製・1グループ化
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
/** 横スクロール（ページ全体のはみ出し）が無いこと */
async function noHorizontalOverflow(page: Page) {
  const over = await page.evaluate(() => {
    const sc = document.getElementById("app-scroll") ?? document.documentElement;
    return { sw: sc.scrollWidth, cw: sc.clientWidth, dw: document.documentElement.scrollWidth, dcw: document.documentElement.clientWidth };
  });
  expect(over.sw, JSON.stringify(over)).toBeLessThanOrEqual(over.cw + 1);
  expect(over.dw, JSON.stringify(over)).toBeLessThanOrEqual(over.dcw + 1);
}

test("複数店舗抽選のグループ（親カード・展開・子の応募の反映・管理）／シリアル／除外の理由／複製", async ({ page }) => {
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
  const { data: profs } = await a.from("profiles").select("id,label,is_admin").eq("household_id", hid).eq("active", true).order("sort_order");
  const me = profs![0];
  const wasAdmin = me.is_admin;

  const chain = await ins("chains", { household_id: hid, name: "8U電機" });
  const prodA = await ins("products", { household_id: hid, official_name: "8U商品アルファ", packs_per_box: 20 });
  const prodB = await ins("products", { household_id: hid, official_name: "8U商品ベータ", packs_per_box: 20 });
  const stores = [await ins("stores", { household_id: hid, chain_id: chain, name: "8U一号店", prefecture: "兵庫県" }), await ins("stores", { household_id: hid, chain_id: chain, name: "8U二号店", prefecture: "兵庫県" }), await ins("stores", { household_id: hid, chain_id: chain, name: "8U三号店", prefecture: "大阪府" })];
  const solo = await ins("stores", { household_id: hid, chain_id: chain, name: "8U単独店", prefecture: "兵庫県" });
  const lotBase = { household_id: hid, chain_id: chain, apply_start_precision: "date_only", apply_start_date: day(-1), apply_deadline_precision: "date_only", apply_deadline_date: day(6), result_precision: "date_only", result_date: day(9), receive_method: "store", apply_method: "web", event_state: "open", limit_basis: "account", limit_max_count: 1, source_kind: "manual", registration_path: "manual" };
  const mkLot = async (store: string, over: Record<string, unknown> = {}) => {
    const id = await ins("lotteries", { ...lotBase, store_id: store, ...over });
    await ins("lottery_items", { household_id: hid, lottery_id: id, product_id: prodA, quantity: 1, unit: "box" });
    await a.from("lottery_management").upsert({ lottery_id: id, household_id: hid, is_managed: true, managed_source: "manual" } as never, { onConflict: "lottery_id" });
    return id;
  };
  const grp = await ins("lottery_bulk_groups", { household_id: hid, op_id: crypto.randomUUID(), chain_id: chain, store_count: 3, origin: "manual", basis: { by: "e2e" } });
  const kids = [await mkLot(stores[0], { bulk_group_id: grp }), await mkLot(stores[1], { bulk_group_id: grp }), await mkLot(stores[2], { bulk_group_id: grp })];
  const serial = await mkLot(solo, { apply_method: "serial" });
  void prodB;

  try {
    await page.goto("/lotteries");
    await page.getByRole("tab", { name: /要チェック/ }).click();
    await page.getByTestId("filter-open").click(); // 地域は既定の関西3県。念のため地域条件が外れていても問題ないことを確認する
    await page.keyboard.press("Escape");

    // ---- 親カード: 1枚にまとまり、初期は閉じている（子の店舗別カードは出ない）。店舗別の操作ボタンは親に無い
    const parent = page.getByTestId("group-card");
    await expect(parent).toHaveCount(1);
    await expect(parent.getByTestId("group-chain")).toHaveText("8U電機");
    await expect(parent.getByTestId("group-products")).toContainText("8U商品アルファ");
    await expect(parent.getByTestId("group-count")).toContainText("0/3");
    await expect(parent.getByTestId("group-children")).toHaveCount(0);
    await expect(parent.getByTestId("my-apply")).toHaveCount(0);
    await expect(parent.getByTestId("group-toggle")).toHaveAttribute("aria-expanded", "false");
    // 通常カード以下の高さ（親は1行の見出し＋2行）
    const parentBox = await parent.boundingBox();
    const single = page.getByTestId("lottery-card").filter({ hasText: "8U単独店" });
    await expect(single).toHaveCount(1);
    expect(parentBox!.height).toBeLessThanOrEqual((await single.boundingBox())!.height);
    await noHorizontalOverflow(page);
    await page.screenshot({ path: "docs/screenshots/stage8u-group-closed.png" });

    // ---- シリアルコード応募: 小型のバッジ
    await expect(single.getByTestId("serial-badge")).toContainText("シリアル");

    // ---- 展開: 子が店舗別に出る。子で応募済みにすると、親の応募済み件数へ即時反映
    await parent.getByTestId("group-toggle").click();
    await expect(parent.getByTestId("group-toggle")).toHaveAttribute("aria-expanded", "true");
    const child1 = parent.getByTestId("lottery-card").filter({ hasText: "8U一号店" });
    await expect(parent.getByTestId("lottery-card")).toHaveCount(3);
    await noHorizontalOverflow(page);
    await page.screenshot({ path: "docs/screenshots/stage8u-group-open.png" });
    await child1.getByTestId("my-apply").first().click();
    await expect(parent.getByTestId("group-count")).toContainText("1/3");
    // DB: 応募は子（抽選ID）に付く。親（グループ）は応募記録を持たない
    await expect.poll(async () => ((await a.from("applications").select("lottery_id").in("lottery_id", kids)).data ?? []).map((x) => x.lottery_id)).toEqual([kids[0]]);

    // ---- グループ管理: 1件を外す（所属が2件残る）→ 親カードは2店舗。全体を解除すると通常のカードに戻る。抽選・応募の記録は残る
    await parent.getByTestId("group-manage").click();
    const sheet = page.getByTestId("lottery-group-sheet");
    await expect(sheet.getByTestId("group-member")).toHaveCount(3);
    await sheet.getByTestId("group-member").filter({ hasText: "8U三号店" }).getByTestId("group-remove").click();
    await expect(sheet.getByTestId("group-member")).toHaveCount(2);
    await sheet.getByTestId("group-dissolve-open").click();
    await sheet.getByTestId("group-dissolve-run").click();
    await expect(page.getByTestId("group-card")).toHaveCount(0);
    expect(((await a.from("lotteries").select("id").in("id", kids)).data ?? []).length).toBe(3);
    expect(((await a.from("applications").select("id").in("lottery_id", kids)).data ?? []).length).toBe(1);
    const ev = (await a.from("lottery_group_events").select("action").eq("group_id", grp)).data ?? [];
    expect(ev.map((e) => e.action)).toEqual(expect.arrayContaining(["removed", "dissolved"]));

    // ---- 手動でグループ化: 詳細の「グループにまとめる」から、同じ系列の抽選を選ぶ（自動では選ばない）
    const c2 = page.getByTestId("lottery-card").filter({ hasText: "8U二号店" });
    await c2.getByRole("button", { name: /の詳細を開く/ }).first().click();
    const detail = page.getByTestId("lottery-detail-sheet");
    await detail.getByTestId("more-ops").locator("summary").click();
    await detail.getByTestId("lottery-group-open").click(); // 詳細は閉じ、管理画面は一覧側で開く（グループ化でカードが親カードへ移っても消えない）
    const gs = page.getByTestId("lottery-group-sheet");
    await expect(gs.getByTestId("group-pick").first()).not.toBeChecked();
    await gs.getByTestId("group-pick").nth(0).check();
    await gs.getByTestId("group-apply").click();
    await expect(gs.getByTestId("group-member")).toHaveCount(2); // 作成後は所属一覧になる
    await page.keyboard.press("Escape");
    await page.keyboard.press("Escape");
    expect(((await a.from("lottery_bulk_groups").select("id,origin,basis").eq("household_id", hid).eq("origin", "manual").is("dissolved_at", null)).data ?? []).length).toBeGreaterThanOrEqual(1);

    // ---- 除外: 理由を選ぶ（信頼性なし）。応募履歴は残り、一覧から外れる
    const target = page.getByTestId("lottery-card").filter({ hasText: "8U単独店" });
    await target.getByRole("button", { name: /の詳細を開く/ }).first().click();
    const d2 = page.getByTestId("lottery-detail-sheet");
    await d2.getByTestId("more-ops").locator("summary").click();
    await d2.getByTestId("lottery-exclude-open").click();
    const ex = page.getByTestId("lottery-exclude-sheet");
    await expect(ex.getByTestId("lot-exclude-submit")).toBeDisabled();
    await ex.getByTestId("lot-reason-untrusted").click();
    await ex.getByTestId("lot-exclude-submit").click();
    await expect(page.getByTestId("lottery-card").filter({ hasText: "8U単独店" })).toHaveCount(0);
    const rec = (await a.from("lottery_exclusions").select("reason,excluded_by_profile_id").eq("lottery_id", serial)).data ?? [];
    expect(rec).toHaveLength(1);
    expect(rec[0].reason).toBe("untrusted");
    expect(rec[0].excluded_by_profile_id).toBe(me.id);
    expect((await a.from("lotteries").select("archived_at").eq("id", serial).single()).data?.archived_at).not.toBeNull();
  } finally {
    await a.from("lottery_exclusions").delete().eq("household_id", hid);
    await a.from("lottery_group_events").delete().eq("household_id", hid);
    await a.from("applications").delete().in("lottery_id", [...kids, serial]);
    await a.from("lotteries").update({ bulk_group_id: null }).eq("household_id", hid);
    await a.from("lottery_bulk_groups").delete().eq("household_id", hid);
    if (wasAdmin !== true) await a.from("profiles").update({ is_admin: wasAdmin }).eq("id", me.id);
  }
});

test("他店舗に複製: 新しい店舗を追加して複製し、1グループにまとまる（元の店舗の情報は変わらない）", async ({ page }) => {
  test.setTimeout(180_000);
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
  const chain = await ins("chains", { household_id: hid, name: "8U複製電機" });
  const prod = await ins("products", { household_id: hid, official_name: "8U複製商品", packs_per_box: 20 });
  const s0 = await ins("stores", { household_id: hid, chain_id: chain, name: "8U複製元店", prefecture: "兵庫県" });
  const s1 = await ins("stores", { household_id: hid, chain_id: chain, name: "8U複製先店", prefecture: "兵庫県" });
  const src = await ins("lotteries", { household_id: hid, chain_id: chain, store_id: s0, apply_deadline_precision: "date_only", apply_deadline_date: day(6), result_precision: "date_only", result_date: day(9), receive_method: "store", apply_method: "web", event_state: "open", limit_basis: "account", limit_max_count: 1, source_kind: "manual", memo: "元だけのメモ" });
  await ins("lottery_items", { household_id: hid, lottery_id: src, product_id: prod, quantity: 1, unit: "box" });
  await a.from("lottery_management").upsert({ lottery_id: src, household_id: hid, is_managed: true, managed_source: "manual" } as never, { onConflict: "lottery_id" });
  try {
    await page.goto("/lotteries");
    await page.getByRole("tab", { name: /要チェック/ }).click();
    await page.getByTestId("lottery-card").filter({ hasText: "8U複製元店" }).getByRole("button", { name: /の詳細を開く/ }).first().click();
    const detail = page.getByTestId("lottery-detail-sheet");
    await detail.getByTestId("more-ops").locator("summary").click();
    await detail.getByRole("button", { name: "他店舗に複製" }).click();
    const dlg = page.getByRole("dialog").filter({ hasText: "他店舗に複製" });
    await dlg.getByRole("checkbox").first().check(); // 既存の店舗（8U複製先店）
    await dlg.getByTestId("store-picker-new-name").fill("8U新規追加店");
    await dlg.getByTestId("store-picker-new-pref").selectOption("京都府");
    await dlg.getByTestId("store-picker-new-add").click();
    await expect(dlg.getByTestId("duplicate-submit")).toContainText("2店舗に複製");
    await dlg.getByTestId("duplicate-submit").click();
    await expect(dlg).toHaveCount(0);
    const copies = (await a.from("lotteries").select("id,store_id,memo,bulk_group_id").eq("chain_id", chain).neq("id", src)).data ?? [];
    expect(copies).toHaveLength(2);
    expect(copies.every((c) => c.memo === "")).toBe(true);
    const gid = copies[0].bulk_group_id as string;
    expect(gid).toBeTruthy();
    expect(copies.every((c) => c.bulk_group_id === gid)).toBe(true);
    expect((await a.from("lotteries").select("bulk_group_id,memo").eq("id", src).single()).data).toMatchObject({ bulk_group_id: gid, memo: "元だけのメモ" });
    expect(((await a.from("stores").select("id,is_provisional,prefecture").eq("chain_id", chain).eq("name", "8U新規追加店")).data ?? [])[0]).toMatchObject({ is_provisional: true, prefecture: "京都府" });
    // 親カード（元＋複製先2店舗）
    await page.reload();
    await page.getByRole("tab", { name: /要チェック/ }).click();
    await expect(page.getByTestId("group-card").filter({ hasText: "8U複製電機" })).toHaveCount(1);
    expect(s1).toBeTruthy();
  } finally {
    await a.from("lottery_group_events").delete().eq("household_id", hid);
    await a.from("lotteries").update({ bulk_group_id: null }).eq("household_id", hid);
    await a.from("lottery_bulk_groups").delete().eq("household_id", hid);
  }
});

test("抽選候補: 絞り込みは1つのボタンで展開（見出し・件数と重ならない）／編集は閉じても破棄の確認なし・10分以内なら再開できる", async ({ page }) => {
  test.setTimeout(180_000);
  page.setDefaultTimeout(20_000);
  await login(page);
  const hid = await household();
  const a = admin();
  const { data: profs } = await a.from("profiles").select("id,is_admin").eq("household_id", hid).eq("active", true).order("sort_order");
  const me = profs![0];
  const wasAdmin = me.is_admin;
  await a.from("profiles").update({ is_admin: true }).eq("id", me.id);
  const key = `https://s8u-e2e.example.invalid/${Date.now()}`;
  const input = {
    chain: { id: null, name: "8U候補電機" }, store: { id: null, name: "8U候補店", prefecture: "兵庫県" }, campaignId: null, newCampaign: null,
    items: [{ product: { id: null, name: "8U候補商品" }, quantity: 1, unit: "box" }],
    applyStart: { precision: "unknown", date: "", time: "" }, applyDeadline: { precision: "date_only", date: new Date(Date.now() + 8 * 86_400_000 + 9 * 3600_000).toISOString().slice(0, 10), time: "" },
    resultDate: { precision: "unknown", date: "", time: "" }, procedureDeadline: { precision: "unknown", date: "", time: "" },
    receiveMethod: "store", applyMethod: "web", conditionsText: "", verificationText: "", announcementMethod: "", announcementUrl: "", sourceUrls: [key], eventState: "open", limitBasis: "account", limitMaxCount: 1, memo: "",
  };
  const { data: cand, error } = await a.from("collection_candidates").insert({ household_id: hid, dedupe_key: key, source_url: key, title: "8U候補", status: "pending", job_state: "review", kind: "new", reasons: [], draft: { input } } as never).select("id").single();
  expect(error?.message).toBeUndefined();
  try {
    await page.goto("/lotteries/candidates");
    await expect(page.getByTestId("candidates-filter-open")).toBeVisible();
    await expect(page.getByTestId("candidates-filters")).toHaveCount(0); // 閉じている
    await noHorizontalOverflow(page);
    await page.getByTestId("candidates-filter-open").click();
    await expect(page.getByTestId("candidates-filters")).toBeVisible();
    // 見出し・件数・戻る操作・並び順が重ならない（絞り込みの3項目は同じ行で横並び）
    const heading = await page.getByTestId("candidates-count").boundingBox();
    const filters = await page.getByTestId("candidates-filters").boundingBox();
    expect(filters!.y).toBeGreaterThanOrEqual(heading!.y + heading!.height - 1);
    await noHorizontalOverflow(page);
    await page.screenshot({ path: "docs/screenshots/stage8u-candidates-filter.png" });
    await page.getByTestId("candidates-sort").selectOption({ index: 1 });
    await expect(page.getByTestId("candidates-filter-count")).toHaveText("1");
    await page.getByTestId("candidates-filter-open").click(); // 閉じても選択は保持
    await expect(page.getByTestId("candidates-filter-count")).toHaveText("1");

    // 編集の一時保存: 開いて入力 → 閉じる（破棄の確認は出ない） → 開き直すと「編集を再開」
    const card = page.getByTestId("candidate-card").filter({ hasText: "8U候補" });
    await card.getByTestId("candidate-register").click();
    const form = page.getByTestId("lottery-form");
    await expect(form).toBeVisible();
    await expect(form.getByTestId("resume-edit")).toHaveCount(0);
    await form.getByLabel("メモ").fill("途中のメモ8U");
    await page.waitForTimeout(700); // 一時保存は入力の少しあとに行う
    await form.getByTestId("form-discard").click();
    await expect(form).toHaveCount(0); // 破棄の確認なしで閉じる
    await card.getByTestId("candidate-register").click();
    await form.getByTestId("resume-edit").click();
    await expect(form.getByLabel("メモ")).toHaveValue("途中のメモ8U");
    // 期限切れ（10分超）は、通常の編集状態から始まる
    await page.waitForTimeout(700);
    await form.getByTestId("form-discard").click();
    await page.evaluate(() => {
      const k = "tcg.candidate-resume.v1";
      const s = JSON.parse(localStorage.getItem(k)!);
      localStorage.setItem(k, JSON.stringify({ ...s, at: Date.now() - 11 * 60_000 }));
    });
    await card.getByTestId("candidate-register").click();
    await expect(form.getByTestId("resume-edit")).toHaveCount(0);
    await expect(form.getByLabel("メモ")).toHaveValue("");
  } finally {
    await a.from("collection_candidates").delete().eq("id", cand!.id);
    if (wasAdmin !== true) await a.from("profiles").update({ is_admin: wasAdmin }).eq("id", me.id);
  }
});

test("保存して複製（単一トランザクション）: 新規登録のフォームから、複製先（既存・新規の店舗）を選んで保存。1グループに作られ、新しい店舗も同時に追加される", async ({ page }) => {
  test.setTimeout(180_000);
  page.setDefaultTimeout(20_000);
  await login(page);
  const hid = await household();
  const a = admin();
  const ins = async (table: string, row: Record<string, unknown>) => {
    const { data, error } = await a.from(table).insert(row as never).select("id").single();
    expect(error?.message, table).toBeUndefined();
    return (data as { id: string }).id;
  };
  const chain = await ins("chains", { household_id: hid, name: "8U保存複製電機" });
  await ins("products", { household_id: hid, official_name: "8U保存複製商品", packs_per_box: 20 });
  await ins("stores", { household_id: hid, chain_id: chain, name: "8U保存元店", prefecture: "兵庫県" });
  await ins("stores", { household_id: hid, chain_id: chain, name: "8U保存先店", prefecture: "兵庫県" });
  try {
    await page.goto("/lotteries");
    await page.getByTestId("register").click();
    const form = page.getByTestId("lottery-form");
    await form.getByRole("combobox", { name: "系列", exact: true }).fill("8U保存複製電機");
    await form.getByRole("option", { name: /8U保存複製電機/ }).first().click();
    await form.getByRole("combobox", { name: "店舗", exact: true }).fill("8U保存元店");
    await form.getByRole("option", { name: /8U保存元店/ }).first().click();
    await form.getByRole("combobox", { name: "商品1", exact: true }).fill("8U保存複製商品");
    await form.getByRole("option", { name: /8U保存複製商品/ }).first().click();
    await form.getByTestId("save-and-duplicate").click();
    const panel = form.getByTestId("dup-panel");
    await expect(panel).toBeVisible();
    await expect(form.getByTestId("dup-run")).toBeDisabled(); // 複製先を選ぶまで押せない
    await panel.getByRole("checkbox").first().check(); // 8U保存先店
    await panel.getByTestId("store-picker-new-name").fill("8U保存新規店");
    await panel.getByTestId("store-picker-new-add").click();
    await expect(form.getByTestId("dup-run")).toContainText("2店舗");
    await form.getByTestId("dup-run").click();
    await expect(form).toHaveCount(0);
    const lots = (await a.from("lotteries").select("id,store_id,bulk_group_id,registration_path").eq("chain_id", chain)).data ?? [];
    expect(lots).toHaveLength(3);
    expect(new Set(lots.map((l) => l.bulk_group_id)).size).toBe(1);
    expect(lots[0].bulk_group_id).toBeTruthy();
    expect(((await a.from("stores").select("id,is_provisional").eq("chain_id", chain).eq("name", "8U保存新規店")).data ?? [])[0]).toMatchObject({ is_provisional: true });
    expect(((await a.from("lottery_operations").select("kind").eq("household_id", hid)).data ?? []).map((o) => o.kind)).toContain("save_and_duplicate");
    expect(((await a.from("lottery_exclusions").select("id").eq("household_id", hid)).data ?? []).length).toBe(0); // 不要な除外履歴は作られない
  } finally {
    await a.from("lottery_operations").delete().eq("household_id", hid);
    await a.from("lottery_group_events").delete().eq("household_id", hid);
    await a.from("lotteries").update({ bulk_group_id: null }).eq("household_id", hid);
    await a.from("lottery_bulk_groups").delete().eq("household_id", hid);
  }
});
