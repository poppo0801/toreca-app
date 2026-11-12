import { createClient } from "@supabase/supabase-js";
import { expect, test, type Page } from "@playwright/test";

/**
 * Stage 8D-5: 反映候補の一括操作（開発用・ローカルDB・架空データ）。
 *   E2E_SPEC=stage8d5.supabase.spec.ts npm run test:e2e:supabase
 *  - 複数候補の一覧・絞り込み → 選択 → 一括承認の事前確認（実行件数・対象外とその理由・変更内容）→ 実行 → 件ごとの結果
 *  - 対象外（候補・既存の住所あり）は反映されない。スマートフォン幅で横にはみ出さない
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

test("一括承認: 事前確認で実行件数・対象外の理由・変更内容を確認でき、対象外は反映されない。結果が件ごとに出る", async ({ page }) => {
  test.setTimeout(150_000);
  await login(page);
  const hid = await household();
  const a = admin();
  const chain = (await a.from("chains").insert({ household_id: hid, name: "一括テスト堂" }).select("id").single()).data!.id as string;
  let n = 0;
  const make = async (name: string, over: { research?: "confirmed" | "candidate"; official?: string; address?: string } = {}) => {
    n++;
    const addr = `東京都架空区一括町${n}-2-3`;
    const store = (await a.from("stores").insert({ household_id: hid, chain_id: chain, name, prefecture: "", address_optional: over.address ?? "" }).select("id").single()).data!.id as string;
    const research = (await a.from("store_location_research").insert({
      household_id: hid, store_id: store, chain_name: "一括テスト堂", store_name: name, status: over.research ?? "confirmed", address: addr, prefecture: "東京都", city: "架空区", latitude: 35.7, longitude: 139.7,
      confidence: 70, engine: "mock-brain", sources: [{ url: "https://bulk-official.test/shop", quote: "住所", official: true, domain: "bulk-official.test" }], reasons: ["公式に店舗名と住所がある"],
    }).select("id").single()).data!.id as string;
    const { error } = await a.from("store_location_proposals").insert({
      household_id: hid, store_id: store, research_id: research, chain_name: "一括テスト堂", store_name: name, current_address: over.address ?? "", current_prefecture: "",
      proposed_address: addr, proposed_key: addr, proposed_prefecture: "東京都", proposed_latitude: 35.7, proposed_longitude: 139.7,
      research_status: over.research ?? "confirmed", confidence: 70, official_status: over.official ?? "verified", reasons: ["公式に店舗名と住所がある"],
      sources: [{ url: "https://bulk-official.test/shop", quote: "住所", official: true, domain: "bulk-official.test" }],
      diff: [{ field: "address", before: over.address ?? "", after: addr }],
    });
    if (error) throw error;
    return { store, addr };
  };
  const s1 = await make("一括1号店");
  const s2 = await make("一括2号店");
  const s3 = await make("一括3号店（候補）", { research: "candidate", official: "candidate" });
  const s4 = await make("一括4号店（既存住所）", { address: "東京都架空区既存の住所9-9-9" });

  await page.goto("/settings/store-research");
  await expect(page.getByTestId("proposal-card")).toHaveCount(4);
  await expect(page.getByTestId("proposal-counts")).toContainText("要対応 4件（うち確認済み 3件）");
  // 絞り込み: 調査結果が確認済みのものだけ
  await page.getByTestId("proposal-filter-research").selectOption("confirmed");
  await expect(page.getByTestId("proposal-card")).toHaveCount(3);
  await page.getByTestId("proposal-filter-research").selectOption("all");

  await page.getByTestId("proposal-select-all").check();
  await expect(page.getByTestId("proposal-selected-count")).toContainText("選択 4件");
  await page.getByTestId("proposal-bulk-apply").click();
  const confirm = page.getByTestId("proposal-bulk-confirm");
  await expect(confirm).toContainText("実行 2件／対象外 2件");
  await expect(page.getByTestId("proposal-bulk-targets")).toContainText(`未登録 → ${s1.addr}`); // 変更内容
  await expect(page.getByTestId("proposal-bulk-blocked")).toContainText("確認済み"); // 候補は対象外
  await expect(page.getByTestId("proposal-bulk-blocked")).toContainText("既存の住所");
  // 事前確認の段階では、店舗は変わらない
  expect((await a.from("stores").select("address_optional").eq("id", s1.store).single()).data!.address_optional).toBe("");

  await page.getByTestId("proposal-bulk-run").click();
  const results = page.getByTestId("proposal-bulk-results");
  await expect(results).toContainText("成功 2件／実行できなかった 2件");
  await expect(page.getByTestId("proposal-bulk-ok")).toHaveCount(2);
  await expect(page.getByTestId("proposal-bulk-ng")).toHaveCount(2);
  expect((await a.from("stores").select("address_optional").eq("id", s1.store).single()).data!.address_optional).toBe(s1.addr);
  expect((await a.from("stores").select("address_optional").eq("id", s2.store).single()).data!.address_optional).toBe(s2.addr);
  expect((await a.from("stores").select("address_optional").eq("id", s3.store).single()).data!.address_optional).toBe(""); // 候補は反映されない
  expect((await a.from("stores").select("address_optional").eq("id", s4.store).single()).data!.address_optional).toBe("東京都架空区既存の住所9-9-9"); // 既存の住所は上書きしない
  const applied = (await a.from("store_location_proposal_events").select("action").eq("action", "applied")).data!;
  expect(applied).toHaveLength(2); // 店舗ごとの操作履歴

  // 要対応の一覧には、反映していない2件だけが残る。横にはみ出さない
  await expect(page.getByTestId("proposal-card")).toHaveCount(2);
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth);
  expect(overflow).toBe(false);
});

test("一括却下・一括保留: 状態だけが変わり、店舗は変わらない。確認画面で戻れる", async ({ page }) => {
  test.setTimeout(150_000);
  await login(page);
  const hid = await household();
  const a = admin();
  const chain = (await a.from("chains").insert({ household_id: hid, name: "保留テスト堂" }).select("id").single()).data!.id as string;
  const mk = async (name: string, i: number) => {
    const addr = `東京都架空区保留町${i}-1-1`;
    const store = (await a.from("stores").insert({ household_id: hid, chain_id: chain, name, prefecture: "" }).select("id").single()).data!.id as string;
    const research = (await a.from("store_location_research").insert({ household_id: hid, store_id: store, chain_name: "保留テスト堂", store_name: name, status: "confirmed", address: addr, confidence: 70, engine: "mock-brain" }).select("id").single()).data!.id as string;
    await a.from("store_location_proposals").insert({ household_id: hid, store_id: store, research_id: research, chain_name: "保留テスト堂", store_name: name, proposed_address: addr, proposed_key: addr, research_status: "confirmed", confidence: 70, official_status: "verified", diff: [{ field: "address", before: "", after: addr }] });
    return store;
  };
  const s1 = await mk("保留1号店", 1);
  const s2 = await mk("保留2号店", 2);
  await page.goto("/settings/store-research"); // 同じ世帯に前のテストの未処理の候補が2件ある（合計4件）
  await page.getByTestId("proposal-select-all").check();
  await page.getByTestId("proposal-bulk-hold").click();
  await expect(page.getByTestId("proposal-bulk-confirm")).toContainText("実行 4件／対象外 0件");
  await page.getByTestId("proposal-bulk-cancel").click(); // 戻れる（何も実行されない）
  await expect(page.getByTestId("proposal-bulk-confirm")).toHaveCount(0);
  await expect(page.getByTestId("proposal-status").first()).toHaveText("承認待ち");
  await page.getByTestId("proposal-bulk-hold").click();
  await page.getByTestId("proposal-bulk-run").click();
  await expect(page.getByTestId("proposal-bulk-results")).toContainText("成功 4件");
  await expect(page.getByTestId("proposal-status").first()).toHaveText("保留");
  await page.getByTestId("proposal-select-all").check();
  await page.getByTestId("proposal-bulk-reject").click();
  await page.getByTestId("proposal-bulk-run").click();
  await expect(page.getByTestId("proposal-bulk-results")).toContainText("成功 4件");
  for (const s of [s1, s2]) expect((await a.from("stores").select("address_optional").eq("id", s).single()).data!.address_optional).toBe("");
  await page.getByTestId("proposal-filter-state").selectOption("closed");
  await expect(page.getByTestId("proposal-card")).toHaveCount(4);
});
