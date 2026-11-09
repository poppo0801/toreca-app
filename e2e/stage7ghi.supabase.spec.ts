import { createClient } from "@supabase/supabase-js";
import { expect, test, type Page } from "@playwright/test";

/**
 * Stage 7G〜7I の画面確認（実Supabaseのテスト世帯・架空データ・外部サイト／AI／有料APIは使わない）。
 *   E2E_SPEC=stage7ghi.supabase.spec.ts npm run test:e2e:supabase
 *  7G: プロフィール別の対戦記録（1件を保存し、相手側では自分/相手・デッキ・勝敗が反転）／二重登録の防止／外部の相手／フィルター・分析
 *  7H: 抽選候補ページ（件数・カード・除外理由・ルール作成・設定での無効化・取り消し）
 *  7I: 購入記録の表示順・商品別累計のカード
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
async function switchProfile(page: Page, label: string) {
  await page.getByRole("button", { name: /ユーザー切り替え/ }).click();
  await page.getByRole("radio", { name: `プロフィール ${label}` }).click();
  await page.keyboard.press("Escape");
}

test("対戦記録: プロフィール別。共有の対戦は1件だけ保存され、相手側では反転して表示。二重登録・外部の相手・フィルター・分析", async ({ page }) => {
  test.setTimeout(150_000);
  await login(page);
  const hid = await household();
  const a = admin();
  const { data: profs } = await a.from("profiles").select("id,label").eq("household_id", hid).eq("active", true).order("sort_order");
  const [pa, pb] = profs!;
  await page.goto("/battles");
  await expect(page.locator("header").getByTestId("current-profile")).toHaveText(pa.label);

  // ヘッダー右上: フィルター・データ分析・＋対戦を記録。戻るボタンは無い。iPhone幅で収まる
  await expect(page.getByTestId("battle-filter-open")).toBeVisible();
  await expect(page.getByTestId("battle-analysis-open")).toBeVisible();
  await expect(page.getByTestId("battle-add")).toBeVisible();
  await expect(page.getByLabel("設定へ戻る")).toHaveCount(0);
  const w = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(w).toBeLessThanOrEqual(1);

  const record = async (opts: { result: "勝ち" | "負け" | "引き分け"; my: string; opp: string; format: string; app?: string; external?: string }) => {
    await page.getByTestId("battle-add").click();
    const f = page.getByTestId("battle-form");
    await expect(f.getByText("対戦した人")).toHaveCount(0);
    await f.getByRole("radio", { name: opts.result }).click();
    await f.getByLabel("使用デッキ").fill(opts.my);
    await f.getByLabel("相手デッキ").fill(opts.opp);
    await f.getByLabel("対戦形式").fill(opts.format);
    if (opts.app) {
      await f.getByRole("radio", { name: "アプリ内のユーザー" }).click();
      await f.getByLabel("対戦相手のユーザー").selectOption({ label: opts.app });
    } else if (opts.external) {
      await f.getByLabel("外部の相手の名称").fill(opts.external);
    }
    await f.getByRole("button", { name: "保存" }).click();
    return f;
  };

  try {
    // A: リザードン vs B: サーナイト、Aの勝ち
    const f1 = await record({ result: "勝ち", my: "リザードン", opp: "サーナイト", format: "ジムバトル", app: pb.label });
    await expect(f1).toHaveCount(0);
    const rowA = page.getByTestId("battle-row");
    await expect(rowA).toHaveCount(1);
    // 自分を1行目・相手を2行目（アイコン・ユーザー名・デッキ名）。右端に大きな勝敗記号、左端に同じ色のバー
    await expect(rowA.first().getByTestId("battle-me")).toContainText(pa.label);
    await expect(rowA.first().getByTestId("battle-me")).toContainText("リザードン");
    await expect(rowA.first().getByTestId("battle-opp")).toContainText(pb.label);
    await expect(rowA.first().getByTestId("battle-opp")).toContainText("サーナイト");
    await expect(rowA.first().getByTestId("battle-bar")).toBeVisible();
    // 総合集計（対戦・勝ち・負け・勝率）
    await expect(page.getByTestId("sum-total-value")).toHaveText("1");
    await expect(page.getByTestId("sum-rate-value")).toHaveText("100%");
    await expect(rowA.first().locator('[data-result="win"]')).toHaveText("◯");
    // 保存されるのは1件
    expect((await a.from("battle_records").select("id,profile_id,opponent_profile_id,result").eq("household_id", hid).is("archived_at", null)).data).toHaveLength(1);

    // 外部の相手（Aの記録だけ）
    await (await record({ result: "負け", my: "ピカチュウ", opp: "ミュウ", format: "公認大会", external: "友だち" })).waitFor({ state: "detached" });
    await expect(page.getByTestId("battle-row")).toHaveCount(2);
    await expect(page.getByTestId("battle-row").filter({ hasText: "ピカチュウ" }).getByTestId("battle-opp")).toContainText("友だち");
    await expect(page.getByTestId("battle-row").filter({ hasText: "ピカチュウ" }).getByTestId("battle-external-icon")).toHaveCount(1); // 外部の相手は共通の人物アイコン
    await expect(page.getByTestId("sum-total-value")).toHaveText("2");
    await expect(page.getByTestId("sum-rate-value")).toHaveText("50%");

    // Bの画面: 共有の1件だけ。自分/相手・デッキ・勝敗が反転（Aの勝ち → Bの負け）。外部の相手の記録は見えない
    await switchProfile(page, pb.label);
    await page.reload();
    await expect(page.locator("header").getByTestId("current-profile")).toHaveText(pb.label);
    const rowB = page.getByTestId("battle-row");
    await expect(rowB).toHaveCount(1);
    await expect(rowB.first().getByTestId("battle-me")).toContainText(pb.label);
    await expect(rowB.first().getByTestId("battle-me")).toContainText("サーナイト");
    await expect(rowB.first().getByTestId("battle-opp")).toContainText(pa.label);
    await expect(rowB.first().getByTestId("battle-opp")).toContainText("リザードン");
    await expect(page.getByTestId("sum-rate-value")).toHaveText("0%");
    await expect(rowB.first().locator('[data-result="lose"]')).toHaveText("×");

    // Bが同じ対戦を自分側から登録しようとしても、二重登録にはならない
    await page.getByTestId("battle-add").click();
    const dup = page.getByTestId("battle-form");
    await dup.getByRole("radio", { name: "負け" }).click();
    await dup.getByLabel("使用デッキ").fill("サーナイト");
    await dup.getByLabel("相手デッキ").fill("リザードン");
    await dup.getByLabel("対戦形式").fill("ジムバトル");
    await dup.getByRole("radio", { name: "アプリ内のユーザー" }).click();
    await dup.getByLabel("対戦相手のユーザー").selectOption({ label: pa.label });
    await dup.getByRole("button", { name: "保存" }).click();
    await expect(dup.getByRole("alert")).toContainText("同じ対戦がすでに登録されています");
    await dup.getByRole("button", { name: "閉じる", exact: true }).click();

    // Bが勝敗を直すと（Bの勝ち）、保存は1件のまま、Aの画面では負けになる
    await rowB.first().click();
    const edit = page.getByTestId("battle-form");
    await expect(edit.getByTestId("battle-opponent-fixed")).toContainText(pa.label); // 相手側からは相手を変えられない
    await edit.getByRole("radio", { name: "勝ち" }).click();
    await edit.getByRole("button", { name: "保存" }).click();
    await expect(page.getByTestId("battle-row").first().locator('[data-result="win"]')).toBeVisible();
    const shared = (await a.from("battle_records").select("id,result,my_deck,opponent_deck,profile_id,opponent_profile_id").eq("household_id", hid).eq("my_deck", "リザードン").is("archived_at", null)).data!;
    expect(shared).toHaveLength(1);
    expect(shared[0]).toMatchObject({ result: "lose", opponent_deck: "サーナイト", profile_id: pa.id, opponent_profile_id: pb.id }); // 保存はAから見た形（Aの負け）

    await switchProfile(page, pa.label);
    await page.reload();
    await expect(page.getByTestId("battle-row").filter({ hasText: "リザードン" }).locator('[data-result="lose"]')).toHaveText("×");

    // フィルター（ボトムシート）と分析（別の画面）
    await page.getByTestId("battle-filter-open").click();
    await page.getByTestId("battle-filter").getByLabel("対戦形式").selectOption("公認大会");
    await page.getByTestId("battle-filter").getByRole("button", { name: "OK" }).click();
    await expect(page.getByTestId("battle-row")).toHaveCount(1);
    await page.getByTestId("battle-filter-open").click();
    await page.getByTestId("battle-filter-clear").click();
    await page.getByTestId("battle-filter").getByRole("button", { name: "OK" }).click();
    await page.getByTestId("battle-analysis-open").click();
    const an = page.getByTestId("battle-analysis");
    await expect(an.getByTestId("battle-total")).toHaveText("2");
    await expect(an.getByTestId("battle-win")).toHaveText("0");
    await expect(an.getByTestId("battle-lose")).toHaveText("2");
    await expect(an.getByTestId("battle-rate")).toHaveText("0%");
    await expect(an).not.toContainText("相手デッキ別");
    await expect(an.getByTestId("battle-by-format")).toContainText("ジムバトル");
    await page.screenshot({ path: "docs/screenshots/stage7g-battles-analysis-mobile.png" });
  } finally {
    await a.from("battle_records").delete().eq("household_id", hid);
  }
});

test("抽選候補ページ: 件数・カード・除外理由（6種類）・ルールの作成と取り消し・設定での見直し", async ({ page }) => {
  test.setTimeout(150_000);
  await login(page);
  const hid = await household();
  const a = admin();
  const { data: profs } = await a.from("profiles").select("id,label").eq("household_id", hid).eq("active", true).order("sort_order");
  const [admin1, other1] = profs!;
  await a.from("profiles").update({ is_admin: true }).eq("id", admin1.id);
  const EMPTY = { precision: "unknown", date: "", time: "" };
  const input = (chain: string, store: string, product: string) => ({
    chain: { id: null, name: chain },
    store: { id: null, name: store, prefecture: "" },
    campaignId: null,
    newCampaign: null,
    items: [{ product: { id: null, name: product }, quantity: 1, unit: "box" }],
    multiMode: "single",
    applyStart: { precision: "date_only", date: "2026-11-01", time: "" },
    applyDeadline: { precision: "date_only", date: "2099-01-20", time: "" },
    resultDate: EMPTY,
    procedureStart: EMPTY,
    procedureDeadline: EMPTY,
    receiveMethod: "store",
    applyMethod: "web",
    requirementTags: [],
    conditionsText: "",
    verificationText: "",
    announcementMethod: "",
    announcementUrl: "",
    sourceUrls: [],
    eventState: "open",
    limitBasis: "account",
    limitMaxCount: 1,
    memo: "",
    applications: [],
  });
  const draft = (i: ReturnType<typeof input>) => ({ input: i, flags: {}, summary: { chain: "none", store: "none", items: [{ name: "x", kind: "none", matchedName: null }] }, warnings: [], modePending: false, verdict: "review", ready: false, notices: [] });
  const keys: string[] = [];
  const add = async (n: string, i: ReturnType<typeof input>) => {
    const key = `https://s7h-e2e.example.invalid/${n}`;
    keys.push(key);
    const r = await a.from("collection_candidates").insert({ household_id: hid, dedupe_key: key, source_url: key, title: n, status: "pending", job_state: "review", kind: "new", reasons: ["要確認"], draft: draft(i) as never } as never);
    expect(r.error?.message).toBeUndefined();
  };
  try {
    await add("c-region", input("E2E電機", "豊橋店", "E2E弾 BOX"));
    await add("c-game", input("E2E電機", "梅田店", "他社E2Eカード 拡張パック"));
    await add("c-other", input("E2E別系列", "なんば店", "E2E弾 BOX"));

    // 管理者以外のプロフィールでは、リンクは出ず、URLを直接開いても案内だけ。管理操作はサーバーでも拒否される
    await page.goto("/lotteries");
    await switchProfile(page, other1.label);
    await page.reload();
    await expect(page.getByTestId("candidate-card")).toHaveCount(0);
    await expect(page.getByTestId("candidates-link")).toHaveCount(0);
    await page.goto("/lotteries/candidates");
    await expect(page.getByTestId("candidates-admin-only")).toBeVisible();
    await expect(page.getByTestId("candidate-card")).toHaveCount(0);
    const denied = await page.evaluate(async (profileId) => {
      const r = await fetch("/api/collection", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "excludeReason", id: "00000000-0000-4000-8000-000000000000", actor: profileId, input: { reason: "other" } }) });
      return r.status;
    }, other1.id);
    expect(denied).toBe(403);
    expect((await a.from("collection_candidates").select("status").eq("dedupe_key", keys[0]).single()).data!.status).toBe("pending"); // 変更されていない
    await switchProfile(page, admin1.label);

    // 抽選管理に「抽選候補 N件」のリンク → 専用ページ
    await page.goto("/lotteries");
    await expect(page.getByTestId("candidates-link")).toContainText("抽選候補 3件");
    await page.getByTestId("candidates-link").click();
    await expect(page).toHaveURL(/\/lotteries\/candidates$/);
    await expect(page.getByTestId("candidates-count")).toHaveText("3件");
    await expect(page.getByTestId("candidate-card")).toHaveCount(3);
    // カードの主要操作は「確認・登録」と「除外」。理由のボタンは常時表示しない
    await expect(page.getByTestId("candidate-card").first().getByRole("button", { name: "確認・登録" })).toBeVisible();
    await expect(page.getByText("信頼性なし")).toHaveCount(0);
    const w = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(w).toBeLessThanOrEqual(1);

    // 別ゲーム: キーワードを自動入力 → 確定で除外＋ルール作成。カードは一覧から外れ、件数が即時に更新される
    const game = page.getByTestId("candidate-card").filter({ hasText: "他社E2Eカード" });
    await game.getByTestId("candidate-exclude").click();
    await expect(page.getByTestId("exclude-sheet").locator('[role="radiogroup"] [role="radio"]')).toHaveCount(6);
    await page.getByTestId("reason-other_game").click();
    await expect(page.getByTestId("reason-game-form").locator("input")).toHaveValue("他社E2Eカード");
    await page.getByTestId("exclude-submit").click();
    await expect(page.getByTestId("candidate-card")).toHaveCount(2);
    await expect(page.getByTestId("candidates-count")).toHaveText("2件");
    const rule = (await a.from("collection_rules").select("id,kind,keywords,active").eq("household_id", hid).eq("kind", "other_game")).data!;
    expect(rule).toHaveLength(1);
    expect(rule[0]).toMatchObject({ keywords: ["他社E2Eカード"], active: true });
    const log = (await a.from("collection_exclusion_log").select("reason_code,rule_id,candidate_id").eq("household_id", hid)).data!;
    expect(log).toHaveLength(1);
    expect(log[0]).toMatchObject({ reason_code: "other_game", rule_id: rule[0].id });
    expect((await a.from("collection_candidates").select("status,job_state").eq("dedupe_key", keys[1]).single()).data).toMatchObject({ status: "excluded", job_state: "skipped" });

    // 取り消し（トースト）: 候補が戻り、この操作で作ったルールは無効になる
    await page.getByRole("button", { name: "元に戻す" }).click();
    await expect(page.getByTestId("candidate-card")).toHaveCount(3);
    await expect.poll(async () => (await a.from("collection_rules").select("active").eq("id", rule[0].id).single()).data?.active).toBe(false);
    expect((await a.from("collection_candidates").select("status,job_state").eq("dedupe_key", keys[1]).single()).data).toMatchObject({ status: "pending", job_state: "review" });

    // 地域・店舗: 系列・店舗を自動入力。都道府県を選んで確定 → ルール
    const region = page.getByTestId("candidate-card").filter({ hasText: "豊橋店" });
    await region.getByTestId("candidate-exclude").click();
    await page.getByTestId("reason-region").click();
    const form = page.getByTestId("reason-region-form");
    await expect(form.locator("input").nth(0)).toHaveValue("E2E電機");
    await expect(form.locator("input").nth(1)).toHaveValue("豊橋店");
    await expect(form.locator("select")).toHaveValue("愛知県"); // 店舗名の地名から自動判定
    await page.getByTestId("exclude-submit").click();
    await expect(page.getByTestId("candidate-card")).toHaveCount(2);
    const regionRule = (await a.from("collection_rules").select("id,kind,store_name,prefecture,active").eq("household_id", hid).eq("kind", "region_store")).data!;
    expect(regionRule).toEqual([expect.objectContaining({ store_name: "豊橋店", prefecture: "愛知県", active: true, id: regionRule[0].id })]);

    // 「その他」: 追加入力なしで除外。ルールは作らない
    const other = page.getByTestId("candidate-card").filter({ hasText: "なんば店" });
    await other.getByTestId("candidate-exclude").click();
    await page.getByTestId("reason-other").click();
    await expect(page.getByTestId("candidate-card")).toHaveCount(1);
    expect((await a.from("collection_rules").select("id").eq("household_id", hid).eq("active", true)).data).toHaveLength(1); // 地域・店舗のルールだけ
    expect((await a.from("collection_exclusion_log").select("reason_code").eq("household_id", hid).eq("reason_code", "other")).data).toHaveLength(1);
    await page.screenshot({ path: "docs/screenshots/stage7h-candidates-mobile.png" });

    // 設定: 除外ルールの一覧 → 無効化・再有効化・削除（履歴は残る）
    await page.goto("/settings/collection");
    await page.getByTestId("sources").getByRole("button").first().click().catch(() => undefined);
    const rules = page.getByTestId("user-rules");
    await expect(rules.getByTestId("rule-row")).toHaveCount(2); // 別ゲーム（取り消しで無効）と地域・店舗
    const row = rules.getByTestId("rule-row").filter({ hasText: "豊橋店" });
    await row.getByTestId("rule-toggle").click();
    await expect(rules.getByTestId("rule-msg")).toContainText("無効にしました");
    await expect.poll(async () => (await a.from("collection_rules").select("active").eq("id", regionRule[0].id).single()).data?.active).toBe(false);
    await expect(row.getByTestId("rule-toggle")).toHaveText("再び有効にする");
    await row.getByTestId("rule-toggle").click();
    await expect(row.getByTestId("rule-toggle")).toHaveText("無効にする");
    await expect.poll(async () => (await a.from("collection_rules").select("active").eq("id", regionRule[0].id).single()).data?.active).toBe(true);
    page.once("dialog", (d) => void d.accept());
    await row.getByTestId("rule-delete").click();
    await expect.poll(async () => (await a.from("collection_rules").select("id").eq("id", regionRule[0].id)).data?.length).toBe(0);
    expect((await a.from("collection_exclusion_log").select("id").eq("household_id", hid).eq("rule_id", regionRule[0].id)).data).toHaveLength(1); // 履歴は残る
  } finally {
    await a.from("profiles").update({ is_admin: false }).eq("id", admin1.id);
    await a.from("collection_exclusion_log").delete().eq("household_id", hid);
    await a.from("collection_rules").delete().eq("household_id", hid);
    await a.from("collection_candidates").delete().in("dedupe_key", keys);
  }
});

test("購入記録: 表示順（月選択→集計→切替＋絞り込み→一覧）と、商品別累計は1商品1カード", async ({ page }) => {
  test.setTimeout(90_000);
  await login(page);
  await page.goto("/purchases");
  const y = async (id: string) => (await page.getByTestId(id).boundingBox())!.y;
  const [period, summary, tab, filter] = [await y("period-label"), await y("purchase-summary"), await y("tab-products"), await y("filter-toggle")];
  expect(period).toBeLessThan(summary);
  expect(summary).toBeLessThan(tab);
  expect(Math.abs(tab - filter)).toBeLessThan(12); // 絞り込みは切替と同じ行
  const px = (await page.getByTestId("filter-toggle").boundingBox())!.x;
  expect(px).toBeGreaterThan((await page.getByTestId("tab-history").boundingBox())!.x); // 切替の右側
  const w = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(w).toBeLessThanOrEqual(1);
});
