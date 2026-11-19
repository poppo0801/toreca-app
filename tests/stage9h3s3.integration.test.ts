/* eslint-disable @typescript-eslint/no-explicit-any -- 新しい表・列は生成型に含まれない */
/**
 * Stage 9H-3S-3 の結合テスト（実Supabase・RLS適用下。AI・外部サイトは台本で差し替え。費用0円）:
 *  - 同じ情報源・同じ商品の店舗別カードを、AIが情報源で店舗選択式と確認したときだけ1件へ統合する（統合元は非表示・対応関係と変更前を記録・元に戻せる・保護されたカードは触らない）
 *  - 店舗別独立と確認されたものは統合しない／確認できなければ（取得できず）適用できない
 *  - 名称の同一性: 検証を通った根拠（独立した2つ以上のドメインで併記）があれば別名を学習し、取り消せる（同じ誤りを繰り返さない）
 *  - 抽選候補（確認待ち）も、AIが調べて確認したものだけを除外対象にできる
 * npm run test:db
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { CaseInvestigationResult } from "@/lib/agent/case-investigator/engine";
import { EMPTY_CLASSIFY_CTX } from "@/lib/agent/case-investigator/source-class";
import { verifyNameJudgment, type NameJudgment } from "@/lib/agent/name-judge";
import { EMPTY_FLEX } from "@/lib/lottery-input";
import type { Db } from "@/lib/server/lottery-service";
import { runAiReevaluation } from "@/lib/server/agent/reeval-ai-run";
import type { AiDeps } from "@/lib/server/agent/reeval-ai-service";
import { listLearnedAliases, revokeLearnedAlias } from "@/lib/server/master-identity/reeval-ai-hook";
import { applyReevalBatch, createReevalPlan, revertReevalBatch } from "@/lib/server/master-identity/reeval-service";
import { saveLegacy as saveLottery, type LegacyInput } from "./helpers/legacy";
import { adminClient, cleanupTestUsers, dbTestsEnabled, signInTestUser } from "./helpers/db";

const day = (offset: number) => new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10);
const flex = (offset: number) => ({ precision: "date_only" as const, date: day(offset), time: "" });
const URL_SEL = "https://events.example.test/select-event";
const URL_IND = "https://events.example.test/independent-event";

const src = (url: string, status = "fetched") => ({ url, kind: "organizer_official", tier: "primary", status, fetchedAt: "", origin: "events.example.test", derivedFrom: null, contributed: [], quotes: {}, ...(status === "failed" ? { failKind: "http_error", failReason: "404" } : {}) });
const result = (id: string, o: { fetched: boolean; form?: string; url?: string }): CaseInvestigationResult =>
  ({
    caseId: id, status: o.fetched ? "completed" : "failed", stopReason: "sufficient", stopLabel: "", aiFinish: null, fields: [], extraFields: [],
    extras: o.form ? [{ key: "form", value: o.form, quote: o.form === "store_select" ? "応募フォームで店舗を選択してください" : "各店舗の受付ページから別々にお申し込みください", sourceUrl: o.url ?? URL_SEL, kind: "organizer_official", tier: "primary", at: "2026-11-19T00:00:00Z" }] : [],
    sources: [src(o.url ?? URL_SEL, o.fetched ? "fetched" : "failed")], steps: [], queries: ["q"], fetched: [], unreported: [], notMerged: [], usage: {}, injectionFlags: 0, followUps: 0, policyChanges: [],
  }) as unknown as CaseInvestigationResult;

describe.skipIf(!dbTestsEnabled)("Stage 9H-3S-3: 店舗別カードの統合・名称の自律学習・候補の再調査（台本のAI）", () => {
  const admin = adminClient();
  const userIds: string[] = [];
  let u1: Db;
  let hid: string;
  let profile: string;
  let chainSel: string;
  let chainInd: string;
  let chainUnk: string;
  let prodSel: string;
  let prodInd: string;
  let prodUnk: string;
  let spent = 0;
  const L: Record<string, string> = {};
  let batchId: string;
  let formalChain: string;
  let provChain: string;

  const input = (chainId: string, storeId: string, productId: string, url: string, deadline: number): LegacyInput => ({
    chainId, storeId, campaignId: null, newCampaign: null, items: [{ productId, quantity: 1, unit: "box" }],
    applyStart: EMPTY_FLEX, applyDeadline: flex(deadline), resultDate: flex(deadline + 3), procedureDeadline: EMPTY_FLEX, receiveMethod: "store", applyMethod: "web",
    conditionsText: "", verificationText: "", announcementMethod: "", announcementUrl: "", sourceUrls: [url], eventState: "open", limitBasis: "account", limitMaxCount: 1, memo: "", applications: [], appliedAt: "", isManaged: false,
  });
  const mk = async (name: string, chainId: string, storeId: string, productId: string, url: string, deadline: number) => {
    const r = await saveLottery(u1, hid, null, input(chainId, storeId, productId, url, deadline), profile);
    expect(r.ok, (r as { error?: string }).error).toBe(true);
    const id = (r as { value: { id: string } }).value.id;
    await admin.from("lotteries").update({ source_kind: "auto", registration_path: "auto" }).eq("id", id);
    L[name] = id;
  };

  const deps: AiDeps = {
    model: "test",
    classify: EMPTY_CLASSIFY_CTX,
    capJpy: 100,
    spentJpy: () => spent,
    stopped: () => null,
    investigate: async (t) => {
      spent += 5;
      // 台本: 抽選の識別（系列）で、情報源から読み取れる応募構造が決まる（判定処理に正解は渡さない。台本のAIの出力にすぎない）
      if (t.chain === "ふるいち系A") return result(t.id, { fetched: true, form: "store_select", url: URL_SEL });
      if (t.chain === "独立系B") return result(t.id, { fetched: true, form: "store_independent", url: URL_IND });
      return result(t.id, { fetched: false, url: "https://unreachable.example.test/x" });
    },
    research: async () => {
      throw new Error("not used");
    },
    judge: async () => ({ judgments: [], raw: [], usage: { inputTokens: 0, outputTokens: 0 } }),
    webSearch: async () => [
      { title: "GIRAFULL（ジラフル）公式", url: "https://girafull.example.test/about", snippet: "GIRAFULL（ジラフル）はトレカ専門店です" },
      { title: "ジラフル（GIRAFULL）新店オープン", url: "https://news.example.test/a", snippet: "ジラフル（GIRAFULL）が新店舗をオープン" },
    ],
    judgeNames: async (items) => {
      spent += 1;
      const it = items[0];
      const raw: NameJudgment = { observed: it.query.observed, candidateId: it.query.candidateId, relation: "same", rationale: "併記", cites: it.hits.map((h) => ({ url: h.url, quote: h.snippet })) };
      return { judgments: [verifyNameJudgment(raw, it.query, it.hits)], usage: { inputTokens: 0, outputTokens: 0 } };
    },
  };

  beforeAll(async () => {
    const x = await signInTestUser(admin, "s9h3s3", 1);
    userIds.push(x.userId);
    u1 = x.db;
    hid = (await u1.rpc("bootstrap_household")).data as string;
    profile = (await u1.from("profiles").select("id").order("sort_order")).data![0].id;
    const ch = async (name: string) => (await u1.from("chains").insert({ household_id: hid, name }).select("id").single()).data!.id as string;
    const pr = async (name: string) => (await u1.from("products").insert({ household_id: hid, official_name: name, packs_per_box: 30 }).select("id").single()).data!.id as string;
    const stores = async (chainId: string, names: string[]) => Promise.all(names.map(async (n) => (await u1.from("stores").insert({ household_id: hid, chain_id: chainId, name: n, prefecture: "東京都" }).select("id").single()).data!.id as string));
    chainSel = await ch("ふるいち系A");
    chainInd = await ch("独立系B");
    chainUnk = await ch("不明系C");
    prodSel = await pr("テスト商品A");
    prodInd = await pr("テスト商品B");
    prodUnk = await pr("テスト商品C");
    const [s1, s2, s3] = await stores(chainSel, ["A渋谷店", "A新宿店", "A池袋店"]);
    const [i1, i2] = await stores(chainInd, ["B渋谷店", "B新宿店"]);
    const [k1, k2] = await stores(chainUnk, ["C渋谷店", "C新宿店"]);
    await admin.from("collection_settings").delete().eq("household_id", hid);
    await admin.from("collection_settings").insert({ household_id: hid, prefectures: ["東京都"], include_online: true });
    await mk("sel1", chainSel, s1, prodSel, URL_SEL, 10);
    await mk("sel2", chainSel, s2, prodSel, URL_SEL, 10);
    await mk("sel3", chainSel, s3, prodSel, URL_SEL, 10);
    await mk("ind1", chainInd, i1, prodInd, URL_IND, 10);
    await mk("ind2", chainInd, i2, prodInd, URL_IND, 10);
    await mk("unk1", chainUnk, k1, prodUnk, "https://unreachable.example.test/x", 10);
    await mk("unk2", chainUnk, k2, prodUnk, "https://unreachable.example.test/x", 10);
    // 保護: sel3 は人が確認した抽選（統合の対象にしない）
    await admin.from("lotteries").update({ confirmed_at: new Date().toISOString() }).eq("id", L.sel3);
    // 名称: 正式なマスター「ジラフル」と、自動収集の仮登録「GIRAFULL」
    formalChain = await ch("ジラフル");
    provChain = (await u1.from("chains").insert({ household_id: hid, name: "GIRAFULL", is_provisional: true }).select("id").single()).data!.id as string;
    // 抽選候補（確認待ち）: 締切を過ぎている
    await (u1 as any).from("collection_candidates").insert({ household_id: hid, dedupe_key: "https://cand.example.test/old", source_url: "https://cand.example.test/old", title: "古い候補", status: "pending", job_state: "review", reasons: ["要確認"], due_at: new Date(Date.now() - 30 * 86_400_000).toISOString(), draft: { input: { chain: { id: null, name: "候補系列" }, store: { id: null, name: "候補店", prefecture: "東京都" }, storeMode: "fixed", items: [{ product: { id: null, name: "候補商品" } }], applyDeadline: { precision: "date_only", date: day(-30), time: "" }, sourceUrls: ["https://cand.example.test/old"] } } });
  });
  afterAll(async () => {
    await cleanupTestUsers(admin, userIds);
  });

  const row = async (id: string) => (await (u1 as any).from("lotteries").select("archived_at,store_mode,store_id,selectable_stores,lottery_form,lottery_form_source").eq("id", id).single()).data;
  const item = async (target: string, action: string) => (await (u1 as any).from("master_reeval_items").select("id,status,ai_state,ai_result,before_state,after_state,proposal").eq("batch_id", batchId).eq("target_id", target).eq("action", action).maybeSingle()).data;

  it("計画: 同じ情報源・同じ商品の店舗別カードが統合の候補になる。AIが確認するまで適用できない", async () => {
    const r = await createReevalPlan(u1, hid, profile);
    expect(r.ok, (r as { error?: string }).error).toBe(true);
    batchId = (r as { batchId: string }).batchId;
    const groups = (await (u1 as any).from("master_reeval_items").select("target_id,proposal").eq("batch_id", batchId).eq("action", "consolidate_lotteries")).data as { target_id: string; proposal: { evidence: { memberIds: string[]; protectedIds: string[] } } }[];
    expect(groups).toHaveLength(3); // 選択式A・独立B・不明C
    const sel = groups.find((g) => g.proposal.evidence.memberIds.includes(L.sel1))!;
    expect(sel.proposal.evidence.memberIds.sort()).toEqual([L.sel1, L.sel2, L.sel3].sort());
    expect(sel.proposal.evidence.protectedIds).toEqual([L.sel3]); // 保護されたカードは含めるが、統合の対象にしない
    expect(sel.target_id).not.toBe(L.sel3); // 統合先は保護されていないカード
    const a = await applyReevalBatch(u1, hid, profile, batchId, { actions: ["consolidate_lotteries"], limit: 50 });
    expect((a as { applied: number }).applied).toBe(0);
    expect((await row(L.sel1)).store_mode).toBe("fixed");
  });

  it("AI再調査: 情報源から店舗選択式と確認できたものだけ confirm。店舗別独立は refute、取得できなければ調査済みにしない", async () => {
    const rep = await runAiReevaluation(u1, hid, profile, batchId, deps, { limit: 30 });
    expect(rep.stopped).toBeNull();
    const keepSel = (await (u1 as any).from("master_reeval_items").select("target_id,ai_state,ai_result").eq("batch_id", batchId).eq("action", "consolidate_lotteries")).data as { target_id: string; ai_state: string; ai_result: { verdict: string; form: string } }[];
    const bySel = keepSel.find((k) => [L.sel1, L.sel2].includes(k.target_id))!;
    expect(bySel.ai_state).toBe("investigated");
    expect(bySel.ai_result.verdict).toBe("confirm");
    expect(bySel.ai_result.form).toBe("store_select");
    const byInd = keepSel.find((k) => [L.ind1, L.ind2].includes(k.target_id))!;
    expect(byInd.ai_result.verdict).toBe("refute");
    const byUnk = keepSel.find((k) => [L.unk1, L.unk2].includes(k.target_id))!;
    expect(byUnk.ai_state).toBe("failed"); // 取得できなかったものは調査済みにしない
  });

  it("適用: 店舗選択式の1件へ統合。統合元は非表示（対応関係つき）。人が確認したカードと、否定・取得できなかった組は触らない", async () => {
    const a = await applyReevalBatch(u1, hid, profile, batchId, { actions: ["consolidate_lotteries"], limit: 50 });
    expect(a.ok, (a as { error?: string }).error).toBe(true);
    expect((a as { applied: number }).applied).toBe(1);
    const keepId = ((await (u1 as any).from("master_reeval_items").select("target_id").eq("batch_id", batchId).eq("action", "consolidate_lotteries").eq("status", "applied")).data as { target_id: string }[])[0].target_id;
    const other = [L.sel1, L.sel2].find((x) => x !== keepId)!;
    const keep = await row(keepId);
    expect(keep.store_mode).toBe("select_on_apply");
    expect(keep.store_id).toBeNull();
    expect(keep.lottery_form).toBe("store_select");
    expect(keep.lottery_form_source).toBe("ai");
    expect((keep.selectable_stores as { name: string }[]).map((s) => s.name).sort()).toEqual(["A新宿店", "A渋谷店"]); // 統合した店舗だけ（保護された池袋店は含めない）
    const o = await row(other);
    expect(o.archived_at).not.toBeNull();
    const ex = (await (u1 as any).from("lottery_exclusions").select("reason,duplicate_of_lottery_id").eq("lottery_id", other).single()).data;
    expect(ex).toMatchObject({ reason: "duplicate", duplicate_of_lottery_id: keepId }); // 統合先との対応関係
    expect((await row(L.sel3)).archived_at).toBeNull(); // 人が確認したカードは触らない
    expect((await row(L.sel3)).store_mode).toBe("fixed");
    for (const id of [L.ind1, L.ind2, L.unk1, L.unk2]) expect((await row(id)).store_mode).toBe("fixed"); // 否定・取得できなかった組は変更なし
    // 再実行しても二重に変更しない
    expect(((await applyReevalBatch(u1, hid, profile, batchId, { actions: ["consolidate_lotteries"], limit: 50 })) as { applied: number }).applied).toBe(0);
    const it = await item(keepId, "consolidate_lotteries");
    expect(it.status).toBe("applied");
    expect(it.before_state.keep.store_mode).toBe("fixed"); // 変更前の状態を記録
  });

  it("元に戻す: 統合先は店舗固定へ、統合元は表示へ戻る", async () => {
    const r = await revertReevalBatch(u1, profile, batchId);
    expect(r.ok).toBe(true);
    for (const id of [L.sel1, L.sel2, L.sel3]) {
      const x = await row(id);
      expect(x.archived_at).toBeNull();
      expect(x.store_mode).toBe("fixed");
      expect(x.selectable_stores).toBeNull();
      expect(x.lottery_form).toBeNull();
    }
  });

  it("名称の自律学習: 検証を通った根拠（独立した2ドメインで併記）があれば別名を学習し、取り消せる。取り消した誤学習は繰り返さない", async () => {
    // 前のAI再調査で、仮登録名「GIRAFULL」と正式「ジラフル」（音が近い候補）が調べられ、根拠が揃って別名が学習されている
    const learned = await listLearnedAliases(u1, hid);
    const a = learned.find((x) => x.kind === "chain" && /girafull/i.test(x.alias))!;
    expect(a).toBeTruthy();
    expect(a.master).toBe("ジラフル"); // 正式なマスターへ。仮登録名が正式名より優先されない
    expect(formalChain).toBeTruthy();
    expect(a.reason).toMatch(/独立した複数の情報源/);
    // 取り消し → 別名が消え、同じ根拠では再学習しない
    expect((await revokeLearnedAlias(u1, hid, "chain", a.id)).ok).toBe(true);
    expect((await listLearnedAliases(u1, hid)).find((x) => x.id === a.id)).toBeUndefined();
    spent = 0;
    const plan = await createReevalPlan(u1, hid, profile);
    batchId = (plan as { batchId: string }).batchId;
    expect((await item(provChain, "review"))?.proposal?.subKind).toBe("master_candidate"); // 別名が無いので、再び候補として挙がる
    await runAiReevaluation(u1, hid, profile, batchId, deps, { limit: 30 });
    expect((await listLearnedAliases(u1, hid)).find((x) => /girafull/i.test(x.alias))).toBeUndefined(); // 取り消した誤学習は繰り返さない
  });

  it("抽選候補: AIが締切を確認できれば除外の対象。取得できなければ未適用のまま", async () => {
    spent = 0;
    await runAiReevaluation(u1, hid, profile, batchId, deps, { limit: 30 });
    const cands = (await (u1 as any).from("master_reeval_items").select("id,target_id,ai_state,ai_result,proposal").eq("batch_id", batchId).eq("action", "dismiss_candidate")).data as { id: string; ai_state: string; proposal: { subKind: string } }[];
    expect(cands).toHaveLength(1);
    expect(cands[0].proposal.subKind).toBe("expired");
    // 台本: 情報源を取得できない → 調査済みにしない（適用できない）
    expect(cands[0].ai_state).toBe("failed");
    const a = await applyReevalBatch(u1, hid, profile, batchId, { actions: ["dismiss_candidate"], limit: 50 });
    expect((a as { applied: number }).applied).toBe(0);
  });
});
