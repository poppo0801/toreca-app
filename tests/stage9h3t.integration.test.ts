/* eslint-disable @typescript-eslint/no-explicit-any -- 新しい表・列は生成型に含まれない */
/**
 * Stage 9H-3T の結合テスト（実Supabase・RLS適用下。AI・外部は使わない。費用0円）:
 *  - 仮登録の重複マスター（表記揺れで同一）を、正式マスターへ統合する。抽選・店舗・別名の参照先が付け替わり、統合元は非表示・名称は別名に残る
 *  - 応募・当選の履歴は抽選のIDで結びついたまま変わらない／人が確定した（仮登録でない）統合元・同名店舗の衝突は統合しない
 *  - 元に戻す: 付け替えた行だけが統合元へ戻る（その後に利用者が変えた行には触れない）
 * npm run test:db
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { EMPTY_FLEX } from "@/lib/lottery-input";
import type { Db } from "@/lib/server/lottery-service";
import { EMPTY_CLASSIFY_CTX } from "@/lib/agent/case-investigator/source-class";
import { verifyNameJudgment, type NameJudgment } from "@/lib/agent/name-judge";
import { runAiReevaluation } from "@/lib/server/agent/reeval-ai-run";
import type { AiDeps } from "@/lib/server/agent/reeval-ai-service";
import { applyReevalBatch, createReevalPlan, revertReevalBatch } from "@/lib/server/master-identity/reeval-service";
import { resolveMasterAndLearn } from "@/lib/server/master-identity/alias-service";
import { mergeProvisionalMaster, unsupportedReferences } from "@/lib/server/master-identity/merge-service";
import { saveLegacy as saveLottery, type LegacyInput } from "./helpers/legacy";
import { adminClient, cleanupTestUsers, dbTestsEnabled, signInTestUser } from "./helpers/db";

const day = (offset: number) => new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10);
const flex = (offset: number) => ({ precision: "date_only" as const, date: day(offset), time: "" });

describe("参照の対象外の判定（純関数）", () => {
  it("抽選・店舗・別名以外の参照があれば対象外（購入・応募アカウントなど）", () => {
    expect(unsupportedReferences("chain", { stores: 2, lotteries: 3, aliases: 1, purchases: 0 })).toEqual([]);
    expect(unsupportedReferences("chain", { stores: 1, purchases: 2, service_accounts: 1 })).toEqual(["purchases", "service_accounts"]);
    expect(unsupportedReferences("product", { lottery_items: 4, aliases: 1, purchase_items: 0, box_lots: 1 })).toEqual(["box_lots"]);
  });
});

describe.skipIf(!dbTestsEnabled)("Stage 9H-3T: 重複マスターの整理と取り消し", () => {
  const admin = adminClient();
  const userIds: string[] = [];
  let u1: Db;
  let hid: string;
  let profile: string;
  let formal: string;
  let prov: string;
  let provStore: string;
  let prodFormal: string;
  let prodProv: string;
  let lotId: string;
  let batchId: string;

  const input = (chainId: string, storeId: string, productId: string): LegacyInput => ({
    chainId, storeId, campaignId: null, newCampaign: null, items: [{ productId, quantity: 1, unit: "box" }],
    applyStart: EMPTY_FLEX, applyDeadline: flex(10), resultDate: flex(13), procedureDeadline: EMPTY_FLEX, receiveMethod: "store", applyMethod: "web",
    conditionsText: "", verificationText: "", announcementMethod: "", announcementUrl: "", sourceUrls: ["https://events.example.test/x"], eventState: "open", limitBasis: "account", limitMaxCount: 1, memo: "", applications: [], applyUnitNote: "",
  } as unknown as LegacyInput);
  const q = (t: string) => (u1 as any).from(t);

  beforeAll(async () => {
    const x = await signInTestUser(admin, "s9h3t", 1);
    userIds.push(x.userId);
    u1 = x.db;
    hid = (await u1.rpc("bootstrap_household")).data as string;
    profile = (await u1.from("profiles").select("id").order("sort_order")).data![0].id;
    await admin.from("collection_settings").delete().eq("household_id", hid);
    await admin.from("collection_settings").insert({ household_id: hid, prefectures: ["東京都"], include_online: true });
    formal = (await u1.from("chains").insert({ household_id: hid, name: "テスト書店" }).select("id").single()).data!.id as string;
    // 仮登録（自動収集が作った表記揺れ。半角カナ）
    prov = (await u1.from("chains").insert({ household_id: hid, name: "ﾃｽﾄ書店", is_provisional: true }).select("id").single()).data!.id as string;
    provStore = (await u1.from("stores").insert({ household_id: hid, chain_id: prov, name: "渋谷店", prefecture: "東京都" }).select("id").single()).data!.id as string;
    prodFormal = (await u1.from("products").insert({ household_id: hid, official_name: "テスト商品ボックス", packs_per_box: 30 }).select("id").single()).data!.id as string;
    prodProv = (await u1.from("products").insert({ household_id: hid, official_name: "ﾃｽﾄ商品ボックス", packs_per_box: 30, is_provisional: true }).select("id").single()).data!.id as string;
    const r = await saveLottery(u1, hid, null, input(prov, provStore, prodProv), profile);
    expect(r.ok, (r as { error?: string }).error).toBe(true);
    lotId = (r as { value: { id: string } }).value.id;
    await admin.from("lotteries").update({ source_kind: "auto", registration_path: "auto" }).eq("id", lotId);
  });
  afterAll(async () => {
    await cleanupTestUsers(admin, userIds);
  });

  it("計画: 表記揺れで同一の仮登録マスターが、確信度 high の統合候補になる", async () => {
    const r = await createReevalPlan(u1, hid, profile);
    expect(r.ok, (r as { error?: string }).error).toBe(true);
    batchId = (r as { batchId: string }).batchId;
    const items = (await q("master_reeval_items").select("target_id,target_type,proposal").eq("batch_id", batchId).eq("action", "merge_master")).data as { target_id: string; target_type: string; proposal: { relatedId: string; evidence: { confidence: string } } }[];
    const c = items.find((i) => i.target_id === prov)!;
    expect(c.proposal.relatedId).toBe(formal);
    expect(c.proposal.evidence.confidence).toBe("high");
    expect(items.find((i) => i.target_id === prodProv)?.proposal.relatedId).toBe(prodFormal);
  });

  it("適用: 抽選・店舗・商品行の参照先が正式マスターへ付け替わり、統合元は非表示・名称は別名に残る。抽選のIDは変わらない", async () => {
    const a = await applyReevalBatch(u1, hid, profile, batchId, { actions: ["merge_master"], limit: 25 });
    expect(a.ok, (a as { error?: string }).error).toBe(true);
    expect((a as { applied: number }).applied).toBe(2);
    const lot = (await q("lotteries").select("id,chain_id").eq("id", lotId).single()).data;
    expect(lot.chain_id).toBe(formal);
    expect((await q("stores").select("chain_id").eq("id", provStore).single()).data.chain_id).toBe(formal);
    expect((await q("lottery_items").select("product_id").eq("lottery_id", lotId)).data.map((x: any) => x.product_id)).toEqual([prodFormal]);
    expect((await q("chains").select("archived_at").eq("id", prov).single()).data.archived_at).not.toBeNull();
    expect((await q("products").select("archived_at").eq("id", prodProv).single()).data.archived_at).not.toBeNull();
    // 統合元の名称が統合先と同じ名称（表記揺れだけの違い）のときは、別名を重ねて作らない
    expect((await q("chain_aliases").select("id").eq("chain_id", formal)).data).toHaveLength(0);
    // 対応関係の記録（移した行のID・統合元の名称）
    const it = (await q("master_reeval_items").select("before_state,status").eq("batch_id", batchId).eq("target_id", prov).eq("action", "merge_master").single()).data;
    expect(it.status).toBe("applied");
    expect(it.before_state).toMatchObject({ fromId: prov, intoId: formal, fromName: "ﾃｽﾄ書店", lotteryIds: [lotId], storeIds: [provStore] });
  });

  it("元に戻す: 付け替えた行だけが統合元へ戻り、統合元の非表示・追加した別名も戻る。再適用しても二重に変更しない", async () => {
    const r = await revertReevalBatch(u1, profile, batchId, {});
    expect((r as { reverted: number }).reverted).toBe(2);
    expect((await q("lotteries").select("chain_id").eq("id", lotId).single()).data.chain_id).toBe(prov);
    expect((await q("stores").select("chain_id").eq("id", provStore).single()).data.chain_id).toBe(prov);
    expect((await q("lottery_items").select("product_id").eq("lottery_id", lotId)).data.map((x: any) => x.product_id)).toEqual([prodProv]);
    expect((await q("chains").select("archived_at").eq("id", prov).single()).data.archived_at).toBeNull();
    expect((await q("chain_aliases").select("id").eq("chain_id", formal).eq("alias", "ﾃｽﾄ書店")).data).toHaveLength(0);
  });

  it("保護: 人が確定した（仮登録でない）マスターは統合元にしない／統合先に同名の店舗があれば何も変更しない", async () => {
    const human = (await u1.from("chains").insert({ household_id: hid, name: "ﾃｽﾄ書店" + "２" }).select("id").single()).data!.id as string;
    const r1 = await mergeProvisionalMaster(u1, hid, "chain", human, formal, profile);
    expect(r1.ok).toBe(false);
    expect((r1 as { error: string }).error).toContain("正式なマスター");
    // 統合先に同名の店舗（渋谷店）を作ると、統合元の店舗と衝突する
    await u1.from("stores").insert({ household_id: hid, chain_id: formal, name: "渋谷店", prefecture: "東京都" });
    const r2 = await mergeProvisionalMaster(u1, hid, "chain", prov, formal, profile);
    expect(r2.ok).toBe(false);
    expect((r2 as { error: string }).error).toContain("同名の店舗");
    expect((await q("lotteries").select("chain_id").eq("id", lotId).single()).data.chain_id).toBe(prov); // 何も変わっていない
    expect((await q("chains").select("archived_at").eq("id", prov).single()).data.archived_at).toBeNull();
  });

  it("取り消し後の、利用者による変更には触れない（統合先を指していない行は戻さない）", async () => {
    // 統合先に店舗の衝突が無い状態へ
    await admin.from("stores").delete().eq("chain_id", formal).eq("name", "渋谷店");
    const m = await mergeProvisionalMaster(u1, hid, "chain", prov, formal, profile);
    expect(m.ok, (m as { error?: string }).error).toBe(true);
    // 利用者が、移った店舗を別の系列へ付け替えた
    const other = (await u1.from("chains").insert({ household_id: hid, name: "別の系列" }).select("id").single()).data!.id as string;
    await q("stores").update({ chain_id: other }).eq("id", provStore);
    const { revertMasterMerge } = await import("@/lib/server/master-identity/merge-service");
    await revertMasterMerge(u1, (m as { before: any }).before);
    expect((await q("stores").select("chain_id").eq("id", provStore).single()).data.chain_id).toBe(other); // 触れない
    expect((await q("lotteries").select("chain_id").eq("id", lotId).single()).data.chain_id).toBe(prov); // 戻る
  });

  it("AIが同一と確認した重複候補（音の近さ）は、統合の項目になり適用できる。AIが別と判断した候補・確認できない候補は統合しない", async () => {
    const formalG = (await u1.from("chains").insert({ household_id: hid, name: "ジラフル" }).select("id").single()).data!.id as string;
    const provG = (await u1.from("chains").insert({ household_id: hid, name: "GIRAFULL", is_provisional: true }).select("id").single()).data!.id as string;
    const relation = "same" as "same" | "different";
    const deps: AiDeps = {
      model: "test", classify: EMPTY_CLASSIFY_CTX, capJpy: 100, spentJpy: () => 0, stopped: () => null,
      investigate: async () => { throw new Error("not used"); }, research: async () => { throw new Error("not used"); },
      judge: async () => ({ judgments: [], raw: [], usage: { inputTokens: 0, outputTokens: 0 } }),
      webSearch: async () => [{ title: "GIRAFULL（ジラフル）公式", url: "https://girafull.example.test/about", snippet: "GIRAFULL（ジラフル）はトレカ専門店です" }, { title: "ジラフル（GIRAFULL）新店", url: "https://news.example.test/a", snippet: "ジラフル（GIRAFULL）が新店舗をオープン" }],
      judgeNames: async (items) => {
        const it = items[0];
        const raw: NameJudgment = { observed: it.query.observed, candidateId: it.query.candidateId, relation, rationale: "併記", cites: it.hits.map((h) => ({ url: h.url, quote: h.snippet })) };
        return { judgments: [verifyNameJudgment(raw, it.query, it.hits)], usage: { inputTokens: 0, outputTokens: 0 } };
      },
    };
    const plan = await createReevalPlan(u1, hid, profile);
    const bid = (plan as { batchId: string }).batchId;
    await applyReevalBatch(u1, hid, profile, bid, { actions: ["merge_master"], limit: 25 });
    expect((await q("chains").select("archived_at").eq("id", provG).single()).data.archived_at).toBeNull(); // AIの確認の前は統合しない（音の近さだけでは統合しない）
    await runAiReevaluation(u1, hid, profile, bid, deps, { limit: 30 });
    const mergeItem = (await q("master_reeval_items").select("ai_state,ai_result,proposal").eq("batch_id", bid).eq("target_id", provG).eq("action", "merge_master")).data;
    expect(mergeItem).toHaveLength(1);
    expect(mergeItem[0].ai_result.verdict).toBe("confirm");
    const a = await applyReevalBatch(u1, hid, profile, bid, { actions: ["merge_master"], limit: 25 });
    expect((a as { applied: number }).applied).toBeGreaterThanOrEqual(1);
    expect((await q("chains").select("archived_at").eq("id", provG).single()).data.archived_at).not.toBeNull();
    // 統合元の名称は、統合先の別名として残る（以後の収集は「GIRAFULL」を統合先に解決できる）
    const al = (await q("chain_aliases").select("alias,source,status").eq("chain_id", formalG)).data as { alias: string; source: string; status: string }[];
    expect(al.some((x) => x.alias === "GIRAFULL")).toBe(true);
    // 通常収集（手動・自動収集・自律型AIが共通で通る入口）も、同じ結果を使う: 「GIRAFULL」と観測した名称は、新しい仮登録を作らず統合先に解決される
    const r = await resolveMasterAndLearn(u1, hid, "chain", "GIRAFULL", { origin: "collector", learn: false });
    expect(r.matchedId).toBe(formalG);
  });
});
