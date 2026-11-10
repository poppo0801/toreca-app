/**
 * Stage 7N の結合テスト（実Supabase・RLS適用下・架空データのみ）:
 *  - 店舗選択式の応募で入力した店舗が、応募の成功後に店舗マスターへ確認済みで自動登録される（表記揺れは既存店舗を再利用）
 *  - 架空の店舗名（店舗未確認など）は登録しない。プロフィール別の応募店舗は独立
 *  - 新規店舗の登録状態: 手動登録=確認済み／自動収集=未確認。既存の店舗は変更しない
 *   npm run test:db
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { EMPTY_FLEX, type LotteryInput } from "@/lib/lottery-input";
import { loadAppData, saveLottery, setApplied, setAppliedStore, type Db } from "@/lib/server/lottery-service";
import { adminClient, cleanupTestUsers, dbTestsEnabled, signInTestUser } from "./helpers/db";

describe.skipIf(!dbTestsEnabled)("Stage 7N: 応募店舗の店舗マスター自動登録・新規店舗の登録状態", () => {
  const admin = adminClient();
  const userIds: string[] = [];
  let db: Db;
  let hid: string;
  let profA: string;
  let profB: string;
  let chainId: string;

  const ok = <T,>(r: { ok: boolean; value?: T; error?: string }) => {
    expect(r.ok, r.error).toBe(true);
    return (r as { value: T }).value;
  };
  const input = (over: Partial<LotteryInput> = {}): LotteryInput => ({
    chain: { id: chainId, name: "" },
    store: { id: null, name: "", prefecture: "" },
    storeMode: "select_on_apply",
    selectableStores: [],
    multiMode: "single",
    campaignId: null,
    newCampaign: null,
    items: [{ product: { id: null, name: "7N商品" }, quantity: 1, unit: "box" }],
    applyStart: EMPTY_FLEX,
    applyDeadline: { precision: "date_time", date: "2099-01-10", time: "23:59" },
    resultDate: EMPTY_FLEX,
    procedureStart: EMPTY_FLEX,
    procedureDeadline: EMPTY_FLEX,
    receiveMethod: "store",
    applyMethod: "web",
    conditionsText: "",
    verificationText: "",
    announcementMethod: "",
    announcementUrl: "",
    sourceUrls: [],
    eventState: "open",
    limitBasis: "account",
    limitMaxCount: 5,
    memo: "",
    applications: [],
    appliedAt: "",
    ...over,
  });
  const accountOf = async (profileId: string) => (await loadAppData(db)).accounts.find((a) => a.profileId === profileId && a.chainId === chainId)!.id;
  const storesOf = async () => (await db.from("stores").select("id,name,prefecture,is_provisional").eq("chain_id", chainId)).data ?? [];

  beforeAll(async () => {
    const a = await signInTestUser(admin, "s7n", 1);
    userIds.push(a.userId);
    db = a.db;
    hid = (await db.rpc("bootstrap_household")).data as string;
    const profiles = (await db.from("profiles").select("id,label")).data!;
    profA = profiles.find((p) => p.label === "A")!.id;
    profB = profiles.find((p) => p.label === "B")!.id;
    const c = await db.from("chains").insert({ household_id: hid, name: "7NGEO" }).select("id").single();
    chainId = c.data!.id;
    // 応募アカウント（プロフィールA・B）
    const fam = (await db.from("family_groups").insert({ household_id: hid, label: "家族" }).select("id").single()).data!.id;
    const adr = (await db.from("address_groups").insert({ household_id: hid, label: "住所" }).select("id").single()).data!.id;
    for (const [i, p] of [profA, profB].entries()) {
      const idn = (await db.from("identities").insert({ household_id: hid, display_label: `名義${i}`, family_group_id: fam, address_group_id: adr }).select("id").single()).data!.id;
      await db.from("service_accounts").insert({ household_id: hid, chain_id: chainId, identity_id: idn, managed_by_profile_id: p, account_label: `acc${i}`, membership_state: "eligible" });
    }
  });
  afterAll(async () => {
    await cleanupTestUsers(admin, userIds);
  });

  it("応募した店舗を店舗マスターへ確認済みで登録し、応募記録に紐づける。他のプロフィールの応募店舗は変わらない", async () => {
    const lot = ok(await saveLottery(db, hid, null, input(), profA)).id;
    ok(await setApplied(db, hid, lot, await accountOf(profA), true, profA, null, { appliedStore: { id: null, name: "伊川谷店", prefecture: "兵庫県" } }));
    ok(await setApplied(db, hid, lot, await accountOf(profB), true, profB, null, { appliedStore: { id: null, name: "神戸店", prefecture: "兵庫県" } }));
    const s = await storesOf();
    const ikawadani = s.find((x) => x.name === "伊川谷店")!;
    expect(ikawadani).toMatchObject({ prefecture: "兵庫県", is_provisional: false }); // 正式（確認済み）
    expect(s.find((x) => x.name === "神戸店")).toBeTruthy();
    const d = await loadAppData(db);
    const apps = d.applications.filter((a) => a.lotteryId === lot);
    const a = apps.find((x) => x.accountId === d.accounts.find((ac) => ac.profileId === profA && ac.chainId === chainId)!.id)!;
    const b = apps.find((x) => x.accountId === d.accounts.find((ac) => ac.profileId === profB && ac.chainId === chainId)!.id)!;
    expect(a.appliedStore).toMatchObject({ id: ikawadani.id, name: "伊川谷店" });
    expect(b.appliedStore).toMatchObject({ name: "神戸店" });
    expect(b.appliedStore?.id).not.toBe(ikawadani.id); // プロフィール別に独立
  });

  it("表記揺れ（全角・系列名の接頭・末尾の店の有無）は既存店舗を再利用し、重複登録しない。空の都道府県は補う", async () => {
    const before = (await storesOf()).length;
    const lot = ok(await saveLottery(db, hid, null, input({ memo: "2件目" }), profA)).id;
    ok(await setApplied(db, hid, lot, await accountOf(profA), true, profA, null, { appliedStore: { id: null, name: "７ＮＧＥＯ 伊川谷", prefecture: "" } }));
    expect((await storesOf()).length).toBe(before);
    const app = (await loadAppData(db)).applications.find((x) => x.lotteryId === lot)!;
    expect(app.appliedStore?.id).toBeTruthy();
    // 都道府県が空のマスターは、入力された都道府県で補う
    await db.from("stores").insert({ household_id: hid, chain_id: chainId, name: "三宮店", prefecture: "" });
    expect((await setAppliedStore(db, app.id, { id: null, name: "三宮", prefecture: "兵庫県" }, profA)).ok).toBe(true);
    const sanno = (await storesOf()).find((x) => x.name === "三宮店")!;
    expect(sanno.prefecture).toBe("兵庫県");
    expect((await storesOf()).filter((x) => x.name.includes("三宮")).length).toBe(1);
  });

  it("架空の店舗名（店舗未確認・不明）はマスターに登録しない。応募の記録は有効", async () => {
    const before = (await storesOf()).length;
    const lot = ok(await saveLottery(db, hid, null, input({ memo: "3件目" }), profA)).id;
    ok(await setApplied(db, hid, lot, await accountOf(profA), true, profA, null, { appliedStore: { id: null, name: "店舗未確認", prefecture: "" } }));
    expect((await storesOf()).length).toBe(before);
    const app = (await loadAppData(db)).applications.find((x) => x.lotteryId === lot)!;
    expect(app.state).toBe("applied");
  });

  it("新規店舗の登録状態: 手動登録=確認済み／自動収集=未確認。既存の店舗は変更しない", async () => {
    const fixed = (name: string): Partial<LotteryInput> => ({ storeMode: "fixed", store: { id: null, name, prefecture: "兵庫県" } });
    ok(await saveLottery(db, hid, null, input({ ...fixed("手動追加店"), memo: "手動" }), profA));
    ok(await saveLottery(db, hid, null, input({ ...fixed("自動収集店"), memo: "自動" }), profA, { autoCollected: true }));
    const s = await storesOf();
    expect(s.find((x) => x.name === "手動追加店")!.is_provisional).toBe(false);
    expect(s.find((x) => x.name === "自動収集店")!.is_provisional).toBe(true);
    // 確認済みの既存店舗を自動収集で使っても、確認済みのまま
    ok(await saveLottery(db, hid, null, input({ ...fixed("手動追加店"), memo: "自動2" }), profA, { autoCollected: true }));
    expect((await storesOf()).find((x) => x.name === "手動追加店")!.is_provisional).toBe(false);
  });
});
