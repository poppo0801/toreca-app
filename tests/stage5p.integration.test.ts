/**
 * Stage 5P の結合テスト（実Supabase・RLS適用下。架空データのみ）:
 * 購入明細の数量単位「個」、メイン／サブユーザー（種別・対象系列の保存、更新処理での系列の制限、履歴の保持、系列の別名、他世帯からの保護）。
 *   npm run test:db
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { EMPTY_FLEX } from "@/lib/lottery-input";
import { addManualPurchase, loadAppData, setApplied, setFulfillment, setLotterySkip, setManaged, setResult, updateProfileSettings, type Db } from "@/lib/server/lottery-service";
import { saveLegacy as saveLottery, type LegacyInput } from "./helpers/legacy";
import { adminClient, cleanupTestUsers, dbTestsEnabled, signInTestUser } from "./helpers/db";

describe.skipIf(!dbTestsEnabled)("Stage 5P: 個の単位・メイン／サブユーザー", () => {
  const admin = adminClient();
  const userIds: string[] = [];
  let u1: Db;
  let u2: Db;
  let hid: string;
  let profs: { id: string; label: string; color: string }[];
  let chainX: string;
  let chainY: string;
  let storeX: string;
  let storeY: string;
  let p1: string;
  let lotX: string;
  let lotY: string;
  const [A, B, C] = [0, 1, 2];

  const must = async (p: PromiseLike<{ data: unknown; error: unknown }>) => {
    const { data, error } = await p;
    expect(JSON.stringify(error)).toBe("null");
    return data as { id: string };
  };
  const base = (chainId: string, storeId: string): LegacyInput => ({
    chainId, storeId, campaignId: null, newCampaign: null,
    items: [{ productId: p1, quantity: 1, unit: "box" }],
    multiMode: "single",
    applyStart: EMPTY_FLEX, applyDeadline: { precision: "date_only", date: "2099-01-10", time: "" }, resultDate: EMPTY_FLEX,
    procedureStart: EMPTY_FLEX, procedureDeadline: EMPTY_FLEX, receiveMethod: "store", applyMethod: "web",
    conditionsText: "", verificationText: "", announcementMethod: "", announcementUrl: "", sourceUrls: [],
    eventState: "open", limitBasis: "account", limitMaxCount: 5, memo: "", applications: [], appliedAt: "",
  });
  const profileInput = (i: number, extra: Record<string, unknown> = {}) => ({
    label: profs[i].label,
    color: profs[i].color as "blue",
    colorHex: null,
    iconMark: "initial",
    notifyRecipientIds: null,
    ...extra,
  });
  const accountOf = async (profileIdx: number, chainId: string) => {
    await u1.rpc("ensure_profile_accounts");
    return (await u1.from("service_accounts").select("id,managed_by_profile_id").eq("chain_id", chainId)).data!.find((a) => a.managed_by_profile_id === profs[profileIdx].id)!;
  };

  beforeAll(async () => {
    const a = await signInTestUser(admin, "s5p", 1);
    const b = await signInTestUser(admin, "s5p", 2);
    userIds.push(a.userId, b.userId);
    u1 = a.db;
    u2 = b.db;
    hid = (await u1.rpc("bootstrap_household")).data as string;
    await u2.rpc("bootstrap_household");
    profs = (await u1.from("profiles").select("id,label,color").order("sort_order")).data!;
    chainX = (await must(u1.from("chains").insert({ household_id: hid, name: "サンプルX" }).select("id").single())).id;
    chainY = (await must(u1.from("chains").insert({ household_id: hid, name: "サンプルY" }).select("id").single())).id;
    storeX = (await must(u1.from("stores").insert({ household_id: hid, chain_id: chainX, name: "X店", prefecture: "兵庫県" }).select("id").single())).id;
    storeY = (await must(u1.from("stores").insert({ household_id: hid, chain_id: chainY, name: "Y店", prefecture: "大阪府" }).select("id").single())).id;
    p1 = (await must(u1.from("products").insert({ household_id: hid, official_name: "5P商品1", packs_per_box: 20 }).select("id").single())).id;
    const lx = await saveLottery(u1, hid, null, base(chainX, storeX), profs[A].id);
    const ly = await saveLottery(u1, hid, null, base(chainY, storeY), profs[A].id);
    if (!lx.ok || !ly.ok) throw new Error("setup");
    lotX = lx.value.id;
    lotY = ly.value.id;
  });
  afterAll(async () => {
    await cleanupTestUsers(admin, userIds);
  });

  // ------------------------------------------------------------------ 個
  it("購入明細の数量単位に「個」を保存できる。既存の単位も維持され、未知の単位はDBの制約で拒否される", async () => {
    const res = await addManualPurchase(
      u1, hid,
      { storeId: "", date: "2099-01-01", time: "", channel: "store", note: "", items: [{ productId: p1, quantity: 3, unit: "piece", amountPaid: 3000 }, { productId: p1, quantity: 1, unit: "box", amountPaid: null }] },
      profs[A].id,
    );
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const items = (await u1.from("purchase_items").select("unit,quantity").eq("purchase_id", res.value.id)).data!;
    expect(items.map((i) => i.unit).sort()).toEqual(["box", "piece"]);
    const d = await loadAppData(u1);
    expect(d.purchases.find((p) => p.id === res.value.id)!.items.map((i) => i.unit).sort()).toEqual(["box", "piece"]);
    const bad = await u1.from("purchase_items").insert({ household_id: hid, purchase_id: res.value.id, product_id: p1, quantity: 1, unit: "carton" });
    expect(bad.error).not.toBeNull();
  });

  // ------------------------------------------------------------------ メイン／サブ
  it("既存のユーザーはすべてメイン。メインは全系列の抽選を操作できる（従来どおり）", async () => {
    const d = await loadAppData(u1);
    expect(d.profiles.every((p) => p.kind === "main")).toBe(true);
    const accC = await accountOf(C, chainY);
    expect((await setApplied(u1, hid, lotY, accC.id, true, profs[C].id)).ok).toBe(true); // 後でサブにしても残ることを確かめる履歴
  });

  it("サブに変更して対象系列を保存できる。履歴（応募）はそのまま残り、他のユーザーの設定は変わらない", async () => {
    const before = (await u1.from("applications").select("id,state,result_status")).data!;
    const r = await updateProfileSettings(u1, profs[C].id, profileInput(C, { kind: "sub", targetChainIds: [chainX] }), profs[A].id);
    expect(r.ok).toBe(true);
    const d = await loadAppData(u1);
    const c = d.profiles.find((p) => p.id === profs[C].id)!;
    expect(c.kind).toBe("sub");
    expect(c.allowedChainIds).toEqual([chainX]);
    expect(d.profiles.filter((p) => p.id !== profs[C].id).every((p) => p.kind === "main" && p.allowedChainIds === null)).toBe(true);
    expect((await u1.from("applications").select("id,state,result_status")).data).toEqual(before);
    // 世帯全体の抽選情報は変わらない
    expect(d.lotteries.map((l) => l.id).sort()).toEqual([lotX, lotY].sort());
  });

  it("サブは対象系列の抽選だけ操作できる。対象外の系列は応募・当落・購入・★・スルーのどれも拒否される", async () => {
    const accX = await accountOf(C, chainX);
    const accY = await accountOf(C, chainY);
    expect((await setApplied(u1, hid, lotX, accX.id, true, profs[C].id)).ok).toBe(true);
    const denied = await setApplied(u1, hid, lotY, accY.id, false, profs[C].id);
    expect(denied.ok).toBe(false);
    if (!denied.ok) expect(denied.error).toContain("対象外");
    expect((await setApplied(u1, hid, lotY, accY.id, true, profs[C].id)).ok).toBe(false);
    expect((await setManaged(u1, hid, lotY, true, profs[C].id)).ok).toBe(false);
    expect((await setLotterySkip(u1, hid, profs[C].id, lotY, true, profs[C].id)).ok).toBe(false);
    // 対象系列では当落・購入も操作できる
    const appX = (await u1.from("applications").select("id").eq("lottery_id", lotX).eq("service_account_id", accX.id).single()).data!;
    expect((await setResult(u1, appX.id, "won", profs[C].id)).ok).toBe(true);
    expect((await setFulfillment(u1, appX.id, "purchased", profs[C].id)).ok).toBe(true);
    expect(((await u1.from("purchases").select("id").eq("application_id", appX.id)).data ?? []).length).toBe(1);
    // 対象外の系列に既にあった応募（サブにする前の履歴）の当落・購入もサブからは変更できない。メインなら変更できる
    const appY = (await u1.from("applications").select("id,state").eq("lottery_id", lotY).eq("service_account_id", accY.id).single()).data!;
    expect(appY.state).toBe("applied");
    expect((await setResult(u1, appY.id, "won", profs[C].id)).ok).toBe(false);
    expect((await setFulfillment(u1, appY.id, "procedure_done", profs[C].id)).ok).toBe(false);
    expect((await setResult(u1, appY.id, "lost", profs[A].id)).ok).toBe(true);
  });

  it("他のユーザー（メイン）の操作は、サブの対象系列に関係なく従来どおり", async () => {
    const accA = await accountOf(A, chainY);
    expect((await setApplied(u1, hid, lotY, accA.id, true, profs[A].id)).ok).toBe(true);
    expect((await setManaged(u1, hid, lotY, true, profs[B].id)).ok).toBe(true);
  });

  it("系列の別名（統合前の名前）も同じ系列として扱う。別名を外すと再び対象外", async () => {
    const accY = await accountOf(C, chainY);
    expect((await setApplied(u1, hid, lotY, accY.id, false, profs[C].id)).ok).toBe(false);
    await must(u1.from("chain_aliases").insert({ household_id: hid, chain_id: chainY, alias: "サンプルX", normalized_alias: "サンプルx" }).select("id").single());
    expect((await setApplied(u1, hid, lotY, accY.id, false, profs[C].id)).ok).toBe(true);
    await u1.from("chain_aliases").delete().eq("chain_id", chainY).eq("alias", "サンプルX");
    expect((await setApplied(u1, hid, lotY, accY.id, true, profs[C].id)).ok).toBe(false);
  });

  it("対象系列を変更しても履歴は保持される。未設定のサブは、どの系列も操作できない", async () => {
    const before = (await u1.from("applications").select("id,state,result_status,fulfillment_status")).data!;
    expect((await updateProfileSettings(u1, profs[C].id, profileInput(C, { kind: "sub", targetChainIds: [chainY] }), profs[A].id)).ok).toBe(true);
    expect((await u1.from("applications").select("id,state,result_status,fulfillment_status")).data).toEqual(before);
    expect((await loadAppData(u1)).profiles.find((p) => p.id === profs[C].id)!.allowedChainIds).toEqual([chainY]);

    expect((await updateProfileSettings(u1, profs[C].id, profileInput(C, { kind: "sub", targetChainIds: [] }), profs[A].id)).ok).toBe(true);
    const unset = (await loadAppData(u1)).profiles.find((p) => p.id === profs[C].id)!;
    expect(unset.kind).toBe("sub");
    expect(unset.allowedChainIds).toBeNull(); // 画面では何も表示しない（全系列は表示しない）
    const accX = await accountOf(C, chainX);
    expect((await setApplied(u1, hid, lotX, accX.id, false, profs[C].id)).ok).toBe(false);
    expect((await u1.from("applications").select("id,state,result_status,fulfillment_status")).data).toEqual(before);
  });

  it("メインへ戻すと対象系列の許可リストが外れて全系列に戻る。履歴は変わらない", async () => {
    const before = (await u1.from("applications").select("id,state,result_status,fulfillment_status")).data!;
    expect((await updateProfileSettings(u1, profs[C].id, profileInput(C, { kind: "sub", targetChainIds: [chainX] }), profs[A].id)).ok).toBe(true);
    expect((await updateProfileSettings(u1, profs[C].id, profileInput(C, { kind: "main" }), profs[A].id)).ok).toBe(true);
    const c = (await loadAppData(u1)).profiles.find((p) => p.id === profs[C].id)!;
    expect(c.kind).toBe("main");
    expect(c.allowedChainIds).toBeNull();
    expect((await u1.from("applications").select("id,state,result_status,fulfillment_status")).data).toEqual(before);
    const accY = await accountOf(C, chainY);
    expect((await setApplied(u1, hid, lotY, accY.id, false, profs[C].id)).ok).toBe(true);
  });

  it("メインのまま保存（名前変更など）しても、既存の許可リストは消えない。除外と重なる系列はサブの対象にできない", async () => {
    await must(u1.from("profile_target_rules").insert({ household_id: hid, profile_id: profs[B].id, chain_id: chainX, store_id: null, mode: "allow" }).select("id").single());
    expect((await updateProfileSettings(u1, profs[B].id, profileInput(B, { kind: "main" }), profs[A].id)).ok).toBe(true);
    expect(((await u1.from("profile_target_rules").select("id").eq("profile_id", profs[B].id)).data ?? []).length).toBe(1);
    await u1.from("profile_target_rules").delete().eq("profile_id", profs[B].id);
    await must(u1.from("profile_target_rules").insert({ household_id: hid, profile_id: profs[B].id, chain_id: chainY, store_id: null, mode: "block" }).select("id").single());
    const conflict = await updateProfileSettings(u1, profs[B].id, profileInput(B, { kind: "sub", targetChainIds: [chainY] }), profs[A].id);
    expect(conflict.ok).toBe(false);
    expect((await loadAppData(u1)).profiles.find((p) => p.id === profs[B].id)!.kind).toBe("main");
  });

  it("他の世帯のユーザーは、種別・対象系列を変更できない。不正な種別・系列IDは拒否される", async () => {
    const forged = await updateProfileSettings(u2, profs[C].id, profileInput(C, { kind: "sub", targetChainIds: [chainX] }), null);
    expect(forged.ok).toBe(false);
    expect((await loadAppData(u1)).profiles.find((p) => p.id === profs[C].id)!.kind).toBe("main");
    expect((await updateProfileSettings(u1, profs[C].id, profileInput(C, { kind: "owner" as never }), null)).ok).toBe(false);
    expect((await updateProfileSettings(u1, profs[C].id, profileInput(C, { kind: "sub", targetChainIds: ["00000000-0000-4000-8000-000000000000"] }), null)).ok).toBe(false);
    const direct = await u2.from("profiles").update({ kind: "sub" }).eq("id", profs[C].id).select("id");
    expect((direct.data ?? []).length).toBe(0);
  });
});
