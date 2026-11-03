/**
 * Stage 5N の結合テスト（実Supabase・RLS適用下。架空データのみ）:
 * 会員番号（世帯分離・重複防止・先頭ゼロ保持）、購入/受取期間の分離と抽選方式の保存、締切後の応募記録（応募日時なし）、
 * 系列の安全な統合（merge_chains: 削除せず付け替え・同名店舗の統合・応募履歴の維持・service_role専用）。
 *   npm run test:db
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { EMPTY_FLEX } from "@/lib/lottery-input";
import { loadAppData, setApplied, type Db } from "@/lib/server/lottery-service";
import { saveLegacy as saveLottery, type LegacyInput } from "./helpers/legacy";
import { adminClient, anonClient, cleanupTestUsers, dbTestsEnabled, signInTestUser } from "./helpers/db";

describe.skipIf(!dbTestsEnabled)("Stage 5N: 会員番号・購入/受取・抽選方式・系列統合", () => {
  const admin = adminClient();
  const userIds: string[] = [];
  let u1: Db;
  let u2: Db;
  let hid: string;
  let hid2: string;
  let profs: { id: string; label: string }[];
  let chainFuru: string;
  let chainOld: string;
  let storeFuruTakara: string;
  let storeOldTakara: string;
  let storeOldFukai: string;
  let p1: string;

  const must = async (p: PromiseLike<{ data: unknown; error: unknown }>) => {
    const { data, error } = await p;
    expect(JSON.stringify(error)).toBe("null");
    return data as { id: string };
  };
  const base = (chainId: string, storeId: string, over: Partial<LegacyInput> = {}): LegacyInput => ({
    chainId, storeId, campaignId: null, newCampaign: null,
    items: [{ productId: p1, quantity: 1, unit: "box" }],
    multiMode: "single",
    applyStart: EMPTY_FLEX, applyDeadline: { precision: "date_only", date: "2099-01-10", time: "" }, resultDate: EMPTY_FLEX,
    procedureStart: EMPTY_FLEX, procedureDeadline: EMPTY_FLEX, receiveMethod: "store", applyMethod: "web",
    conditionsText: "", verificationText: "", announcementMethod: "", announcementUrl: "", sourceUrls: [],
    eventState: "open", limitBasis: "account", limitMaxCount: 5, memo: "", applications: [], appliedAt: "", ...over,
  });

  beforeAll(async () => {
    const a = await signInTestUser(admin, "s5n", 1);
    const b = await signInTestUser(admin, "s5n", 2);
    userIds.push(a.userId, b.userId);
    u1 = a.db;
    u2 = b.db;
    hid = (await u1.rpc("bootstrap_household")).data as string;
    hid2 = (await u2.rpc("bootstrap_household")).data as string;
    profs = (await u1.from("profiles").select("id,label").order("sort_order")).data!;
    chainFuru = (await must(u1.from("chains").insert({ household_id: hid, name: "ふるいち" }).select("id").single())).id;
    chainOld = (await must(u1.from("chains").insert({ household_id: hid, name: "古本市場" }).select("id").single())).id;
    storeFuruTakara = (await must(u1.from("stores").insert({ household_id: hid, chain_id: chainFuru, name: "宝塚店", prefecture: "兵庫県" }).select("id").single())).id;
    storeOldTakara = (await must(u1.from("stores").insert({ household_id: hid, chain_id: chainOld, name: "宝塚店", prefecture: "兵庫県" }).select("id").single())).id;
    storeOldFukai = (await must(u1.from("stores").insert({ household_id: hid, chain_id: chainOld, name: "深井店", prefecture: "大阪府" }).select("id").single())).id;
    p1 = (await must(u1.from("products").insert({ household_id: hid, official_name: "5N商品1", packs_per_box: 20 }).select("id").single())).id;
  });
  afterAll(async () => {
    await cleanupTestUsers(admin, userIds);
  });

  // ------------------------------------------------------------------ 会員番号
  it("会員番号: 先頭のゼロを保持して保存でき、同じプロフィール×系列の重複は拒否される。別プロフィールは同じ系列でも別の番号", async () => {
    await must(u1.from("member_numbers").insert({ household_id: hid, profile_id: profs[0].id, chain_id: chainFuru, member_no: "0001234567" }).select("id").single());
    const dup = await u1.from("member_numbers").insert({ household_id: hid, profile_id: profs[0].id, chain_id: chainFuru, member_no: "9" });
    expect(dup.error?.code).toBe("23505");
    await must(u1.from("member_numbers").insert({ household_id: hid, profile_id: profs[1].id, chain_id: chainFuru, member_no: "0099" }).select("id").single());
    const rows = (await u1.from("member_numbers").select("profile_id,member_no").eq("chain_id", chainFuru)).data!;
    expect(rows.find((r) => r.profile_id === profs[0].id)!.member_no).toBe("0001234567");
    expect(rows.find((r) => r.profile_id === profs[1].id)!.member_no).toBe("0099");
  });
  it("会員番号: 空・前後の空白つきの番号はDBの制約で拒否される", async () => {
    const empty = await u1.from("member_numbers").insert({ household_id: hid, profile_id: profs[2].id, chain_id: chainFuru, member_no: "" });
    expect(empty.error).not.toBeNull();
    const padded = await u1.from("member_numbers").insert({ household_id: hid, profile_id: profs[2].id, chain_id: chainFuru, member_no: " 12 " });
    expect(padded.error).not.toBeNull();
  });
  it("会員番号: 他の世帯からは見えず、書き込めず、未ログインでも読めない。更新・削除は自世帯のみ", async () => {
    expect(((await u2.from("member_numbers").select("id")).data ?? []).length).toBe(0);
    const forge = await u2.from("member_numbers").insert({ household_id: hid, profile_id: profs[0].id, chain_id: chainOld, member_no: "1" });
    expect(forge.error).not.toBeNull();
    const anon = await anonClient().from("member_numbers").select("id");
    expect((anon.data ?? []).length).toBe(0);
    await u2.from("member_numbers").delete().eq("chain_id", chainFuru);
    expect(((await u1.from("member_numbers").select("id").eq("chain_id", chainFuru)).data ?? []).length).toBe(2);
    const upd = await u1.from("member_numbers").update({ member_no: "0002" }).eq("profile_id", profs[1].id).eq("chain_id", chainFuru).select("member_no").single();
    expect(upd.data?.member_no).toBe("0002");
    await u1.from("member_numbers").delete().eq("profile_id", profs[1].id).eq("chain_id", chainFuru);
    expect(((await u1.from("member_numbers").select("id").eq("chain_id", chainFuru)).data ?? []).length).toBe(1);
  });

  // ------------------------------------------------------------------ 購入/受取期間・抽選方式
  it("購入期間と受取期間を分けて保存でき、再読み込みしても保持される。分離しない抽選は従来どおり", async () => {
    const res = await saveLottery(
      u1, hid, null,
      base(chainFuru, storeFuruTakara, {
        procedureSplit: true,
        procedureStart: { precision: "date_only", date: "2099-02-01", time: "" },
        procedureDeadline: { precision: "date_only", date: "2099-02-05", time: "" },
        receiveStart: { precision: "date_only", date: "2099-02-10", time: "" },
        receiveDeadline: { precision: "date_time", date: "2099-02-20", time: "18:00" },
      }),
      profs[0].id,
    );
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const d = await loadAppData(u1);
    const l = d.lotteries.find((x) => x.id === res.value.id)!;
    expect(l.procedureSplit).toBe(true);
    expect(l.procedureDeadline).toMatchObject({ precision: "date_only", date: "2099-02-05" });
    expect(l.receiveStart).toMatchObject({ precision: "date_only", date: "2099-02-10" });
    expect(l.receiveDeadline?.precision).toBe("date_time");

    const plain = await saveLottery(u1, hid, null, base(chainFuru, storeFuruTakara, { procedureDeadline: { precision: "date_only", date: "2099-03-01", time: "" } }), profs[0].id);
    expect(plain.ok).toBe(true);
    if (!plain.ok) return;
    const p = (await loadAppData(u1)).lotteries.find((x) => x.id === plain.value.id)!;
    expect(p.procedureSplit).toBe(false);
    expect(p.receiveStart?.precision).toBe("unknown");
    expect(p.kind).toBe("normal");
  });
  it("分離を解除して再保存すると、受取期間の値は残らない（共通期間に戻る）", async () => {
    const first = await saveLottery(u1, hid, null, base(chainFuru, storeFuruTakara, { procedureSplit: true, receiveDeadline: { precision: "date_only", date: "2099-02-20", time: "" } }), profs[0].id);
    if (!first.ok) throw new Error(first.error);
    const again = await saveLottery(u1, hid, first.value.id, base(chainFuru, storeFuruTakara, { procedureSplit: false, receiveDeadline: { precision: "date_only", date: "2099-02-20", time: "" } }), profs[0].id);
    expect(again.ok).toBe(true);
    const l = (await loadAppData(u1)).lotteries.find((x) => x.id === first.value.id)!;
    expect(l.procedureSplit).toBe(false);
    expect(l.receiveDeadline?.precision).toBe("unknown");
  });
  it("継続抽選・招待制販売: 抽選方式と有効期限が保存される。通常抽選では有効期限を持たない", async () => {
    const inv = await saveLottery(u1, hid, null, base(chainFuru, storeFuruTakara, { lotteryKind: "invite", validUntil: "2099-12-31" }), profs[0].id);
    const ong = await saveLottery(u1, hid, null, base(chainFuru, storeFuruTakara, { lotteryKind: "ongoing" }), profs[0].id);
    const nor = await saveLottery(u1, hid, null, base(chainFuru, storeFuruTakara, { lotteryKind: "normal", validUntil: "2099-12-31" }), profs[0].id);
    if (!inv.ok || !ong.ok || !nor.ok) throw new Error("save failed");
    const d = await loadAppData(u1);
    expect(d.lotteries.find((x) => x.id === inv.value.id)).toMatchObject({ kind: "invite", validUntil: "2099-12-31" });
    expect(d.lotteries.find((x) => x.id === ong.value.id)).toMatchObject({ kind: "ongoing" });
    expect(d.lotteries.find((x) => x.id === ong.value.id)!.validUntil).toBeUndefined();
    expect(d.lotteries.find((x) => x.id === nor.value.id)!.validUntil).toBeUndefined();
  });

  // ------------------------------------------------------------------ 締切後の応募記録
  it("後から記録する応募: 応募日時が不明なら applied_at は null（現在日時で偽らない）。日時を渡せばその時刻、他プロフィールの口座は操作できない", async () => {
    const lot = await saveLottery(u1, hid, null, base(chainFuru, storeFuruTakara), profs[0].id);
    if (!lot.ok) throw new Error(lot.error);
    await u1.rpc("ensure_profile_accounts");
    const acc = (await u1.from("service_accounts").select("id,managed_by_profile_id").eq("chain_id", chainFuru)).data!;
    const mine = acc.find((a) => a.managed_by_profile_id === profs[0].id)!;
    const other = acc.find((a) => a.managed_by_profile_id === profs[1].id)!;

    const unknownTime = await setApplied(u1, hid, lot.value.id, mine.id, true, profs[0].id, null, { backfill: true, appliedAt: null });
    expect(unknownTime.ok).toBe(true);
    const row = (await u1.from("applications").select("applied_at,state").eq("lottery_id", lot.value.id).eq("service_account_id", mine.id).single()).data!;
    expect(row.state).toBe("applied");
    expect(row.applied_at).toBeNull();

    const forbidden = await setApplied(u1, hid, lot.value.id, other.id, true, profs[0].id, null, { backfill: true, appliedAt: null });
    expect(forbidden.ok).toBe(false);

    // 通常の応募は従来どおり現在日時が入る
    const lot2 = await saveLottery(u1, hid, null, base(chainFuru, storeFuruTakara), profs[0].id);
    if (!lot2.ok) throw new Error(lot2.error);
    await setApplied(u1, hid, lot2.value.id, mine.id, true, profs[0].id);
    const normal = (await u1.from("applications").select("applied_at").eq("lottery_id", lot2.value.id).eq("service_account_id", mine.id).single()).data!;
    expect(normal.applied_at).not.toBeNull();

    // 取り消して、日時を指定して再度記録（JST→UTC）
    await setApplied(u1, hid, lot2.value.id, mine.id, false, profs[0].id);
    await setApplied(u1, hid, lot2.value.id, mine.id, true, profs[0].id, null, { backfill: true, appliedAt: "2099-01-05T10:30" });
    const dated = (await u1.from("applications").select("applied_at").eq("lottery_id", lot2.value.id).eq("service_account_id", mine.id).single()).data!;
    expect(new Date(dated.applied_at!).toISOString()).toBe("2099-01-05T01:30:00.000Z");
  });

  // ------------------------------------------------------------------ 系列の統合
  it("merge_chains: 一般ユーザー・未ログインは実行できない（service_role専用）", async () => {
    const r = await u1.rpc("merge_chains", { p_from: chainOld, p_into: chainFuru });
    expect(r.error).not.toBeNull();
    const a = await anonClient().rpc("merge_chains", { p_from: chainOld, p_into: chainFuru });
    expect(a.error).not.toBeNull();
    expect((await u1.from("chains").select("archived_at").eq("id", chainOld).single()).data!.archived_at).toBeNull();
  });
  it("merge_chains: 店舗・抽選・応募履歴を削除せず付け替え、同名店舗は統合先へ寄せ、統合元は非表示で残る。他世帯の系列とは統合できない", async () => {
    // 統合元(古本市場)に 抽選2件(宝塚店・深井店) と 応募(プロフィール1) を作る
    await u1.rpc("ensure_profile_accounts");
    const l1 = await saveLottery(u1, hid, null, base(chainOld, storeOldTakara, { applications: [] }), profs[0].id);
    const l2 = await saveLottery(u1, hid, null, base(chainOld, storeOldFukai), profs[0].id);
    if (!l1.ok || !l2.ok) throw new Error("save failed");
    await u1.rpc("ensure_profile_accounts");
    const accOld = (await u1.from("service_accounts").select("id,managed_by_profile_id").eq("chain_id", chainOld)).data!.find((a) => a.managed_by_profile_id === profs[0].id)!;
    expect((await setApplied(u1, hid, l1.value.id, accOld.id, true, profs[0].id)).ok).toBe(true);
    await u1.from("member_numbers").insert({ household_id: hid, profile_id: profs[2].id, chain_id: chainOld, member_no: "0007" });

    const before = {
      lotteries: (await u1.from("lotteries").select("id", { count: "exact", head: true })).count,
      stores: (await u1.from("stores").select("id", { count: "exact", head: true })).count,
      applications: (await u1.from("applications").select("id", { count: "exact", head: true })).count,
      accounts: (await u1.from("service_accounts").select("id", { count: "exact", head: true })).count,
    };

    // 他世帯の系列は統合できない
    const foreign = (await must(u2.from("chains").insert({ household_id: hid2, name: "他世帯" }).select("id").single())).id;
    const bad = await admin.rpc("merge_chains", { p_from: chainOld, p_into: foreign });
    expect(bad.error).not.toBeNull();

    const res = await admin.rpc("merge_chains", { p_from: chainOld, p_into: chainFuru });
    expect(JSON.stringify(res.error)).toBe("null");
    expect(res.data).toMatchObject({ stores_moved: 1, stores_merged: 1, lotteries: 2 });

    // 削除されたものはない
    expect((await u1.from("lotteries").select("id", { count: "exact", head: true })).count).toBe(before.lotteries);
    expect((await u1.from("stores").select("id", { count: "exact", head: true })).count).toBe(before.stores);
    expect((await u1.from("applications").select("id", { count: "exact", head: true })).count).toBe(before.applications);
    expect((await u1.from("service_accounts").select("id", { count: "exact", head: true })).count).toBe(before.accounts);

    // 付け替え: 抽選は統合先の系列、同名店舗(宝塚店)は統合先の店舗、別名の店舗(深井店)は統合先の系列へ移動
    const lots = (await u1.from("lotteries").select("id,chain_id,store_id").in("id", [l1.value.id, l2.value.id])).data!;
    expect(lots.every((l) => l.chain_id === chainFuru)).toBe(true);
    expect(lots.find((l) => l.id === l1.value.id)!.store_id).toBe(storeFuruTakara);
    expect(lots.find((l) => l.id === l2.value.id)!.store_id).toBe(storeOldFukai);
    expect((await u1.from("stores").select("chain_id").eq("id", storeOldFukai).single()).data!.chain_id).toBe(chainFuru);
    expect((await u1.from("stores").select("archived_at").eq("id", storeOldTakara).single()).data!.archived_at).not.toBeNull();

    // 応募履歴は統合先のアカウントに付け替わり、結果・状態は変わらない。統合元のアカウントは無効化（行は残る）
    const app = (await u1.from("applications").select("state,service_account_id").eq("lottery_id", l1.value.id).single()).data!;
    expect(app.state).toBe("applied");
    const accNew = (await u1.from("service_accounts").select("id,chain_id,active").eq("id", app.service_account_id).single()).data!;
    expect(accNew.chain_id).toBe(chainFuru);
    expect((await u1.from("service_accounts").select("active").eq("id", accOld.id).single()).data!.active).toBe(false);

    // 系列は非表示で残り、会員番号・別名は統合先へ
    expect((await u1.from("chains").select("archived_at").eq("id", chainOld).single()).data!.archived_at).not.toBeNull();
    expect((await u1.from("member_numbers").select("member_no").eq("chain_id", chainFuru).eq("profile_id", profs[2].id).single()).data!.member_no).toBe("0007");
    expect((await u1.from("chain_aliases").select("alias").eq("chain_id", chainFuru)).data!.map((x) => x.alias)).toContain("古本市場");

    // 統合後に「古本市場」で登録しても、統合先の系列（ふるいち）に入る（非表示の統合元を復活させない）
    const viaAlias = await saveLottery(u1, hid, null, { ...base(chainFuru, storeFuruTakara) }, profs[0].id);
    expect(viaAlias.ok).toBe(true);
    const named = await (async () => {
      const { saveLottery: raw } = await import("@/lib/server/lottery-service");
      return raw(u1, hid, null, { chain: { id: null, name: "古本市場" }, store: { id: null, name: "宝塚店", prefecture: "" }, multiMode: "single", campaignId: null, newCampaign: null, items: [{ product: { id: p1, name: "" }, quantity: 1, unit: "box" }], applyStart: EMPTY_FLEX, applyDeadline: EMPTY_FLEX, resultDate: EMPTY_FLEX, procedureStart: EMPTY_FLEX, procedureDeadline: EMPTY_FLEX, receiveMethod: "store", applyMethod: "web", conditionsText: "", verificationText: "", announcementMethod: "", announcementUrl: "", sourceUrls: [], eventState: "open", limitBasis: "account", limitMaxCount: 5, memo: "", applications: [], appliedAt: "" }, profs[0].id);
    })();
    expect(named.ok).toBe(true);
    if (!named.ok) return;
    const row = (await u1.from("lotteries").select("chain_id,store_id").eq("id", named.value.id).single()).data!;
    expect(row.chain_id).toBe(chainFuru);
    expect(row.store_id).toBe(storeFuruTakara);
    expect((await u1.from("chains").select("archived_at").eq("id", chainOld).single()).data!.archived_at).not.toBeNull();
  });
  it("merge_chains: 付け替え先を決められない設定（応募ルール）がある系列は、何も変更せず中止する", async () => {
    const x = (await must(u1.from("chains").insert({ household_id: hid, name: "統合テスト元" }).select("id").single())).id;
    const y = (await must(u1.from("chains").insert({ household_id: hid, name: "統合テスト先" }).select("id").single())).id;
    await u1.from("application_rules").insert({ household_id: hid, scope_type: "chain", chain_id: x, basis: "account", max_count: 1, counts_across: "lottery", confidence: "confirmed" });
    const ins = await u1.from("application_rules").select("id").eq("chain_id", x);
    expect((ins.data ?? []).length).toBe(1); // 前提: ルールが実際に作られている
    const r = await admin.rpc("merge_chains", { p_from: x, p_into: y });
    expect(r.error).not.toBeNull();
    expect((await u1.from("chains").select("archived_at").eq("id", x).single()).data!.archived_at).toBeNull();
  });
});
