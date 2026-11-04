/**
 * Stage 5R の結合テスト（実Supabase・RLS適用下。架空データのみ）:
 * 系列条件の保存（AND/OR・並び・アーカイブ）、購入履歴からの自動判定（購入・訂正・取消の反映、当選だけでは購入にならない）、
 * プロフィール別の手動状態、サブユーザーの制限、他世帯からの保護、AI解析（抽選の条件）による系列条件の非変更。
 *   npm run test:db
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { evaluateChain, evaluateLottery, purchaseFacts } from "@/lib/chain-conditions";
import { saveChainConditions, setConditionState } from "@/lib/server/conditions-service";
import { deleteExpense } from "@/lib/server/finance-service";
import { addManualPurchase, loadAppData, setApplied, setResult, updateProfileSettings, type Db } from "@/lib/server/lottery-service";
import { EMPTY_FLEX } from "@/lib/lottery-input";
import { jstDateString } from "@/lib/datetime";
import { saveLegacy as saveLottery, type LegacyInput } from "./helpers/legacy";
import { adminClient, cleanupTestUsers, dbTestsEnabled, signInTestUser } from "./helpers/db";

describe.skipIf(!dbTestsEnabled)("Stage 5R: 系列別抽選条件・資格状況", () => {
  const admin = adminClient();
  const userIds: string[] = [];
  let u1: Db;
  let u2: Db;
  let hid: string;
  let profs: { id: string; label: string; color: string }[];
  let chainX: string;
  let chainY: string;
  let storeX: string;
  let p1: string;
  let lotX: string;
  const [A, B, C] = [0, 1, 2];
  const today = jstDateString(new Date());
  const daysAgo = (n: number) => jstDateString(new Date(Date.now() - n * 86_400_000));

  const must = async (p: PromiseLike<{ data: unknown; error: unknown }>) => {
    const { data, error } = await p;
    expect(JSON.stringify(error)).toBe("null");
    return data as { id: string };
  };
  const base = (chainId: string, storeId: string): LegacyInput => ({
    chainId, storeId, campaignId: null, newCampaign: null,
    items: [{ productId: p1, quantity: 1, unit: "box" }], multiMode: "single",
    applyStart: EMPTY_FLEX, applyDeadline: { precision: "date_only", date: "2099-01-10", time: "" }, resultDate: EMPTY_FLEX,
    procedureStart: EMPTY_FLEX, procedureDeadline: EMPTY_FLEX, receiveMethod: "store", applyMethod: "web",
    conditionsText: "", verificationText: "", announcementMethod: "", announcementUrl: "", sourceUrls: [],
    eventState: "open", limitBasis: "account", limitMaxCount: 5, memo: "", applications: [], appliedAt: "",
  });
  const conds = async () => (await loadAppData(u1)).chainConditions ?? [];
  const purchase = { baseDaysBefore: 0, windowDays: 365, minAmountYen: 3000 };
  const evalOf = async (idx: number) => evaluateChain(await loadAppData(u1), chainX, profs[idx].id, { today });

  beforeAll(async () => {
    const a = await signInTestUser(admin, "s5r", 1);
    const b = await signInTestUser(admin, "s5r", 2);
    userIds.push(a.userId, b.userId);
    u1 = a.db;
    u2 = b.db;
    hid = (await u1.rpc("bootstrap_household")).data as string;
    await u2.rpc("bootstrap_household");
    profs = (await u1.from("profiles").select("id,label,color").order("sort_order")).data!;
    chainX = (await must(u1.from("chains").insert({ household_id: hid, name: "条件X" }).select("id").single())).id;
    chainY = (await must(u1.from("chains").insert({ household_id: hid, name: "条件Y" }).select("id").single())).id;
    storeX = (await must(u1.from("stores").insert({ household_id: hid, chain_id: chainX, name: "X店", prefecture: "兵庫県" }).select("id").single())).id;
    p1 = (await must(u1.from("products").insert({ household_id: hid, official_name: "5R商品", packs_per_box: 20 }).select("id").single())).id;
    const lx = await saveLottery(u1, hid, null, base(chainX, storeX), profs[A].id);
    if (!lx.ok) throw new Error("setup");
    lotX = lx.value.id;
  });
  afterAll(async () => {
    await cleanupTestUsers(admin, userIds);
  });

  it("条件を保存すると並び・AND/OR・購入条件の数値が保持される。購入条件は期間が必須", async () => {
    const bad = await saveChainConditions(u1, hid, chainX, [{ kind: "purchase", label: "", note: "", joinPrev: "and", params: { baseDaysBefore: 0 } }], profs[A].id);
    expect(bad.ok).toBe(false);
    const r = await saveChainConditions(
      u1, hid, chainX,
      [
        { kind: "app_account", label: "公式アプリ", note: "", joinPrev: "or" }, // 先頭の or は and として扱う
        { kind: "purchase", label: "", note: "直近1年", joinPrev: "or", params: purchase },
        { kind: "line", label: "", note: "", joinPrev: "and" },
      ],
      profs[A].id,
    );
    expect(r.ok).toBe(true);
    const list = (await conds()).filter((c) => c.chainId === chainX);
    expect(list.map((c) => [c.kind, c.joinPrev])).toEqual([["app_account", "and"], ["purchase", "or"], ["line", "and"]]);
    expect(list[1].params).toMatchObject(purchase);
  });

  it("購入履歴の条件は購入記録から自動判定。購入の追加・取消で再計算される。他のプロフィールには影響しない", async () => {
    expect((await evalOf(A)).results[1].state).toBe("unmet");
    const add = await addManualPurchase(u1, hid, { storeId: storeX, date: daysAgo(30), time: "", channel: "store", note: "", items: [{ productId: p1, quantity: 1, unit: "box", amountPaid: 4000 }] }, profs[A].id);
    expect(add.ok).toBe(true);
    if (!add.ok) return;
    const a1 = await evalOf(A);
    expect(a1.results[1].state).toBe("met");
    expect(a1.results[1].purchase?.amount).toBe(4000);
    expect(a1.results[1].purchase?.remaining.kind).toBe("months");
    expect((await evalOf(B)).results[1].state).toBe("unmet");
    // 取り消し（アーカイブ）すると未達成に戻る
    expect((await deleteExpense(u1, add.value.id, profs[A].id)).ok).toBe(true);
    expect((await evalOf(A)).results[1].state).toBe("unmet");
  });

  it("当選しただけでは購入として扱わない。別系列の購入は混同しない", async () => {
    await u1.rpc("ensure_profile_accounts");
    const acc = (await u1.from("service_accounts").select("id,managed_by_profile_id").eq("chain_id", chainX)).data!.find((a) => a.managed_by_profile_id === profs[A].id)!;
    expect((await setApplied(u1, hid, lotX, acc.id, true, profs[A].id)).ok).toBe(true);
    const app = (await u1.from("applications").select("id").eq("lottery_id", lotX).eq("service_account_id", acc.id).single()).data!;
    expect((await setResult(u1, app.id, "won", profs[A].id)).ok).toBe(true);
    const d1 = await loadAppData(u1);
    expect(purchaseFacts(d1).filter((f) => f.buyerProfileId === profs[A].id && f.chainId === chainX)).toHaveLength(0);
    expect(evaluateChain(d1, chainX, profs[A].id, { today }).results[1].state).toBe("unmet");
    const storeY = (await must(u1.from("stores").insert({ household_id: hid, chain_id: chainY, name: "Y店", prefecture: "大阪府" }).select("id").single())).id;
    await addManualPurchase(u1, hid, { storeId: storeY, date: daysAgo(10), time: "", channel: "store", note: "", items: [{ productId: p1, quantity: 1, unit: "box", amountPaid: 9000 }] }, profs[A].id);
    expect((await evalOf(A)).results[1].state).toBe("unmet");
  });

  it("手動の達成状況はプロフィール別に保存・更新でき（冪等）、最終確認日を持つ。購入条件には保存できない", async () => {
    const list = (await conds()).filter((c) => c.chainId === chainX);
    const line = list.find((c) => c.kind === "line")!;
    expect((await setConditionState(u1, hid, line.id, profs[A].id, "met", today, profs[A].id)).ok).toBe(true);
    expect((await setConditionState(u1, hid, line.id, profs[A].id, "met", today, profs[A].id)).ok).toBe(true);
    expect((await setConditionState(u1, hid, line.id, profs[B].id, "unmet", today, profs[A].id)).ok).toBe(true);
    const d = await loadAppData(u1);
    const st = (d.chainConditionStates ?? []).filter((s) => s.conditionId === line.id);
    expect(st).toHaveLength(2);
    expect(st.find((s) => s.profileId === profs[A].id)).toMatchObject({ state: "met", confirmedOn: today });
    expect(evaluateChain(d, chainX, profs[B].id, { today }).results[2].state).toBe("unmet");
    const purchaseCond = list.find((c) => c.kind === "purchase")!;
    expect((await setConditionState(u1, hid, purchaseCond.id, profs[A].id, "met", today, profs[A].id)).ok).toBe(false);
    expect((await setConditionState(u1, hid, line.id, profs[A].id, "unknown", today, profs[A].id)).ok).toBe(true);
    expect(((await loadAppData(u1)).chainConditionStates ?? []).find((s) => s.conditionId === line.id && s.profileId === profs[A].id)?.confirmedOn).toBeNull();
  });

  it("条件を外すとアーカイブされる（物理削除しない）。達成状況の行は残り、画面からは消える", async () => {
    const before = (await u1.from("chain_conditions").select("id").eq("chain_id", chainX)).data!.length;
    const keep = (await conds()).filter((c) => c.chainId === chainX && c.kind !== "line").map((c) => ({ id: c.id, kind: c.kind, label: c.label, note: c.note, joinPrev: c.joinPrev, params: c.params }));
    expect((await saveChainConditions(u1, hid, chainX, keep, profs[A].id)).ok).toBe(true);
    expect((await u1.from("chain_conditions").select("id").eq("chain_id", chainX)).data!.length).toBe(before);
    expect((await conds()).filter((c) => c.chainId === chainX && c.kind === "line")).toHaveLength(0);
    expect(((await u1.from("chain_conditions").select("id").eq("chain_id", chainX).not("archived_at", "is", null)).data ?? []).length).toBe(1);
    expect(((await u1.from("chain_condition_states").select("id")).data ?? []).length).toBeGreaterThan(0);
  });

  it("抽選の条件の変更（AI解析・手動）は系列条件を変更しない。差は表示だけ", async () => {
    const before = JSON.stringify((await conds()).filter((c) => c.chainId === chainX));
    await u1.from("lotteries").update({ requirement_tags: ["purchase_amount"], requirement_details: { minAmountYen: 5000 } }).eq("id", lotX);
    const d = await loadAppData(u1);
    expect(JSON.stringify((d.chainConditions ?? []).filter((c) => c.chainId === chainX))).toBe(before);
    const ev = evaluateLottery(d, d.lotteries.find((l) => l.id === lotX)!, profs[A].id, today)!;
    expect(ev.mismatches.some((m) => m.includes("5,000円以上"))).toBe(true);
  });

  it("サブユーザーは対象外の系列の条件を変更できない。他のユーザーの達成状況も変更できない", async () => {
    const r = await updateProfileSettings(u1, profs[C].id, { label: profs[C].label, color: profs[C].color as "blue", colorHex: null, iconMark: "initial", notifyRecipientIds: null, kind: "sub", targetChainIds: [chainY] }, profs[A].id);
    expect(r.ok).toBe(true);
    expect((await saveChainConditions(u1, hid, chainX, [{ kind: "line", label: "", note: "", joinPrev: "and" }], profs[C].id)).ok).toBe(false);
    expect((await saveChainConditions(u1, hid, chainY, [{ kind: "member_card", label: "", note: "", joinPrev: "and" }], profs[C].id)).ok).toBe(true);
    const mc = (await conds()).find((c) => c.chainId === chainY)!;
    expect((await setConditionState(u1, hid, mc.id, profs[A].id, "met", today, profs[C].id)).ok).toBe(false);
    expect((await setConditionState(u1, hid, mc.id, profs[C].id, "met", today, profs[C].id)).ok).toBe(true);
  });

  it("他世帯のユーザーは系列条件・達成状況を読めず、書き込めない（RLS）", async () => {
    expect(((await u2.from("chain_conditions").select("id")).data ?? []).length).toBe(0);
    expect(((await u2.from("chain_condition_states").select("id")).data ?? []).length).toBe(0);
    expect((await u2.from("chain_conditions").insert({ household_id: hid, chain_id: chainX, kind: "line", label: "x" })).error).not.toBeNull();
  });

  it("不正な種類・長すぎる文はDBの制約で拒否される", async () => {
    expect((await u1.from("chain_conditions").insert({ household_id: hid, chain_id: chainX, kind: "bogus" })).error).not.toBeNull();
    expect((await u1.from("chain_conditions").insert({ household_id: hid, chain_id: chainX, kind: "other", label: "あ".repeat(201) })).error).not.toBeNull();
  });
});
