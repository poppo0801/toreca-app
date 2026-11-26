import { createClient } from "@supabase/supabase-js";
import { expect, test, type Page } from "@playwright/test";

/**
 * Stage 10Z: 新AIの登録案プレビュー（収集候補 → 新AI（費用ゼロのモック）→ 登録案 → 人のレビュー）の画面確認。実Supabaseのテスト世帯・架空データ。AI・外部サイト・有料APIは使わない。
 *   PROPOSAL_PREVIEW=on E2E_SPEC=proposal-preview.supabase.spec.ts npm run test:e2e:supabase
 * フラグ無し（既定）のときは「登録案の表示が出ない」ことだけを確認する。承認しても lotteries・応募・購入・通知が作られないことをDBで確認する。
 */
const email = process.env.E2E_EMAIL!;
const password = process.env.E2E_PASSWORD!;
const on = process.env.PROPOSAL_PREVIEW === "on";
const admin = () => createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false, autoRefreshToken: false } });

async function login(page: Page) {
  await page.goto("/login");
  await page.getByLabel("メールアドレス").fill(email);
  await page.getByLabel("パスワード").fill(password);
  await page.getByRole("button", { name: "ログイン" }).click();
  await expect(page).toHaveURL(/\/lotteries$/);
}

const LIST = "【抽選まとめ】 《新宿本店（東京）- 1件》 ・ポケモンカード 拡張パック 抽選 11/30(月)23:59 https://t.co/aaa111 《渋谷西口店（東京）- 1件》 ・ポケモンカード 拡張パック 抽選 11/30(月)23:59 https://t.co/bbb222";
const evidence = {
  v: 1,
  url: "https://e2e10z.example.invalid/post/1",
  fetchedAt: new Date().toISOString(),
  via: "x_api",
  origin: "primary",
  text: LIST,
  truncated: false,
  links: ["https://shared.example.invalid/all"],
  imageCount: 0,
  imageStatus: "none",
  hash: "e".repeat(64),
  linkMap: [
    { short: "https://t.co/aaa111", url: "https://shop-a.example.invalid/e/1" },
    { short: "https://t.co/bbb222", url: "https://shop-b.example.invalid/e/2" },
  ],
  linkedPages: [
    { url: "https://shop-a.example.invalid/e/1", text: "【新宿本店】拡張パック 抽選受付\n受付期間 11月30日まで", fetchedAt: new Date().toISOString() },
    { url: "https://shop-b.example.invalid/e/2", text: "【渋谷西口店】拡張パック 抽選受付\n受付期間 11月30日まで", fetchedAt: new Date().toISOString() },
  ],
};

async function seed() {
  const a = admin();
  const { data: list } = await a.auth.admin.listUsers({ perPage: 200 });
  const user = list!.users.find((u) => u.email === email)!;
  const { data: hm } = await a.from("household_members").select("household_id").eq("user_id", user.id).limit(1).maybeSingle();
  const hid = hm!.household_id as string;
  await a.from("collection_settings").upsert({ household_id: hid, auto_register: false, worker_enabled: false }, { onConflict: "household_id" });
  // 抽選候補の画面は管理者プロフィールだけ。既存の候補ページのE2E（stage7ghi）と同じ形の草稿を使う
  const { data: profs } = await a.from("profiles").select("id").eq("household_id", hid).eq("active", true).order("sort_order");
  await a.from("profiles").update({ is_admin: true }).eq("id", profs![0].id);
  const EMPTY = { precision: "unknown", date: "", time: "" };
  const input = { chain: { id: null, name: "テスト系列" }, store: { id: null, name: "新宿本店", prefecture: "" }, campaignId: null, newCampaign: null, items: [{ product: { id: null, name: "拡張パック" }, quantity: 1, unit: "box" }], multiMode: "single", applyStart: { precision: "date_only", date: "2026-11-01", time: "" }, applyDeadline: { precision: "date_only", date: "2099-01-20", time: "" }, resultDate: EMPTY, procedureStart: EMPTY, procedureDeadline: EMPTY, receiveMethod: "store", applyMethod: "web", requirementTags: [], conditionsText: "", verificationText: "", announcementMethod: "", announcementUrl: "", sourceUrls: [], eventState: "open", limitBasis: "account", limitMaxCount: 1, memo: "", applications: [] };
  const draft = { input, flags: {}, summary: { chain: "none", store: "none", items: [{ name: "x", kind: "none", matchedName: null }] }, warnings: [], modePending: false, verdict: "review", ready: false, notices: [] };
  await a.from("collection_candidates").delete().eq("household_id", hid).eq("dedupe_key", evidence.url); // 同じファイル内の前のテストの候補（登録案・レビューは連鎖して消える）を消してから始める
  const { data, error } = await a.from("collection_candidates").insert({ household_id: hid, dedupe_key: evidence.url, source_url: evidence.url, x_post_id: "910000001", title: "E2E10Z 抽選まとめ", status: "pending", job_state: "review", kind: "new", reasons: ["要確認"], last_good: { evidence } as never, draft: draft as never } as never).select("id").single();
  expect(error).toBeNull();
  return { a, hid, candidateId: data!.id as string };
}
const counts = async (a: ReturnType<typeof admin>, hid: string) => {
  const c = async (t: string) => ((await a.from(t).select("*", { count: "exact", head: true }).eq("household_id", hid)).count ?? 0) as number;
  return { lotteries: await c("lotteries"), applications: await c("applications"), purchases: await c("purchases"), notifications: await c("notification_deliveries") };
};

test("フラグ無し（既定）: 候補の詳細に新AIの登録案は出ない", async ({ page }) => {
  test.skip(on, "フラグ有りの実行では別のテストで確認する");
  test.setTimeout(120_000);
  await login(page);
  const { candidateId } = await seed();
  await page.goto("/lotteries/candidates");
  await page.getByTestId("candidate-card").first().getByRole("button").first().click();
  await expect(page.getByTestId("candidate-detail")).toBeVisible();
  await expect(page.getByTestId("proposal-preview")).toHaveCount(0);
  void candidateId;
});

test("収集候補 → 登録案を作る（モック・費用0）→ 保留／修正して承認／却下。承認しても抽選・応募・購入・通知は作られない（390px）", async ({ page }) => {
  test.skip(!on, "PROPOSAL_PREVIEW=on の実行だけ");
  test.setTimeout(240_000);
  await page.setViewportSize({ width: 390, height: 844 });
  await login(page);
  const { a, hid, candidateId } = await seed();
  const before = await counts(a, hid);
  const candBefore = (await a.from("collection_candidates").select("status,job_state,draft,lottery_id").eq("id", candidateId).single()).data;

  await page.goto("/lotteries/candidates");
  await page.getByTestId("candidate-card").first().getByRole("button").first().click();
  const detail = page.getByTestId("candidate-detail");
  await expect(detail).toBeVisible();
  const panel = detail.getByTestId("proposal-preview");
  await expect(panel).toBeVisible();
  await panel.locator("summary").click();
  await expect(panel.getByTestId("proposal-empty")).toBeVisible();
  await expect(panel.getByText("承認は記録だけで、抽選は登録されません")).toBeVisible();

  // 登録案を作る（収集時に保存された原文・linkMap・linkedPages が入力。モック・費用0）
  await panel.getByTestId("proposal-generate").click();
  await expect(panel.getByTestId("proposal-card")).toHaveCount(2);
  await expect(panel.getByTestId("proposal-gen-msg")).toContainText("作成 2");
  const first = panel.getByTestId("proposal-card").nth(0);
  const second = panel.getByTestId("proposal-card").nth(1);
  await expect(first.getByTestId("proposal-mode")).toHaveText("モック（実AIではない）");
  await expect(first.getByTestId("proposal-fields")).toContainText("店舗: 新宿本店 [観察]");
  await expect(second.getByTestId("proposal-fields")).toContainText("店舗: 渋谷西口店 [観察]"); // 別店舗のページを取り違えない
  await expect(first.getByTestId("proposal-fields")).toContainText("応募単位: 不明");
  await expect(first.getByTestId("proposal-unknowns")).toBeVisible(); // 未確認事項が残る
  await page.screenshot({ path: "test-results/10z-proposal-preview-390.png" });
  const w = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(w).toBeLessThanOrEqual(1); // 横スクロールなし

  // 再生成しても増えない（冪等）
  await panel.getByTestId("proposal-generate").click();
  await expect(panel.getByTestId("proposal-gen-msg")).toContainText("変更なし 2");
  await expect(panel.getByTestId("proposal-card")).toHaveCount(2);

  // 正解の記録（ADAPTIVE_REVIEW）: 後で確認 → 正解を修正（変える項目だけ）→ 正しい。入力欄は自動で開かない・自動フォーカスしない
  await first.getByTestId("truth-later").click();
  await expect(first.getByTestId("proposal-truth-state")).toContainText("後で確認");
  await second.getByTestId("truth-edit-open").click();
  await expect(second.getByTestId("truth-edit-store")).not.toBeFocused();
  await second.getByTestId("truth-decision").selectOption("register");
  await second.getByTestId("truth-edit-store").fill("渋谷西口店（本館）");
  await second.getByTestId("truth-edit-apply_unit").selectOption("per_store");
  await second.getByTestId("truth-unknown-per_person_limit").check();
  await second.getByTestId("truth-note").fill("店舗ページで確認");
  await page.screenshot({ path: "test-results/ar-truth-form-390.png" });
  await second.getByTestId("truth-save").click();
  await expect(second.getByTestId("proposal-truth-state")).toContainText("正解を修正（登録）");
  await expect(second.getByTestId("proposal-truth-state")).toContainText("店舗=渋谷西口店（本館）");
  await expect(second.getByTestId("proposal-truth-state")).toContainText("不明: 口数");
  await first.getByTestId("truth-correct").click();
  await expect(first.getByTestId("proposal-truth-state")).toContainText("正しい（変更なし）");
  // 取りこぼしの記録（登録案に無い応募機会）
  await panel.getByTestId("missed-open").click();
  await panel.getByTestId("missed-note").fill("3店舗目（池袋店）の受付が登録案に無い");
  await panel.getByTestId("missed-save").click();
  await expect(panel.getByTestId("missed-form")).toContainText("記録しました");

  // DB: 正解は追記で記録（AIの出力の写しつき）・AIの値は不変・既存の記録は不変
  const reviews = (await a.from("registration_proposal_reviews").select("kind,decision,verdict,truth_decision,edits,unknown_fields,note,ai_snapshot").eq("household_id", hid).order("created_at")).data!;
  expect(reviews.map((r) => `${r.kind}:${r.verdict ?? ""}`)).toEqual(["truth:unknown_later", "truth:corrected", "truth:correct", "missed:"]);
  expect(reviews[1]).toMatchObject({ truth_decision: "register", edits: { store: "渋谷西口店（本館）", apply_unit: "per_store" }, unknown_fields: ["per_person_limit"] });
  expect(reviews[2].truth_decision).toBe("hold"); // 正しい: AIの判断（暫定=保留）をそのまま正解とする
  expect((reviews[1].ai_snapshot as { decision: string }).decision).toBeTruthy(); // 記録時点のAIの出力が残る
  expect(reviews[3].note).toContain("池袋店");
  const props = (await a.from("registration_proposals").select("item_no,fields,apply_unit,version").eq("candidate_id", candidateId).order("item_no")).data!;
  expect(props.map((p) => [p.item_no, p.version, p.apply_unit])).toEqual([[1, 1, "unknown"], [2, 1, "unknown"]]); // 人の修正でAIの値は書き換わらない
  expect((props[1].fields as { store: { value: string } }).store.value).toBe("渋谷西口店");
  expect(await counts(a, hid)).toEqual(before); // 承認しても、抽選・応募・購入・通知は作られない
  expect((await a.from("collection_candidates").select("status,job_state,draft,lottery_id").eq("id", candidateId).single()).data).toEqual(candBefore); // 候補の状態も不変（登録は従来の「確認・登録」で行う）
  await page.screenshot({ path: "test-results/10z-proposal-reviewed-390.png" });
});

test("実AIの登録案の表示（モード・費用）・再評価後の差分・集計の1行。人のレビューは版が変わっても残る（390px）", async ({ page }) => {
  test.skip(!on, "PROPOSAL_PREVIEW=on の実行だけ");
  test.setTimeout(240_000);
  await page.setViewportSize({ width: 390, height: 844 });
  await login(page);
  const { a, hid, candidateId } = await seed();
  const key = "ab12cd34ef56ab12cd34ef56";
  const base = { household_id: hid, candidate_id: candidateId, proposal_key: key, post_id: "910000001", item_no: 1, item_label: "《新宿本店（東京）- 1件》", url_status: "url_from_item", source_urls: [], link_hosts: [], decision: "tentative", verified: true, held_reasons: [], end_reason: "sufficient", apply_unit: "unknown", apply_unit_basis: "unknown", unknowns: [], pages: [], possibly_same: [], mode: "real", model_id: "claude-haiku-5-5", prompt_version: "10z-1", cost_jpy: 0.41, turns: 2, stop_reason: "sufficient" };
  const f = (store: string) => ({ store: { value: store, basis: "observed", quote: `【${store}】`, evidence: "p1", support: "literal_in_quote" }, product: { value: "拡張パック", basis: "observed", quote: "拡張パック 抽選", evidence: "p1", support: "literal_in_quote" } });
  const v1 = await a.from("registration_proposals").insert({ ...base, version: 1, input_hash: "1111111111111111", fields: f("新宿本店") as never }).select("id").single();
  expect(v1.error).toBeNull();
  await a.from("registration_proposal_reviews").insert({ household_id: hid, proposal_key: key, proposal_id: v1.data!.id, decision: "approve_with_edits", edits: { deadline: "11/30" }, note: "締切を確認", reviewed_by: (await a.auth.admin.listUsers({ perPage: 200 })).data.users.find((u) => u.email === email)!.id });

  await page.goto("/lotteries/candidates");
  await page.getByTestId("candidate-card").first().getByRole("button").first().click();
  const panel = page.getByTestId("candidate-detail").getByTestId("proposal-preview");
  await expect(panel.getByTestId("proposal-mode")).toHaveText("実AI");
  await expect(panel).toContainText("実AIが作成した登録案です（正しさは未検証。人が確認してください）");
  await expect(panel).toContainText("費用 0.41円");
  await expect(panel.getByTestId("proposal-diff")).toHaveCount(0); // まだ再評価なし

  // 再評価: 新しい版（店舗が変わる）。古い版は superseded。人のレビューは残る
  await a.from("registration_proposals").update({ superseded_at: new Date().toISOString() }).eq("id", v1.data!.id);
  const v2 = await a.from("registration_proposals").insert({ ...base, version: 2, input_hash: "2222222222222222", fields: f("新宿西口店") as never }).select("id").single();
  expect(v2.error).toBeNull();
  await page.goto("/lotteries/candidates");
  await page.getByTestId("candidate-card").first().getByRole("button").first().click();
  const p2 = page.getByTestId("candidate-detail").getByTestId("proposal-preview");
  await expect(p2.getByTestId("proposal-review-state")).toContainText("再評価で内容が変わりました");
  await expect(p2.getByTestId("proposal-diff")).toContainText("店舗: 新宿本店 → 新宿西口店");
  await expect(p2.getByTestId("proposal-diff")).toContainText("前回レビューは v1・現行は v2");
  await expect(p2.getByTestId("proposal-edit").first()).toContainText("11/30"); // 人の修正は残り、AIの値は別に表示
  await page.screenshot({ path: "test-results/phase2-proposal-real-diff-390.png" });
  await page.keyboard.press("Escape");
  const sum = page.getByTestId("proposal-summary");
  await expect(sum).toContainText("1候補・1件");
  await expect(sum).toContainText("レビュー済 1件（修正あり 1・却下 0・保留 0）");
  await expect(sum).toContainText("解決率 100%");
  await expect(sum).toContainText("費用 0.41円");
  const w = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(w).toBeLessThanOrEqual(1);
  // DB: 旧版は残り、レビューは追記のまま・抽選などは作られない
  expect((await a.from("registration_proposals").select("version,superseded_at").eq("candidate_id", candidateId).order("version")).data!.map((x) => [x.version, x.superseded_at !== null])).toEqual([[1, true], [2, false]]);
  expect((await a.from("registration_proposal_reviews").select("id").eq("household_id", hid)).data).toHaveLength(1);
  expect((await counts(a, hid)).lotteries).toBe(0);

  // 要確認の登録案（除外案・ページ確認なし／本登録案・応募単位未確定）は、判断の種別と検証の指摘が見える。除外案は「人が確認するまで採用しない」
  await a.from("registration_proposals").insert({ ...base, item_no: 2, proposal_key: "cd34ef56ab12cd34ef56ab12", version: 1, input_hash: "3333333333333333", decision: "exclude", verified: false, held_reasons: ["exclude_without_page_evidence"], fields: f("渋谷西口店") as never });
  await a.from("registration_proposals").insert({ ...base, item_no: 3, proposal_key: "ef56ab12cd34ef56ab12cd34", version: 1, input_hash: "4444444444444444", decision: "register", verified: false, held_reasons: ["register_unit_unresolved"], fields: f("池袋店") as never });
  await page.goto("/lotteries/candidates");
  await page.getByTestId("candidate-card").first().getByRole("button").first().click();
  const p3 = page.getByTestId("candidate-detail").getByTestId("proposal-preview");
  const ex = p3.getByTestId("proposal-card").filter({ has: page.getByTestId("proposal-decision").filter({ hasText: "除外案" }) });
  await expect(ex.getByTestId("proposal-decision")).toHaveText("除外案・要確認");
  await expect(ex.getByTestId("proposal-held")).toContainText("応募先のページを確認できないまま除外としている");
  await expect(ex.getByTestId("proposal-held")).toContainText("人が確認するまで採用しない");
  const rg = p3.getByTestId("proposal-card").filter({ has: page.getByTestId("proposal-decision").filter({ hasText: "本登録案" }) });
  await expect(rg.getByTestId("proposal-held")).toContainText("本登録案なのに応募単位が未確定");
  await page.screenshot({ path: "test-results/phase2-root-cause-held-390.png" });
});
