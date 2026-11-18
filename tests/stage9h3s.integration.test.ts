/**
 * Stage 9H-3S の結合テスト（実Supabase・RLS適用下。AI・外部サイトなし・費用0円）:
 * 系列・商品の共通名寄せ（複合名称・表記揺れ）、別名の自律学習（由来・状態・根拠の記録、自己強化の防止、人が確定した別名の保護）、
 * 関連候補の保持、表示用の略称、既存データの一括再評価（計画→段階的な適用→元に戻す。保護対象は変更しない）。 npm run test:db
 */
/* eslint-disable @typescript-eslint/no-explicit-any -- 新しい表・列は生成型に含まれない */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { EMPTY_FLEX } from "@/lib/lottery-input";
import type { Db } from "@/lib/server/lottery-service";
import { applyReevalBatch, collectionBusy, createReevalPlan, lotteryProtection, revertReevalBatch } from "@/lib/server/master-identity/reeval-service";
import { saveLegacy as saveLottery, type LegacyInput } from "./helpers/legacy";
import { saveLottery as saveReal } from "@/lib/server/lottery-service";
import { adminClient, cleanupTestUsers, dbTestsEnabled, signInTestUser } from "./helpers/db";

const day = (offset: number) => new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10);
const flex = (offset: number) => ({ precision: "date_only" as const, date: day(offset), time: "" });

describe.skipIf(!dbTestsEnabled)("Stage 9H-3S: 名寄せ・別名の自律学習・略称・一括再評価", () => {
  const admin = adminClient();
  const userIds: string[] = [];
  let u1: Db;
  let hid: string;
  let profile: string;
  let chainA: string; // 正式名「あおぞら書店」・確認済みの別名「青空ブックス」
  let chainOther: string;
  let storeA: string;
  let storeOther: string;
  let prodA: string;
  const input = (storeId: string, chainId: string, productId: string, deadline: number, extra: Partial<LegacyInput> = {}): LegacyInput => ({
    chainId, storeId, campaignId: null, newCampaign: null,
    items: [{ productId, quantity: 1, unit: "box" }],
    applyStart: flex(deadline - 7), applyDeadline: flex(deadline), resultDate: EMPTY_FLEX, procedureDeadline: EMPTY_FLEX,
    receiveMethod: "store", applyMethod: "web", conditionsText: "", verificationText: "", announcementMethod: "", announcementUrl: "",
    sourceUrls: [], eventState: "open", limitBasis: "account", limitMaxCount: 1, memo: "", applications: [], appliedAt: "", isManaged: false, ...extra,
  });
  const mk = async (chainId: string, storeId: string, deadline: number, auto: boolean) => {
    const r = await saveLottery(u1, hid, null, input(storeId, chainId, prodA, deadline), profile);
    expect(r.ok, (r as { error?: string }).error).toBe(true);
    const id = (r as { value: { id: string } }).value.id;
    if (auto) await admin.from("lotteries").update({ source_kind: "auto", registration_path: "auto" }).eq("id", id);
    return id;
  };

  beforeAll(async () => {
    const x = await signInTestUser(admin, "s9h3s", 1);
    userIds.push(x.userId);
    u1 = x.db;
    hid = (await u1.rpc("bootstrap_household")).data as string;
    profile = (await u1.from("profiles").select("id").order("sort_order")).data![0].id;
    chainA = (await u1.from("chains").insert({ household_id: hid, name: "あおぞら書店" }).select("id").single()).data!.id;
    chainOther = (await u1.from("chains").insert({ household_id: hid, name: "ミライ玩具" }).select("id").single()).data!.id;
    await u1.from("chain_aliases").insert({ household_id: hid, chain_id: chainA, alias: "青空ブックス", normalized_alias: "青空ブックス" });
    storeA = (await u1.from("stores").insert({ household_id: hid, chain_id: chainA, name: "本店", prefecture: "大阪府" }).select("id").single()).data!.id;
    storeOther = (await u1.from("stores").insert({ household_id: hid, chain_id: chainOther, name: "東京店", prefecture: "東京都" }).select("id").single()).data!.id;
    prodA = (await u1.from("products").insert({ household_id: hid, official_name: "テストパック", packs_per_box: 30 }).select("id").single()).data!.id;
  });
  afterAll(async () => {
    await cleanupTestUsers(admin, userIds);
  });

  describe("名寄せと別名の自律学習", () => {
    const chainCount = async () => ((await u1.from("chains").select("id", { count: "exact", head: true })).count ?? 0) as number;
    it("複合名称（A・B／A（B））は、既存の系列に紐づき、新しい仮登録の系列を作らない。複合名称は由来・状態・根拠つきの別名として記録される", async () => {
      const before = await chainCount();
      for (const [i, name] of ["青空ブックス・あおぞら書店", "あおぞら書店（青空ブックス）"].entries()) {
        const r = await saveReal(u1, hid, null, { ...(await toInput(storeA, name, i)) }, profile, { autoCollected: true });
        expect(r.ok, (r as { error?: string }).error).toBe(true);
        const l = (await u1.from("lotteries").select("chain_id").eq("id", (r as { value: { id: string } }).value.id).single()).data!;
        expect(l.chain_id).toBe(chainA);
      }
      expect(await chainCount()).toBe(before);
      const al = (await (u1 as any).from("chain_aliases").select("alias,source,status,evidence").eq("chain_id", chainA)) as { data: { alias: string; source: string; status: string; evidence: Record<string, unknown> }[] };
      const learned = al.data.find((a) => a.alias === "青空ブックス・あおぞら書店");
      expect(learned?.source).toBe("ai");
      expect(learned?.status).toBe("inferred");
      expect(learned?.evidence.basis).toBe("composite_of_confirmed");
      // 人が確定した既存の別名は変わらない
      const human = al.data.find((a) => a.alias === "青空ブックス");
      expect(human?.status).toBe("confirmed");
      expect(human?.source).toBe("manual"); // 画面・手動で登録した別名（導入前の既存行は legacy）
    });
    it("AIが推定した別名だけを根拠にした一致からは、別名を増やさない（自己強化の防止）", async () => {
      // AIが推定した別名（確認済みではない）を1つ用意する
      await admin.from("chain_aliases").insert({ household_id: hid, chain_id: chainA, alias: "旧青空", normalized_alias: "旧青空", source: "ai", status: "inferred" });
      const n = ((await u1.from("chain_aliases").select("id", { count: "exact", head: true }).eq("chain_id", chainA)).count ?? 0) as number;
      // その別名だけを根拠にした複合名称は、同じ系列に紐づくが、別名としては増やさない
      const r = await saveReal(u1, hid, null, await toInput(storeA, "旧青空・あおぞら書店", 5), profile, { autoCollected: true });
      expect(r.ok, (r as { error?: string }).error).toBe(true);
      const l = (await u1.from("lotteries").select("chain_id").eq("id", (r as { value: { id: string } }).value.id).single()).data!;
      expect(l.chain_id).toBe(chainA);
      const after = ((await u1.from("chain_aliases").select("id", { count: "exact", head: true }).eq("chain_id", chainA)).count ?? 0) as number;
      expect(after).toBe(n);
      // 確認済みの別名・正式名の組み合わせ（本店のような一般語を含む）は学習できる
      const r2 = await saveReal(u1, hid, null, await toInput(storeA, "青空ブックス・あおぞら書店・本店", 5), profile, { autoCollected: true });
      expect(r2.ok).toBe(true);
      expect(((await u1.from("chain_aliases").select("id", { count: "exact", head: true }).eq("chain_id", chainA)).count ?? 0) as number).toBe(n + 1);
    });
    it("名称が近いだけの系列は寄せない。新しい仮登録の系列になり、関連候補として保持される（確定しない）", async () => {
      const r = await saveReal(u1, hid, null, await toInput(null, "ミライ玩具センター", 6), profile, { autoCollected: true });
      expect(r.ok, (r as { error?: string }).error).toBe(true);
      const l = (await u1.from("lotteries").select("chain_id").eq("id", (r as { value: { id: string } }).value.id).single()).data!;
      expect(l.chain_id).not.toBe(chainOther);
      const c = (await (u1 as any).from("master_alias_candidates").select("kind,observed_name,candidate_master_id,relation,status").eq("kind", "chain")) as { data: { observed_name: string; candidate_master_id: string; relation: string; status: string }[] };
      const row = c.data.find((x) => x.observed_name === "ミライ玩具センター");
      expect(row?.candidate_master_id).toBe(chainOther);
      expect(row?.relation).toBe("possible_same");
      expect(row?.status).toBe("open");
      // 既存のマスターの別名には追加されていない
      expect(((await u1.from("chain_aliases").select("id").eq("chain_id", chainOther)).data ?? []).length).toBe(0);
    });
    it("商品: 購入券などの装飾・ゲーム名は同じ商品に紐づく。型番・版が違えば紐づかない（仮登録）", async () => {
      const prodCount = async () => ((await u1.from("products").select("id", { count: "exact", head: true })).count ?? 0) as number;
      const before = await prodCount();
      const same = await saveReal(u1, hid, null, await toInput(storeA, "あおぞら書店", 7, "拡張パック「テストパック」 購入券(抽選)"), profile, { autoCollected: true });
      expect(same.ok).toBe(true);
      expect(await prodCount()).toBe(before);
      const items = (await u1.from("lottery_items").select("product_id").eq("lottery_id", (same as { value: { id: string } }).value.id)).data!;
      expect(items[0].product_id).toBe(prodA);
      const other = await saveReal(u1, hid, null, await toInput(storeA, "あおぞら書店", 8, "テストパック 限定版"), profile, { autoCollected: true });
      expect(other.ok).toBe(true);
      expect(await prodCount()).toBe(before + 1);
    });
    it("略称の列: 設定でき、別名とは別に保存される（空欄は未設定）。AIの学習は略称を変更しない", async () => {
      const { error } = await u1.from("products" as never).update({ short_name: "テスパ" } as never).eq("id", prodA);
      expect(error).toBeNull();
      await saveReal(u1, hid, null, await toInput(storeA, "あおぞら書店", 9, "テストパック 購入券"), profile, { autoCollected: true });
      const p = (await u1.from("products").select("short_name" as never).eq("id", prodA).single()).data as unknown as { short_name: string };
      expect(p.short_name).toBe("テスパ");
      const { error: tooLong } = await u1.from("products" as never).update({ short_name: "あ".repeat(41) } as never).eq("id", prodA);
      expect(tooLong).not.toBeNull();
      expect((await u1.from("product_aliases").select("alias").eq("product_id", prodA)).data!.map((a) => a.alias)).not.toContain("テスパ");
    });
  });

  describe("既存データの一括再評価（計画→段階的な適用→元に戻す）", () => {
    let expiredAuto: string;
    let expiredStar: string;
    let expiredManual: string;
    let activeAuto: string;
    let regionAuto: string;
    let batchId: string;
    beforeAll(async () => {
      // 地域設定: 大阪府のみ対象
      await admin.from("collection_settings").delete().eq("household_id", hid);
      const cs = await admin.from("collection_settings").insert({ household_id: hid, prefectures: ["大阪府"], include_online: true });
      expect(cs.error).toBeNull();
      expiredAuto = await mk(chainA, storeA, -20, true);
      expiredStar = await mk(chainA, storeA, -21, true);
      expiredManual = await mk(chainA, storeA, -22, false);
      activeAuto = await mk(chainA, storeA, 10, true);
      regionAuto = await mk(chainOther, storeOther, 10, true);
      await admin.from("lottery_management").upsert({ lottery_id: expiredStar, household_id: hid, is_managed: true, managed_source: "manual" }, { onConflict: "lottery_id" });
    });
    it("計画: 期限切れ・地域外の自動収集の未処理だけを提案する。★・人が登録した抽選・期限内は対象にしない（変更はまだ0件）", async () => {
      const r = await createReevalPlan(u1, hid, profile);
      expect(r.ok, (r as { error?: string }).error).toBe(true);
      batchId = (r as { batchId: string }).batchId;
      const items = (await (u1 as any).from("master_reeval_items").select("target_id,action,status").eq("batch_id", batchId)).data!;
      const by = (id: string) => items.filter((i: any) => i.target_id === id).map((i: any) => i.action);
      expect(by(expiredAuto)).toEqual(["archive_expired"]);
      expect(by(regionAuto)).toEqual(["archive_region"]);
      expect(by(expiredStar)).toEqual([]);
      expect(by(expiredManual)).toEqual([]);
      expect(by(activeAuto)).toEqual([]);
      expect(items.every((i: any) => i.status === "proposed")).toBe(true);
      // 計画の作成では何も変更しない
      const ls = (await u1.from("lotteries").select("id,archived_at").in("id", [expiredAuto, regionAuto])).data!;
      expect(ls.every((l) => l.archived_at === null)).toBe(true);
      expect(await lotteryProtection(u1, expiredStar)).toMatch(/要チェック/);
      expect(await lotteryProtection(u1, expiredManual)).toMatch(/人が登録/);
    });
    it("適用は区分・上限件数つきで段階的に行い、再実行しても二重に変更しない。適用の直前に保護を再確認する", async () => {
      // 計画の後に、対象が★になったら適用しない
      await admin.from("lottery_management").upsert({ lottery_id: regionAuto, household_id: hid, is_managed: true, managed_source: "manual" }, { onConflict: "lottery_id" });
      const a = await applyReevalBatch(u1, hid, profile, batchId, { actions: ["archive_expired", "archive_region"], limit: 10 });
      expect(a.ok, (a as { error?: string }).error).toBe(true);
      expect((a as { applied: number }).applied).toBe(1);
      const st = async (id: string) => (await u1.from("lotteries").select("archived_at").eq("id", id).single()).data!.archived_at;
      expect(await st(expiredAuto)).not.toBeNull();
      expect(await st(regionAuto)).toBeNull(); // ★になったため適用されない
      const skipped = (await (u1 as any).from("master_reeval_items").select("status,error").eq("batch_id", batchId).eq("target_id", regionAuto)).data![0];
      expect(skipped.status).toBe("skipped");
      expect(skipped.error).toMatch(/要チェック/);
      // 再実行: 適用済みは再適用されない
      const again = await applyReevalBatch(u1, hid, profile, batchId, { actions: ["archive_expired", "archive_region"], limit: 10 });
      expect((again as { applied: number }).applied).toBe(0);
      expect(await st(expiredStar)).toBeNull();
      expect(await st(expiredManual)).toBeNull();
      expect(await st(activeAuto)).toBeNull();
      // 除外の記録（理由・日時）が残る
      const ex = (await (u1 as any).from("lottery_exclusions").select("reason,note").eq("lottery_id", expiredAuto)).data!;
      expect(ex).toHaveLength(1);
      expect(ex[0].note).toMatch(/9H-3S再評価/);
    });
    it("元に戻す: 適用した抽選が復元される（応募・購入の記録は触らない）", async () => {
      const r = await revertReevalBatch(u1, profile, batchId);
      expect(r.ok).toBe(true);
      expect((r as { reverted: number }).reverted).toBe(1);
      expect((await u1.from("lotteries").select("archived_at,exclusion_reason_code").eq("id", expiredAuto).single()).data).toEqual({ archived_at: null, exclusion_reason_code: null });
      const item = (await (u1 as any).from("master_reeval_items").select("status").eq("batch_id", batchId).eq("target_id", expiredAuto)).data![0];
      expect(item.status).toBe("reverted");
    });
    it("通常の収集の実行中は適用しない（競合防止）", async () => {
      expect(await collectionBusy(u1)).toBe(false);
      await admin.from("discovery_runs").insert({ household_id: hid, slot: "2099-01-01T00", trigger: "cron", status: "running", started_at: new Date().toISOString() });
      expect(await collectionBusy(u1)).toBe(true);
      const a = await applyReevalBatch(u1, hid, profile, batchId, { actions: ["archive_expired"], limit: 10 });
      expect(a.ok).toBe(false);
      expect((a as { error: string }).error).toMatch(/収集が実行中/);
      await admin.from("discovery_runs").delete().eq("household_id", hid);
    });
  });

  // 保存用の入力（実際の saveLottery の入力形式。系列・商品は名前だけ＝名寄せの対象）
  async function toInput(storeId: string | null, chainName: string, deadline: number, productName = "テストパック") {
    const st = storeId ? (await u1.from("stores").select("name,prefecture").eq("id", storeId).single()).data! : { name: "新規の店", prefecture: "東京都" };
    const base = input(storeId ?? storeA, chainA, prodA, deadline);
    const { chainId: _c, storeId: _s, items: _i, applications: _a, ...rest } = base;
    void [_c, _s, _i, _a];
    return { ...rest, chain: { id: null, name: chainName }, store: { id: storeId, name: st.name, prefecture: st.prefecture }, items: [{ id: null, product: { id: null, name: productName }, quantity: 1, unit: "box" as const }], applications: [] };
  }
});
