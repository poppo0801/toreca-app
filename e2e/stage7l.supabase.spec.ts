import { createClient } from "@supabase/supabase-js";
import { expect, test, type Page } from "@playwright/test";

/**
 * Stage 7L の画面確認（実Supabaseのテスト世帯・架空データ）。
 *   E2E_SPEC=stage7l.supabase.spec.ts npm run test:e2e:supabase
 *  - 抽選候補: 不足情報バッジ → 確認・登録 → 店舗別に一括登録（店舗の選択・追加・登録前の確認）→ 店舗ごとに独立した抽選・候補は処理済み
 *  - 一括登録した抽選は店舗ごとに個別編集（他店舗は変わらない）。編集を閉じる→再開（確認なし・10分・正式保存で消える）
 *  - 重複: 系列名の表記揺れでも候補になり、系列の別名として登録できる／信頼性なし: 未登録の系列を登録して除外
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

test("抽選候補→店舗別一括登録→店舗ごとの編集・編集の再開／重複の別名登録／未登録系列の信頼性なし", async ({ page }) => {
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
  const { data: profs } = await a.from("profiles").select("id,label,is_admin").eq("household_id", hid).eq("active", true).order("sort_order");
  const admin1 = profs![0];
  const wasAdmin = admin1.is_admin;
  await a.from("profiles").update({ is_admin: true }).eq("id", admin1.id);
  // 自動収集の対象地域（兵庫県）。元の設定は終了時に戻す
  const settings = (await a.from("collection_settings").select("*").eq("household_id", hid).maybeSingle()).data as { prefectures: string[] } | null;
  if (settings) await a.from("collection_settings").update({ prefectures: ["兵庫県"] } as never).eq("household_id", hid);

  const chain = await ins("chains", { household_id: hid, name: "7L電機" });
  const prod = await ins("products", { household_id: hid, official_name: "7L弾 BOX", packs_per_box: 20 });
  const sSan = await ins("stores", { household_id: hid, chain_id: chain, name: "7L三宮店", prefecture: "兵庫県" });
  const sNa = await ins("stores", { household_id: hid, chain_id: chain, name: "7L名谷店", prefecture: "兵庫県" });
  const sTokyo = await ins("stores", { household_id: hid, chain_id: chain, name: "7L東京店", prefecture: "東京都" });
  const EMPTY = { precision: "unknown", date: "", time: "" };
  const input = (chainRef: { id: string | null; name: string }) => ({
    chain: chainRef,
    store: { id: null, name: "", prefecture: "" },
    campaignId: null,
    newCampaign: null,
    items: [{ product: { id: prod, name: "7L弾 BOX" }, quantity: 1, unit: "box" }],
    multiMode: "single",
    applyStart: { precision: "date_only", date: "2026-11-01", time: "" },
    applyDeadline: { precision: "date_only", date: "2099-01-20", time: "" },
    resultDate: EMPTY,
    procedureStart: EMPTY,
    procedureDeadline: EMPTY,
    receiveMethod: "store",
    applyMethod: "web",
    requirementTags: [],
    conditionsText: "共通の条件",
    verificationText: "",
    announcementMethod: "",
    announcementUrl: "",
    sourceUrls: [],
    eventState: "open",
    limitBasis: "account",
    limitMaxCount: 1,
    memo: "共通メモ",
    applications: [],
  });
  const draft = (i: ReturnType<typeof input>) => ({ input: i, flags: {}, summary: { chain: "none", store: "none", items: [{ name: "x", kind: "none", matchedName: null }] }, warnings: [], modePending: false, verdict: "review", ready: false, notices: [] });
  const keys: string[] = [];
  const addCand = async (n: string, i: ReturnType<typeof input>) => {
    const key = `https://s7l-e2e.example.invalid/${n}`;
    keys.push(key);
    const { data, error } = await a.from("collection_candidates").insert({ household_id: hid, dedupe_key: key, source_url: key, title: n, status: "pending", job_state: "review", kind: "new", reasons: ["要確認"], draft: draft(i) as never } as never).select("id").single();
    expect(error?.message).toBeUndefined();
    return (data as { id: string }).id;
  };
  let createdIds: string[] = [];
  try {
    const cBulk = await addCand("bulk", input({ id: chain, name: "7L電機" }));

    // ---- 不足情報バッジ（発表日が未発表）
    await page.goto("/lotteries/candidates");
    const card = page.getByTestId("candidate-card").filter({ hasText: "7L電機" });
    await expect(card).toHaveCount(1);
    const badges = card.getByTestId("candidate-badges");
    await expect(badges).toContainText("発表日");
    const bb = (await badges.boundingBox())!;
    const eb = (await card.getByTestId("candidate-exclude").boundingBox())!;
    expect(bb.x + bb.width).toBeLessThanOrEqual(eb.x + 1); // 操作ボタンと重ならない（左側）
    await page.screenshot({ path: "docs/screenshots/stage7l-candidates-mobile.png" });

    // ---- 確認・登録 → 店舗別に一括登録
    await card.getByTestId("candidate-register").click();
    const form = page.getByTestId("lottery-form");
    await expect(form).toBeVisible();
    await form.getByTestId("store-mode").selectOption("bulk");
    await expect(form.getByTestId("bulk-stores")).toBeVisible();
    await expect(form.getByTestId("bulk-store-list").getByRole("checkbox", { name: "7L三宮店" })).toBeVisible();
    if (settings) {
      await expect(form.getByRole("checkbox", { name: "7L三宮店" })).toBeChecked(); // 対象地域内は初期選択
      await expect(form.getByRole("checkbox", { name: "7L東京店" })).not.toBeChecked(); // 対象地域外は初期選択しない
    } else {
      await form.getByRole("checkbox", { name: "7L三宮店" }).check();
    }
    await form.getByRole("checkbox", { name: "7L名谷店" }).uncheck(); // 不要な店舗を外す
    await form.getByRole("checkbox", { name: "7L東京店" }).check(); // 対象地域外も手動で追加できる
    await form.getByTestId("bulk-new-name").fill("7L新規店");
    await form.getByTestId("bulk-new-add").click();
    await expect(form.getByTestId("bulk-count")).toHaveText("3");
    await page.screenshot({ path: "docs/screenshots/stage7l-bulk-mobile.png" });
    await form.getByRole("button", { name: "保存" }).click();
    const confirm = form.getByTestId("bulk-confirm");
    await expect(confirm).toContainText("3店舗の抽選を登録します");
    await expect(confirm).toContainText("7L新規店");
    expect((await a.from("lotteries").select("id").eq("chain_id", chain)).data).toHaveLength(0); // 確認の前には登録しない
    await confirm.getByTestId("bulk-confirm-ok").click();
    await expect(form).toHaveCount(0);

    // 店舗ごとに独立した抽選・同じグループ・候補は処理済み
    await expect.poll(async () => ((await a.from("lotteries").select("id").eq("chain_id", chain)).data ?? []).length).toBe(3);
    const lots = (await a.from("lotteries").select("id,store_id,memo,bulk_group_id").eq("chain_id", chain)).data as { id: string; store_id: string; memo: string; bulk_group_id: string }[];
    createdIds = lots.map((l) => l.id);
    expect(new Set(lots.map((l) => l.store_id)).size).toBe(3);
    expect(new Set(lots.map((l) => l.bulk_group_id)).size).toBe(1);
    expect(lots.every((l) => l.memo === "共通メモ")).toBe(true);
    const stores = (await a.from("stores").select("id,name").eq("chain_id", chain)).data!;
    expect(stores.map((s) => s.name).sort()).toEqual(["7L三宮店", "7L名谷店", "7L新規店", "7L東京店"].sort());
    expect(lots.map((l) => l.store_id)).not.toContain(sNa); // 外した店舗は作られない
    await expect.poll(async () => (await a.from("collection_candidates").select("status,lottery_id").eq("id", cBulk).single()).data?.status).not.toBe("pending");
    expect((await a.from("lottery_bulk_groups").select("candidate_id,store_count").eq("id", lots[0].bulk_group_id).single()).data).toMatchObject({ candidate_id: cBulk, store_count: 3 });
    await expect(page.getByTestId("candidate-card").filter({ hasText: "7L電機" })).toHaveCount(0); // 一覧から外れる

    // ---- 店舗ごとの個別編集（他店舗は変わらない）と、編集の再開
    const target = lots.find((l) => l.store_id === sSan)!;
    await page.goto("/lotteries");
    const openDetail = async (id: string) => {
      const cardOf = page.locator(`[data-lottery-id="${id}"]`);
      for (const tab of await page.getByRole("tab").all()) {
        if ((await cardOf.count()) > 0) break;
        await tab.click();
      }
      await cardOf.getByRole("button", { name: /の詳細を開く/ }).first().click();
      return page.getByTestId("lottery-detail-sheet");
    };
    let detail = await openDetail(target.id);
    await detail.getByRole("button", { name: "編集" }).click();
    let edit = page.getByTestId("lottery-form");
    await expect(edit.getByTestId("bulk-store-cell")).toHaveCount(0);
    expect(await edit.getByTestId("store-mode").locator("option").allTextContents()).toEqual(["店舗固定", "応募時に店舗選択", "店舗指定なし"]); // 編集では一括登録は選べない
    const memo = () => edit.locator("label", { hasText: "メモ" }).locator("textarea");
    await edit.getByTestId("form-details").locator("summary").click(); // 詳細設定を開く（メモはこの中）
    await memo().fill("三宮店だけのメモ");
    await edit.getByTestId("form-discard").click(); // 確認なしで閉じる
    await expect(edit).toHaveCount(0);
    await detail.getByRole("button", { name: "編集" }).click();
    edit = page.getByTestId("lottery-form");
    await expect(memo()).toHaveValue("共通メモ"); // 開いた直後は保存済みの内容
    await edit.getByTestId("resume-edit").click(); // 再開
    await expect(memo()).toHaveValue("三宮店だけのメモ");
    await edit.getByRole("button", { name: "保存" }).click();
    await expect(page.getByTestId("lottery-form")).toHaveCount(0);
    await expect.poll(async () => (await a.from("lotteries").select("memo").eq("id", target.id).single()).data?.memo).toBe("三宮店だけのメモ");
    for (const l of lots.filter((x) => x.id !== target.id)) expect((await a.from("lotteries").select("memo").eq("id", l.id).single()).data!.memo).toBe("共通メモ"); // 他の店舗は変わらない
    // 正式保存後は復元ボタンが出ない
    detail = page.getByTestId("lottery-detail-sheet");
    await detail.getByRole("button", { name: "編集" }).click();
    await expect(page.getByTestId("lottery-form")).toBeVisible();
    await expect(page.getByTestId("resume-edit")).toHaveCount(0);
    await page.getByTestId("lottery-form").getByTestId("form-discard").click();

    // ---- 重複: 系列名の表記揺れでも候補になる → 系列の別名として登録
    const cDup = await addCand("dup", { ...input({ id: null, name: "7Lドラスタ" }) });
    await page.goto("/lotteries/candidates");
    const dupCard = page.getByTestId("candidate-card").filter({ hasText: "7Lドラスタ" });
    await dupCard.getByTestId("candidate-exclude").click();
    await page.getByTestId("reason-duplicate").click();
    const opts = page.getByTestId("dup-option");
    await expect(opts.first()).toContainText("系列名が一致しません");
    await opts.first().locator("input").check();
    await expect(page.getByTestId("dup-alias")).toContainText("7Lドラスタ");
    await page.getByTestId("dup-alias").locator("input").check();
    await page.getByTestId("exclude-submit").click();
    await expect(dupCard).toHaveCount(0);
    expect((await a.from("collection_candidates").select("status").eq("id", cDup).single()).data!.status).toBe("duplicate");
    expect(((await a.from("chain_aliases").select("alias").eq("chain_id", chain)).data ?? []).map((x) => x.alias)).toEqual(["7Lドラスタ"]);

    // ---- 信頼性なし: 未登録の系列は、登録して除外（確認のうえ）
    await addCand("untrusted", { ...input({ id: null, name: "7L未登録系列X" }) });
    await page.goto("/lotteries/candidates");
    const uCard = page.getByTestId("candidate-card").filter({ hasText: "7L未登録系列X" });
    await uCard.getByTestId("candidate-exclude").click();
    await page.getByTestId("reason-untrusted").click();
    await expect(page.getByTestId("reason-untrusted-form")).toContainText("系列マスターに未登録");
    await page.getByTestId("exclude-submit").click();
    await expect(uCard).toHaveCount(0);
    const newChain = (await a.from("chains").select("id,is_provisional").eq("household_id", hid).eq("name", "7L未登録系列X")).data!;
    expect(newChain).toHaveLength(1);
    expect(((await a.from("collection_exclusions").select("id").eq("household_id", hid).eq("scope", "chain").eq("key", newChain[0].id)).data ?? []).length).toBe(1);
    await page.screenshot({ path: "docs/screenshots/stage7l-after-mobile.png" });
  } finally {
    const lotIds = (await a.from("lotteries").select("id").eq("chain_id", chain)).data?.map((l) => l.id) ?? createdIds;
    if (lotIds.length > 0) {
      await a.from("applications").delete().in("lottery_id", lotIds);
      await a.from("lottery_management").delete().in("lottery_id", lotIds);
      await a.from("lottery_items").delete().in("lottery_id", lotIds);
      await a.from("lotteries").delete().in("id", lotIds);
    }
    await a.from("lottery_bulk_groups" as never).delete().eq("chain_id", chain);
    const candIds = ((await a.from("collection_candidates").select("id").in("dedupe_key", keys)).data ?? []).map((c) => c.id);
    const newChainIds = ((await a.from("chains").select("id").eq("household_id", hid).eq("name", "7L未登録系列X")).data ?? []).map((c) => c.id);
    if (candIds.length > 0) await a.from("collection_exclusion_log" as never).delete().in("candidate_id", candIds);
    await a.from("collection_candidates").delete().in("dedupe_key", keys);
    if (newChainIds.length > 0) await a.from("collection_exclusions").delete().eq("household_id", hid).eq("scope", "chain").in("key", newChainIds);
    await a.from("chain_aliases").delete().eq("household_id", hid).eq("chain_id", chain);
    await a.from("stores").delete().eq("chain_id", chain);
    await a.from("chains").delete().eq("household_id", hid).in("name", ["7L電機", "7L未登録系列X"]);
    await a.from("products").delete().eq("id", prod);
    void sTokyo;
    if (settings) await a.from("collection_settings").update({ prefectures: settings.prefectures } as never).eq("household_id", hid);
    await a.from("profiles").update({ is_admin: wasAdmin }).eq("id", admin1.id);
  }
});
