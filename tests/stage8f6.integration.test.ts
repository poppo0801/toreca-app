/**
 * Stage 8F-6 の結合テスト（実Supabase・RLS適用下・架空データのみ。有料APIなし・外部ネットワークなし）:
 *  抽選形態（店舗選択式／店舗別独立／その他）の記録・手動の優先・収集による上書きの防止、形態に基づくグループ化の判定、
 *  応募の記録の保全、誤判定（AI・収集）からの復旧。
 *   npm run test:db
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MockGroupingBrain } from "@/lib/agent/lottery-grouping/mock";
import { lotteryInputSchema } from "@/lib/lottery-input";
import { listSelectCleanup, resolveSelectCleanup, restoreArchived } from "@/lib/server/agent/select-cleanup-service";
import { saveLottery, setLotteryForm, type Db } from "@/lib/server/lottery-service";
import { auditSelectFormDuplicates, runLotteryGrouping } from "@/lib/server/agent/lottery-grouping-service";
import { adminClient, cleanupTestUsers, dbTestsEnabled, signInTestUser } from "./helpers/db";

describe.skipIf(!dbTestsEnabled)("Stage 8F-6", () => {
  const admin = adminClient();
  const ids: string[] = [];
  let u1: Db;
  let h1: string;
  let actor: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- 新しい列は生成型に含まれない場合がある
  const x = (db: unknown) => db as any;

  beforeAll(async () => {
    const a = await signInTestUser(admin, "s8f6", 1);
    ids.push(a.userId);
    u1 = a.db;
    h1 = (await u1.rpc("bootstrap_household")).data as string;
    for (let i = 0; i < 10 && !actor; i++) {
      actor = (await u1.from("profiles").select("id").order("sort_order")).data?.[0]?.id as string;
      if (!actor) await new Promise((r) => setTimeout(r, 300));
    }
  });
  afterAll(async () => {
    await cleanupTestUsers(admin, ids);
  });

  const mkChain = async (name: string) => (await u1.from("chains").insert({ household_id: h1, name } as never).select("id").single()).data!.id as string;
  const mkStore = async (chainId: string, name: string) => (await u1.from("stores").insert({ household_id: h1, chain_id: chainId, name, prefecture: "兵庫県" } as never).select("id").single()).data!.id as string;
  const mkProduct = async (name: string) => (await u1.from("products").insert({ household_id: h1, official_name: name, packs_per_box: 20 } as never).select("id").single()).data!.id as string;
  const input = (chain: string, product: string, store: { id: string | null; name: string }, over: Record<string, unknown> = {}) =>
    lotteryInputSchema.parse({
      chain: { id: chain, name: "" }, store: { id: store.id, name: store.name, prefecture: "" }, campaignId: null, newCampaign: null,
      items: [{ product: { id: product, name: "" }, quantity: 1, unit: "box" }],
      applyStart: { precision: "date_only", date: "2099-01-01", time: "" }, applyDeadline: { precision: "date_only", date: "2099-01-10", time: "" }, resultDate: { precision: "date_only", date: "2099-01-15", time: "" },
      procedureDeadline: { precision: "unknown", date: "", time: "" }, receiveMethod: "store", applyMethod: "web", conditionsText: "会員登録が必要です。1人1口まで。", verificationText: "", announcementMethod: "", announcementUrl: "",
      sourceUrls: [], eventState: "open", limitBasis: "account", limitMaxCount: 1, memo: "", ...over,
    });
  const mkSet = async (label: string, n: number, text: string) => {
    const chain = await mkChain(`8F6${label}チェーン`);
    const product = await mkProduct(`8F6${label}商品`);
    const lots: string[] = [];
    for (let i = 0; i < n; i++) {
      const store = await mkStore(chain, `8F6${label}店${i + 1}`);
      const r = await saveLottery(u1, h1, null, input(chain, product, { id: store, name: `8F6${label}店${i + 1}` }, { conditionsText: text, sourceUrls: [`https://example.invalid/8f6/${label}/shop-${i + 1}`] }), actor);
      expect(r.ok, JSON.stringify(r)).toBe(true);
      lots.push(r.ok ? r.value.id : "");
    }
    return { chain, product, lots };
  };
  const row = async (id: string) => (await x(u1).from("lotteries").select("store_mode,lottery_form,lottery_form_source,bulk_group_id,apply_deadline_date,conditions_text,source_urls").eq("id", id).single()).data;
  const run = (id: string) => runLotteryGrouping(u1, h1, id, { llm: new MockGroupingBrain("careful"), allowAuto: true, asService: false, actor, followUps: 0 });

  it("利用者が店舗の指定方式を変えると、手動の分類として記録される。初期値の『店舗固定』で新規登録しただけでは記録されない", async () => {
    const { lots } = await mkSet("記録", 1, "会員登録が必要です。");
    expect((await row(lots[0])).lottery_form).toBeNull();
    const cur = (await row(lots[0])).store_mode;
    expect(cur).toBe("fixed");
    // 店舗選択式へ変更（利用者）
    const chain = (await x(u1).from("lotteries").select("chain_id,store_id").eq("id", lots[0]).single()).data;
    const r = await saveLottery(u1, h1, lots[0], input(chain.chain_id, (await x(u1).from("lottery_items").select("product_id").eq("lottery_id", lots[0])).data[0].product_id, { id: null, name: "応募時に店舗選択" }, { storeMode: "select_on_apply", selectableStores: [{ name: "A店", prefecture: "" }, { name: "B店", prefecture: "" }] }), actor);
    expect(r.ok, JSON.stringify(r)).toBe(true);
    const after = await row(lots[0]);
    expect(after.store_mode).toBe("select_on_apply");
    expect(after.lottery_form).toBe("store_select");
    expect(after.lottery_form_source).toBe("manual");
  });

  it("手動の分類は、収集・AI（自動）の保存で上書きされない。解除すると構造からの判別に戻る。応募の記録・店舗の指定方式・期限は変わらない", async () => {
    const { chain, product, lots } = await mkSet("手動", 1, "会員登録が必要です。");
    const id = lots[0];
    const accountId = (await x(u1).from("accounts").select("id").eq("household_id", h1).limit(1)).data?.[0]?.id as string | undefined;
    if (accountId) expect((await x(u1).from("applications").insert({ household_id: h1, lottery_id: id, account_id: accountId, state: "applied", applied_at: new Date().toISOString() })).error).toBeNull();
    const appsBefore = (await x(u1).from("applications").select("id,state,result").eq("lottery_id", id).order("id")).data;
    expect((await setLotteryForm(u1, id, "store_independent", actor)).ok).toBe(true);
    let a = await row(id);
    expect([a.lottery_form, a.lottery_form_source]).toEqual(["store_independent", "manual"]);
    // 自動収集としての保存（方式を変える内容）は、手動の分類に触れない
    const st = (await x(u1).from("lotteries").select("store_id").eq("id", id).single()).data.store_id as string;
    const auto = await saveLottery(u1, h1, id, input(chain, product, { id: st, name: "" }, { storeMode: "select_on_apply" }), actor, { autoCollected: true });
    expect(auto.ok, JSON.stringify(auto)).toBe(true);
    a = await row(id);
    expect([a.lottery_form, a.lottery_form_source]).toEqual(["store_independent", "manual"]);
    const before = a;
    // 利用者が手動で戻す（誤判定からの復旧）
    expect((await setLotteryForm(u1, id, null, actor)).ok).toBe(true);
    a = await row(id);
    expect([a.lottery_form, a.lottery_form_source]).toEqual([null, null]);
    // 応募の記録・期限・情報源は、分類の操作で変わらない
    expect((await x(u1).from("applications").select("id,state,result").eq("lottery_id", id).order("id")).data).toEqual(appsBefore);
    expect(a.apply_deadline_date).toBe(before.apply_deadline_date);
    expect(a.source_urls).toEqual(before.source_urls);
    expect((await setLotteryForm(u1, id, "invalid" as never, actor)).ok).toBe(false);
  });

  it("店舗選択式の構造（応募時に店舗を選ぶ記載）を持つ抽選を店舗別に登録していても、グループ化しない。重複登録の整理の対象であり、自動で削除・変更しない", async () => {
    const { lots } = await mkSet("選択", 3, "応募フォームで受取店舗を選択してください。会員登録が必要です。");
    const before = await Promise.all(lots.map(row));
    const r = await run(lots[2]);
    expect(r.tier === "auto" || r.status === "applied", `${r.status}/${r.tier}`).toBe(false);
    for (const id of lots) expect((await row(id)).bulk_group_id).toBeNull();
    expect(await Promise.all(lots.map(row))).toEqual(before);
    // 整理候補として洗い出す（読み取りのみ。応募の記録があるカードは protectedIds。削除・統合・変更はしない）
    const accountId = (await x(u1).from("accounts").select("id").eq("household_id", h1).limit(1)).data?.[0]?.id as string | undefined;
    if (accountId) expect((await x(u1).from("applications").insert({ household_id: h1, lottery_id: lots[0], account_id: accountId, state: "applied", applied_at: new Date().toISOString() })).error).toBeNull();
    const cleanup = (await auditSelectFormDuplicates(u1, h1)).find((c) => lots.every((id) => c.perStoreIds.includes(id)));
    expect(cleanup, "整理候補に含まれる").toBeTruthy();
    if (accountId) expect(cleanup!.protectedIds).toEqual([lots[0]]);
    expect(await Promise.all(lots.map(row))).toEqual(before);
    expect((await u1.from("lotteries").select("id").in("id", lots)).data).toHaveLength(3);
  });

  it("制限だけ（1店舗のみ応募）では店舗選択式と断定せず、自動にしない（候補）。利用者が手動で『店舗別独立』と確認すれば、グループ化の対象になる", async () => {
    const { lots } = await mkSet("制限", 2, "お一人様につき対象店舗の中から1店舗のみ応募できます。会員登録が必要です。");
    const r1 = await run(lots[1]);
    expect(r1.tier).not.toBe("auto");
    for (const id of lots) expect((await row(id)).bulk_group_id).toBeNull();
    for (const id of lots) expect((await setLotteryForm(u1, id, "store_independent", actor)).ok).toBe(true);
    const r2 = await run(lots[1]);
    expect(r2.status, r2.message).toBe("applied");
    expect(r2.tier).toBe("auto");
    expect((await row(lots[0])).bulk_group_id).toBe((await row(lots[1])).bulk_group_id);
  });

  it("店舗ごとに受付する構造の記載があれば、制限があっても店舗別独立抽選として自動でグループ化。店舗ごとの抽選は独立のまま", async () => {
    const { lots } = await mkSet("独立", 2, "各店舗で受付・抽選を行います。複数店舗への応募は無効です。会員登録が必要です。");
    const before = await Promise.all(lots.map(row));
    const r = await run(lots[0]);
    expect(r.status, r.message).toBe("applied");
    expect(r.tier).toBe("auto");
    const after = await Promise.all(lots.map(row));
    expect(after.map((a) => [a.apply_deadline_date, a.conditions_text, a.source_urls, a.store_mode])).toEqual(before.map((a) => [a.apply_deadline_date, a.conditions_text, a.source_urls, a.store_mode]));
    expect(after[0].bulk_group_id).toBeTruthy();
    expect(after[0].bulk_group_id).toBe(after[1].bulk_group_id);
  });

  it("【8F-7 整理】店舗選択式のカードと同じ情報源の店舗別カードを整理候補に出す。『整理する』は応募の記録が無いカードだけを退避（物理削除しない）、記録のあるカードは触らない。元に戻せる", async () => {
    const chain = await mkChain("8F7整理チェーン");
    const product = await mkProduct("8F7整理商品");
    const url = "https://example.invalid/8f7/cleanup-1";
    const sel = await saveLottery(u1, h1, null, input(chain, product, { id: null, name: "応募時に店舗選択" }, { storeMode: "select_on_apply", selectableStores: [{ name: "A店", prefecture: "" }, { name: "B店", prefecture: "" }], sourceUrls: [url] }), actor);
    expect(sel.ok, JSON.stringify(sel)).toBe(true);
    const per: string[] = [];
    for (let i = 0; i < 2; i++) {
      const st = await mkStore(chain, `8F7整理店${i + 1}`);
      const r = await saveLottery(u1, h1, null, input(chain, product, { id: st, name: "" }, { sourceUrls: [url] }), actor);
      expect(r.ok, JSON.stringify(r)).toBe(true);
      per.push(r.ok ? r.value.id : "");
    }
    const accountId = (await x(u1).from("accounts").select("id").eq("household_id", h1).limit(1)).data?.[0]?.id as string | undefined;
    if (accountId) expect((await x(u1).from("applications").insert({ household_id: h1, lottery_id: per[0], account_id: accountId, state: "applied", applied_at: new Date().toISOString() })).error).toBeNull();
    const view = (await listSelectCleanup(u1, h1)).find((c) => per.every((id) => c.cards.some((k) => k.id === id)));
    expect(view, "整理候補に出る").toBeTruthy();
    expect(view!.selectCardId).toBe(sel.ok ? sel.value.id : "");
    expect(view!.cards.filter((k) => k.protectedCard).map((k) => k.id)).toEqual(accountId ? [per[0]] : []);
    // 画面から渡された別のkeyでは実行できない
    expect((await resolveSelectCleanup(u1, h1, { key: "unknown", decision: "consolidate" }, actor)).ok).toBe(false);
    const r = await resolveSelectCleanup(u1, h1, { key: view!.key, decision: "consolidate" }, actor);
    expect(r.ok, JSON.stringify(r)).toBe(true);
    const archivedRows = (await x(u1).from("lotteries").select("id,archived_at").in("id", per)).data as { id: string; archived_at: string | null }[];
    expect(archivedRows).toHaveLength(2); // 物理削除しない
    if (accountId) {
      expect(archivedRows.find((a) => a.id === per[0])!.archived_at).toBeNull(); // 応募の記録があるカードは退避しない
      expect(archivedRows.find((a) => a.id === per[1])!.archived_at).not.toBeNull();
      expect((await x(u1).from("applications").select("id").eq("lottery_id", per[0])).data).toHaveLength(1);
    }
    // 元に戻す
    const gone = per.filter((id) => archivedRows.find((a) => a.id === id)!.archived_at);
    for (const id of gone) expect((await restoreArchived(u1, h1, id, actor)).ok).toBe(true);
    expect(((await x(u1).from("lotteries").select("archived_at").in("id", per)).data as { archived_at: string | null }[]).every((a) => a.archived_at === null)).toBe(true);
    expect((await restoreArchived(u1, h1, per[0], actor)).ok).toBe(false); // 退避していないものは対象外
  });

  it("【8F-7 整理】『別の抽選として残す』は手動の分類（店舗別独立）を記録し、候補から外れる。分類を解除すると候補に戻る（誤操作からの復旧）。店舗選択式のカードが無い組では整理（退避）できない", async () => {
    const chain = await mkChain("8F7残すチェーン");
    const product = await mkProduct("8F7残す商品");
    const ids: string[] = [];
    for (let i = 0; i < 2; i++) {
      const st = await mkStore(chain, `8F7残す店${i + 1}`);
      const r = await saveLottery(u1, h1, null, input(chain, product, { id: st, name: "" }, { conditionsText: "応募フォームで受取店舗を選択してください。", sourceUrls: [`https://example.invalid/8f7/keep-${i}`] }), actor);
      ids.push(r.ok ? r.value.id : "");
    }
    const find = async () => (await listSelectCleanup(u1, h1)).find((c) => ids.every((id) => c.cards.some((k) => k.id === id)));
    const v = await find();
    expect(v, "店舗選択欄の構造があるため候補").toBeTruthy();
    expect(v!.selectCardId).toBeNull();
    expect((await resolveSelectCleanup(u1, h1, { key: v!.key, decision: "consolidate" }, actor)).ok).toBe(false);
    expect((await resolveSelectCleanup(u1, h1, { key: v!.key, decision: "keep_separate" }, actor)).ok).toBe(true);
    for (const id of ids) expect([(await row(id)).lottery_form, (await row(id)).lottery_form_source]).toEqual(["store_independent", "manual"]);
    expect(await find()).toBeUndefined();
    for (const id of ids) expect((await setLotteryForm(u1, id, null, actor)).ok).toBe(true);
    expect(await find()).toBeTruthy();
  });
});
