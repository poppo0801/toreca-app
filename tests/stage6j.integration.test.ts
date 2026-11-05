/**
 * Stage 6J の結合テスト（実Supabase・RLS適用下）: メイン／サブの紐づけ、履歴の保護、記録の所有者、世帯間の分離。
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { EMPTY_FLEX } from "@/lib/lottery-input";
import { loadAppData, ownerScopeError, setFulfillment, setResult, updateProfileSettings, type Db } from "@/lib/server/lottery-service";
import { saveLegacy as saveLottery, type LegacyInput } from "./helpers/legacy";
import { adminClient, cleanupTestUsers, dbTestsEnabled, signInTestUser } from "./helpers/db";

describe.skipIf(!dbTestsEnabled)("Stage 6J: メイン／サブの紐づけ", () => {
  const admin = adminClient();
  const ids: string[] = [];
  let u1: Db;
  let u2: Db;
  let hid1: string;
  let hid2: string;
  let profA: string; // メイン
  let profB: string; // メイン
  let profC: string; // サブ（Aに紐づける）
  let profD: string; // サブ
  let foreignMain: string; // 他世帯のメイン
  let chainId: string;
  let accA: string;
  let accC: string;
  let lotteryId: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- 新しい列は生成型に無い
  const x = (db: unknown) => db as any;

  const base = (over: Partial<LegacyInput> = {}): LegacyInput => ({
    chainId, storeId: "", campaignId: null, newCampaign: null, items: [], applyStart: EMPTY_FLEX, applyDeadline: EMPTY_FLEX, resultDate: EMPTY_FLEX, procedureDeadline: EMPTY_FLEX,
    receiveMethod: "store", applyMethod: "web", conditionsText: "", verificationText: "", announcementMethod: "", announcementUrl: "", sourceUrls: [], eventState: "open",
    limitBasis: "account", limitMaxCount: 1, memo: "", applications: [], appliedAt: "", ...over,
  });
  const link = (db: Db, id: string, main: string | null) => x(db).from("profiles").update({ main_profile_id: main }).eq("id", id);

  beforeAll(async () => {
    const a = await signInTestUser(admin, "s6j", 1);
    const b = await signInTestUser(admin, "s6j", 2);
    ids.push(a.userId, b.userId);
    u1 = a.db;
    u2 = b.db;
    hid1 = (await u1.rpc("bootstrap_household")).data as string;
    hid2 = (await u2.rpc("bootstrap_household")).data as string;
    const profiles = (await u1.from("profiles").select("id,label")).data!;
    profA = profiles.find((p) => p.label === "A")!.id;
    profB = profiles.find((p) => p.label === "B")!.id;
    foreignMain = ((await u2.from("profiles").select("id,label")).data!.find((p) => p.label === "A"))!.id;
    const mk = async (label: string) => {
      const r = await admin.from("profiles").insert({ household_id: hid1, label, initial: label, kind: "sub" }).select("id").single();
      expect(r.error, JSON.stringify(r.error)).toBeNull();
      return r.data!.id;
    };
    // 世帯の作成時に A・B・C が用意される（C が無ければ作る）。C・D をサブにそろえる
    const existing = (await u1.from("profiles").select("id,label")).data!;
    profC = existing.find((p) => p.label === "C")?.id ?? (await mk("C"));
    profD = existing.find((p) => p.label === "D")?.id ?? (await mk("D"));
    for (const id of [profC, profD]) await admin.from("profiles").update({ kind: "sub" }).eq("id", id);

    const must = async (p: PromiseLike<{ data: unknown; error: unknown }>) => {
      const { data, error } = await p;
      expect(error).toBeNull();
      return data as { id: string };
    };
    chainId = (await must(u1.from("chains").insert({ household_id: hid1, name: "6J結合テスト電機" }).select("id").single())).id;
    const storeId = (await must(u1.from("stores").insert({ household_id: hid1, chain_id: chainId, name: "6J店" }).select("id").single())).id;
    const productId = (await must(u1.from("products").insert({ household_id: hid1, official_name: "テスト商品", packs_per_box: 20 }).select("id").single())).id;
    const fam = (await must(u1.from("family_groups").insert({ household_id: hid1, label: "家族" }).select("id").single())).id;
    const adr = (await must(u1.from("address_groups").insert({ household_id: hid1, label: "住所" }).select("id").single())).id;
    const acc = async (profile: string, label: string) => {
      const identity = (await must(u1.from("identities").insert({ household_id: hid1, display_label: `名義${label}`, family_group_id: fam, address_group_id: adr }).select("id").single())).id;
      return (await must(u1.from("service_accounts").insert({ household_id: hid1, chain_id: chainId, identity_id: identity, managed_by_profile_id: profile, account_label: `${label}-acc`, membership_state: "eligible" }).select("id").single())).id;
    };
    accA = await acc(profA, "A");
    accC = await acc(profC, "C");
    const res = await saveLottery(u1, hid1, null, base({ storeId, items: [{ productId, quantity: 1, unit: "box" }], applications: [{ accountId: accA, status: "applied" }, { accountId: accC, status: "won" }] }), profA);
    expect(res.ok, JSON.stringify(res)).toBe(true);
    lotteryId = (res as { value: { id: string } }).value.id;
  });
  afterAll(async () => {
    await cleanupTestUsers(admin, ids);
  });

  it("サブをメインに紐づけられる。メインのままの紐づけ・サブ同士・自分自身・他世帯のメインは拒否される", async () => {
    expect((await link(u1, profC, profA)).error).toBeNull();
    expect((await x(u1).from("profiles").select("main_profile_id").eq("id", profC).single()).data.main_profile_id).toBe(profA);
    await link(u1, profB, profA); // メインは紐づけを持てない（トリガーが外す）
    expect((await x(u1).from("profiles").select("main_profile_id").eq("id", profB).single()).data.main_profile_id).toBeNull();
    expect((await link(u1, profD, profC)).error).not.toBeNull(); // サブ同士
    expect((await link(u1, profD, profD)).error).not.toBeNull(); // 自分自身
    expect((await link(u1, profD, foreignMain)).error).not.toBeNull(); // 他世帯
    expect((await link(u1, profC, profD)).error).not.toBeNull(); // 循環の元になるサブへの紐づけ
    expect((await x(u1).from("profiles").select("main_profile_id").eq("id", profC).single()).data.main_profile_id).toBe(profA); // 失敗しても元のまま
  });

  it("メインへ戻すと紐づけは外れる。紐づくサブがいるメインはサブにできない", async () => {
    expect((await u1.from("profiles").update({ kind: "sub" }).eq("id", profA)).error).not.toBeNull();
    expect((await u1.from("profiles").update({ kind: "main" }).eq("id", profD)).error).toBeNull();
    expect((await link(u1, profD, profA)).error).toBeNull(); // メインのDには紐づけを持たせても、トリガーが外す
    expect((await x(u1).from("profiles").select("main_profile_id").eq("id", profD).single()).data.main_profile_id).toBeNull();
    await u1.from("profiles").update({ kind: "sub" }).eq("id", profD);
  });

  it("画面用の読み込み(loadAppData)に紐づけが入り、A=A+C / B=Bのみ / C=Cのみになる", async () => {
    const d = await loadAppData(u1);
    expect(d.profiles.find((p) => p.id === profC)?.linkedMainId).toBe(profA);
    expect(d.profiles.find((p) => p.id === profA)?.linkedMainId).toBeNull();
    const { scopeProfileIds } = await import("@/lib/profile-link");
    expect(scopeProfileIds(d.profiles, profA).sort()).toEqual([profA, profC].sort());
    expect(scopeProfileIds(d.profiles, profB)).toEqual([profB]);
    expect(scopeProfileIds(d.profiles, profC)).toEqual([profC]);
  });

  it("紐づけの変更・解除は、応募・当落の履歴に影響しない", async () => {
    const snap = async () => (await u1.from("applications").select("id,service_account_id,result_status,state,fulfillment_status").eq("lottery_id", lotteryId).order("id")).data;
    const before = await snap();
    expect(before).toHaveLength(2);
    await link(u1, profC, profB);
    await link(u1, profC, null);
    await link(u1, profC, profA);
    expect(await snap()).toEqual(before);
    const profilesAfter = (await u1.from("profiles").select("id,label,kind,active")).data!;
    expect(profilesAfter.filter((p) => ["A", "B", "C", "D"].includes(p.label))).toHaveLength(4);
  });

  it("記録の所有者: サブは自分の記録だけ操作できる。メインが操作しても記録は所有者(C)の応募に保存される", async () => {
    const appC = (await u1.from("applications").select("id").eq("lottery_id", lotteryId).eq("service_account_id", accC).single()).data!.id;
    const appA = (await u1.from("applications").select("id").eq("lottery_id", lotteryId).eq("service_account_id", accA).single()).data!.id;
    expect(await ownerScopeError(u1, profA, appC)).toBeNull(); // 紐づけ先のメイン
    expect(await ownerScopeError(u1, profC, appC)).toBeNull(); // 本人
    expect(await ownerScopeError(u1, profD, appC)).not.toBeNull(); // 別のサブは他人の記録を操作できない
    expect(await ownerScopeError(u1, profC, appA)).not.toBeNull(); // サブはメインの記録を操作できない
    expect((await setResult(u1, appA, "lost", profC)).ok).toBe(false);
    // 紐づけ先のメインAが、Cの当選の購入手続きを記録 → Cの応募に保存され、Aの応募は変わらない
    const r = await setFulfillment(u1, appC, "procedure_done", profA);
    expect(r.ok, (r as { error?: string }).error).toBe(true);
    const rows = (await u1.from("applications").select("service_account_id,result_status,fulfillment_status,updated_by_profile_id").eq("lottery_id", lotteryId)).data!;
    expect(rows.find((a) => a.service_account_id === accC)).toMatchObject({ result_status: "won", fulfillment_status: "procedure_done", updated_by_profile_id: profA });
    expect(rows.find((a) => a.service_account_id === accA)).toMatchObject({ result_status: "pending", fulfillment_status: "none" });
    // 紐づけを外しても履歴は残る（Aの一覧には出なくなる）
    await link(u1, profC, null);
    expect((await u1.from("applications").select("id").eq("id", appC)).data).toHaveLength(1);
    await link(u1, profC, profA);
  });

  it("設定画面の保存: メインへ紐づけ可能。サブ同士・無効な指定は拒否。履歴は変わらない", async () => {
    const r1 = await updateProfileSettings(u1, profD, { label: "D", color: "teal", colorHex: null, iconMark: "initial", notifyRecipientIds: null, kind: "sub", mainProfileId: profB }, profA);
    expect(r1.ok, (r1 as { error?: string }).error).toBe(true);
    expect((await x(u1).from("profiles").select("main_profile_id").eq("id", profD).single()).data.main_profile_id).toBe(profB);
    const r2 = await updateProfileSettings(u1, profD, { label: "D", color: "teal", colorHex: null, iconMark: "initial", notifyRecipientIds: null, kind: "sub", mainProfileId: profC }, profA);
    expect(r2.ok).toBe(false);
    const r3 = await updateProfileSettings(u1, profD, { label: "D", color: "teal", colorHex: null, iconMark: "initial", notifyRecipientIds: null, kind: "main" }, profA);
    expect(r3.ok).toBe(true);
    expect((await x(u1).from("profiles").select("main_profile_id,kind").eq("id", profD).single()).data).toEqual({ main_profile_id: null, kind: "main" });
    const r4 = await updateProfileSettings(u1, profA, { label: "A", color: "blue", colorHex: null, iconMark: "initial", notifyRecipientIds: null, kind: "sub" }, profA);
    expect(r4.ok).toBe(false); // 紐づくサブ(C)がいる
  });

  it("世帯間の分離: 他世帯のユーザーは紐づけを変更できず、候補にも他世帯のプロフィールは出ない", async () => {
    await x(u2).from("profiles").update({ main_profile_id: foreignMain }).eq("id", profC);
    expect((await x(u1).from("profiles").select("main_profile_id").eq("id", profC).single()).data.main_profile_id).toBe(profA);
    const visible2 = (await u2.from("profiles").select("id")).data!.map((p) => p.id);
    expect(visible2).not.toContain(profA);
    expect(visible2).not.toContain(profC);
    expect(await ownerScopeError(u2, foreignMain, (await u1.from("applications").select("id").eq("lottery_id", lotteryId).limit(1).single()).data!.id)).toBeNull(); // 他世帯の応募は見えず対象外（RLSで更新もできない）
    void hid2;
  });

  it("起動時ポップアップの対象プロフィールは固定IDで保持される（同一世帯のプロフィールのみ）", async () => {
    const cur = (await x(admin).from("collection_settings").select("id").eq("household_id", hid1).limit(1).maybeSingle()).data;
    if (cur) await x(admin).from("collection_settings").update({ result_notice_profile_id: profA }).eq("id", cur.id);
    else await x(admin).from("collection_settings").insert({ household_id: hid1, result_notice_profile_id: profA });
    const row = (await x(admin).from("collection_settings").select("result_notice_profile_id").eq("household_id", hid1).single()).data;
    expect(row.result_notice_profile_id).toBe(profA);
    // 表示名を変えても対象は変わらない
    await u1.from("profiles").update({ label: "改名後" }).eq("id", profA);
    expect((await x(admin).from("collection_settings").select("result_notice_profile_id").eq("household_id", hid1).single()).data.result_notice_profile_id).toBe(profA);
    // 他世帯のプロフィールは指定できない
    const bad = await x(admin).from("collection_settings").update({ result_notice_profile_id: foreignMain }).eq("household_id", hid1);
    expect(bad.error).not.toBeNull();
  });
});
