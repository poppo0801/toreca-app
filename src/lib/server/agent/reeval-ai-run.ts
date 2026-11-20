import type { StoredEvidence } from "@/lib/collector/evidence";
import { recordHardSource } from "@/lib/server/collector/sources-health";
import { loadBlockedHosts, loadStoredEvidence } from "@/lib/server/agent/stored-evidence";
import "server-only";
import type { NameQuery } from "@/lib/agent/name-judge";
import type { RelFacts } from "@/lib/agent/relation-judge";
import type { FieldKey } from "@/lib/collector/fields";
import type { ExistingLottery } from "@/lib/agent/reeval-ai/assess";
import type { Db } from "@/lib/server/lottery-service";
import { accumulateStoreLocation, judgeFormGroup, learnFromInvestigation, reinvestigateLottery, researchRegion, resolveNameWithAi, type AiDeps, type LearnedAlias } from "@/lib/server/agent/reeval-ai-service";
import { loadMasterEntries } from "@/lib/server/master-identity/alias-service";

/**
 * DBつきのAI再評価バッチ（Stage 9H-3S-2）。計画の項目のうち、AIが未調査のものを、費用の上限の範囲で調査する。
 * 1回に調べる単位の数（limit）で区切って再開できる（調査済みの項目は再調査しない）。実際に情報源を取得できなかったものは調査済みにしない。
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- 新しい表・列は生成型に含まれない
const any = (db: Db) => db as any;

export interface AiRunReport {
  /** Stage 9Z: 取得部品の統計（保存済み原文の再利用・取得制限の再試行抑制・ホスト別の成否） */
  fetch?: import("@/lib/agent/case-investigator/evidence-fetcher").EvidenceFetchStats;
  units: number;
  investigated: number;
  insufficient: number;
  failed: number;
  confirmed: number;
  refuted: number;
  fillsCreated: number;
  costJpy: number;
  stopped: string | null;
  learned: LearnedAlias[];
  locations: { store: string; updated: boolean; reason: string }[];
  records: { itemId: string; action: string; aiState: string; verdict: string }[];
}

const jstDate = (iso: string | null): string | null => (iso ? new Date(Date.parse(iso) + 9 * 3600_000).toISOString().slice(0, 10) : null);
const pick = (date: string | null, at: string | null) => date ?? jstDate(at);

interface LotRow {
  id: string;
  chain_id: string;
  store_id: string | null;
  store_mode: string;
  source_urls: string[] | null;
  apply_start_date: string | null;
  apply_start_at: string | null;
  apply_deadline_date: string | null;
  apply_deadline_at: string | null;
  result_date: string | null;
  result_at: string | null;
  confirmed_at: string | null;
}
type Item = { id: string; target_type: string; target_id: string; action: string; proposal: { subKind?: string; relatedId?: string; reason?: string }; seq: number };

export async function runAiReevaluation(db: Db, householdId: string, actor: string | null, batchId: string, deps: AiDeps, o: { limit: number; now?: Date; learn?: boolean; /** 実行の締切（ミリ秒の時刻）。サーバーレスの時間制限の前に、区切りのよい所で止めて次回に再開する */ deadlineMs?: number } = { limit: 5 }): Promise<AiRunReport> {
  const now = o.now ?? new Date();
  const report: AiRunReport = { units: 0, investigated: 0, insufficient: 0, failed: 0, confirmed: 0, refuted: 0, fillsCreated: 0, costJpy: 0, stopped: null, learned: [], locations: [], records: [] };
  const a = any(db);
  const { data: batch } = await a.from("master_reeval_batches").select("id,params").eq("id", batchId).eq("household_id", householdId).maybeSingle();
  if (!batch) throw new Error("計画が見つかりません");
  const prefs = ((batch.params as { prefectures?: string[] }).prefectures ?? []) as string[];
  // 費用は、バッチへ積み上げる（実行ごとの合計。通常収集の予算とは別枠）。この実行の分だけを、開始時点との差で数える
  const startSpent = deps.spentJpy();
  const priorCost = Number((batch.params as { costJpy?: number }).costJpy ?? 0);
  const { data: items } = await a.from("master_reeval_items").select("id,target_type,target_id,action,proposal,seq").eq("batch_id", batchId).eq("status", "proposed").eq("ai_state", "not_investigated").in("action", ["review", "archive_region", "archive_expired", "archive_duplicate", "consolidate_lotteries", "dismiss_candidate", "merge_master"]).order("seq").limit(1000);
  const NAME_SUB = ["master_candidate", "name_candidate"];
  const all = ((items ?? []) as Item[]).filter((i) => (i.target_type === "lottery" && (i.action !== "review" || i.proposal.subKind === "missing_dates")) || (i.action === "review" && NAME_SUB.includes(i.proposal.subKind ?? "")) || (i.action === "merge_master" && (i.target_type === "chain" || i.target_type === "product") && !!i.proposal.relatedId && (i.proposal as { evidence?: { confidence?: string } }).evidence?.confidence !== "high") || (i.target_type === "candidate" && i.action === "dismiss_candidate"));
  if (all.length === 0) return report;

  const lotAll = all.filter((i) => i.target_type === "lottery");
  const ids = [...new Set([...lotAll.map((i) => i.target_id), ...all.map((i) => i.proposal.relatedId).filter((x): x is string => !!x), ...lotAll.flatMap((i) => ((i.proposal as { evidence?: { memberIds?: string[] } }).evidence?.memberIds ?? []))])];
  const { data: lots } = await a.from("lotteries").select("id,chain_id,store_id,store_mode,source_urls,apply_start_date,apply_start_at,apply_deadline_date,apply_deadline_at,result_date,result_at,confirmed_at").in("id", ids);
  const row = new Map(((lots ?? []) as LotRow[]).map((l) => [l.id, l]));
  const chainIds = [...new Set([...row.values()].map((l) => l.chain_id))];
  const storeIds = [...new Set([...row.values()].map((l) => l.store_id).filter((x): x is string => !!x))];
  const [{ data: chains }, { data: stores }, { data: lis }, { data: aliases }] = await Promise.all([
    a.from("chains").select("id,name").in("id", chainIds),
    storeIds.length ? a.from("stores").select("id,name,prefecture,chain_id,address_optional").in("id", storeIds) : { data: [] },
    a.from("lottery_items").select("lottery_id,product_id").in("lottery_id", ids),
    a.from("chain_aliases").select("chain_id,alias").in("chain_id", chainIds),
  ]);
  // Stage 9Z: 初回収集で保存した原文（無ければ保存なし）と、過去の取得制限の記録（読み取りのみ）。取得部品へ接続して、再取得の無駄を省く
  const storedMap = await loadStoredEvidence(db, ids).catch(() => new Map<string, StoredEvidence[]>());
  const blockedHosts = await loadBlockedHosts(db, householdId, now).catch(() => new Set<string>());
  const hostKey = (u: string) => { try { return new URL(u).hostname.replace(/^www./, "").toLowerCase(); } catch { return ""; } };
  deps.attachLedger?.({ knownBlocked: (u) => blockedHosts.has(hostKey(u)), onBlocked: (u, m) => { void recordHardSource(db, householdId, now, { url: u, failKind: "robots" }); void m; } });
  const chainName = new Map(((chains ?? []) as { id: string; name: string }[]).map((c) => [c.id, c.name]));
  const storeRow = new Map(((stores ?? []) as { id: string; name: string; prefecture: string; chain_id: string; address_optional: string }[]).map((s) => [s.id, s]));
  const liRows = (lis ?? []) as { lottery_id: string; product_id: string }[];
  const prodIds = [...new Set(liRows.map((x) => x.product_id))];
  const { data: prods } = prodIds.length ? await a.from("products").select("id,official_name").in("id", prodIds) : { data: [] };
  const prodName = new Map(((prods ?? []) as { id: string; official_name: string }[]).map((p) => [p.id, p.official_name]));
  const existingOf = (id: string): ExistingLottery | null => {
    const l = row.get(id);
    if (!l) return null;
    const st = l.store_id ? storeRow.get(l.store_id) : undefined;
    const humanFields: FieldKey[] = l.confirmed_at ? ["applyStart", "applyDeadline", "resultDate"] : [];
    return {
      id,
      chain: chainName.get(l.chain_id) ?? "",
      store: st?.name ?? null,
      storeMode: l.store_mode === "select_on_apply" ? "select_on_apply" : "fixed",
      products: liRows.filter((x) => x.lottery_id === id).map((x) => prodName.get(x.product_id) ?? "").filter(Boolean),
      applyStart: pick(l.apply_start_date, l.apply_start_at),
      applyDeadline: pick(l.apply_deadline_date, l.apply_deadline_at),
      resultDate: pick(l.result_date, l.result_at),
      sourceUrls: (l.source_urls ?? []).slice(0, 5),
      humanFields,
      ...(storedMap.get(id)?.length ? { storedEvidence: storedMap.get(id) } : {}),
    };
  };
  const save = async (it: Item, u: { aiState: string; verdict: string; summary: Record<string, unknown>; costJpy: number }) => {
    await a.from("master_reeval_items").update({ ai_state: u.aiState, ai_result: { verdict: u.verdict, ...u.summary }, ai_cost_jpy: Math.round(u.costJpy * 100) / 100, ai_at: new Date().toISOString() }).eq("id", it.id).eq("ai_state", "not_investigated");
    report.records.push({ itemId: it.id, action: it.action, aiState: u.aiState, verdict: u.verdict });
    if (u.aiState === "investigated") report.investigated++;
    else if (u.aiState === "insufficient") report.insufficient++;
    else report.failed++;
    if (u.verdict === "confirm") report.confirmed++;
    if (u.verdict === "refute") report.refuted++;
  };
  const budgetLeft = () => deps.capJpy - deps.spentJpy();

  // 優先順: 日付の補完（価値が高い）→ 対象地域外（店舗ごとに1回）→ 期限切れ → 重複（AIの関係判定は最後にまとめて1回）
  const order = (i: Item) => (i.action === "review" ? (i.proposal.subKind === "missing_dates" ? 0 : 4) : i.action === "consolidate_lotteries" ? 1 : i.action === "archive_region" ? 2 : i.action === "archive_expired" ? 3 : 5);
  const units = all.filter((i) => i.action !== "archive_duplicate" && !(i.target_type === "candidate" && i.proposal.subKind === "duplicate")).sort((x, y) => order(x) - order(y) || x.seq - y.seq);
  const doneStores = new Map<string, Awaited<ReturnType<typeof researchRegion>>>();
  // 抽選候補の下書きから、調査の入力（系列・店舗・商品・締切・情報源）を作る（必要になったときに1回だけ読む）
  type Cand = { chain: string; store: string; prefecture: string; asLottery: ExistingLottery };
  let candCache: Map<string, Cand> | null = null;
  const loadCandidates = async (): Promise<Map<string, Cand>> => {
    if (candCache) return candCache;
    candCache = new Map();
    const cids = all.filter((i) => i.target_type === "candidate").map((i) => i.target_id);
    if (cids.length === 0) return candCache;
    const { data: cs } = await a.from("collection_candidates").select("id,draft,due_at").in("id", cids);
    for (const c of (cs ?? []) as { id: string; draft: { input?: Record<string, unknown> } | null; due_at: string | null }[]) {
      const inp = (c.draft?.input ?? {}) as { chain?: { name?: string }; store?: { name?: string; prefecture?: string }; items?: { product?: { name?: string } }[]; applyDeadline?: { date?: string }; applyStart?: { date?: string }; resultDate?: { date?: string }; sourceUrls?: string[]; storeMode?: string };
      const dl = inp.applyDeadline?.date ?? (c.due_at ? jstDate(c.due_at) : null);
      candCache.set(c.id, {
        chain: inp.chain?.name ?? "",
        store: inp.store?.name ?? "",
        prefecture: inp.store?.prefecture ?? "",
        asLottery: { id: c.id, chain: inp.chain?.name ?? "", store: inp.store?.name || null, storeMode: inp.storeMode === "select_on_apply" ? "select_on_apply" : "fixed", products: (inp.items ?? []).map((x) => x.product?.name ?? "").filter(Boolean), applyStart: inp.applyStart?.date || null, applyDeadline: dl || null, resultDate: inp.resultDate?.date || null, sourceUrls: (inp.sourceUrls ?? []).slice(0, 5), humanFields: [] },
      });
    }
    return candCache;
  };
  for (const it of units) {
    if (report.units >= o.limit) break;
    if (deps.stopped()) {
      report.stopped = deps.stopped();
      break;
    }
    if (budgetLeft() < 6) {
      report.stopped = `費用の上限（${deps.capJpy}円）に達する見込みのため、残りは未調査のまま`;
      break;
    }
    if (o.deadlineMs !== undefined && Date.now() > o.deadlineMs) {
      report.stopped = "実行時間の上限に達したため、続きは次の実行で再開します";
      break;
    }
    // ---- 名称の同一性（系列・商品の表記揺れ）: AIがWebで調べ、根拠が揃えば別名を学習する
    if ((it.action === "review" && NAME_SUB.includes(it.proposal.subKind ?? "")) || it.action === "merge_master") {
      const ev = (it.proposal as { evidence?: { kind?: string; observed?: string; candidateMasterId?: string; candidateName?: string } }).evidence ?? {};
      let q: NameQuery | null = null;
      if (it.proposal.subKind === "name_candidate" && ev.observed && ev.candidateMasterId) {
        const ms = await loadMasterEntries(db, householdId, "chain");
        const cand = ms.find((m) => m.id === ev.candidateMasterId);
        if (cand) q = { kind: "chain", observed: ev.observed, candidateId: cand.id, candidateName: cand.name, candidateAliases: (cand.aliases ?? []).map((x) => x.text) };
      } else if ((it.proposal.subKind === "master_candidate" || it.action === "merge_master") && (it.target_type === "chain" || it.target_type === "product") && it.proposal.relatedId) {
        const ms = await loadMasterEntries(db, householdId, it.target_type);
        const me = ms.find((m) => m.id === it.target_id);
        const cand = ms.find((m) => m.id === it.proposal.relatedId);
        if (me && cand) q = { kind: it.target_type, observed: me.name, candidateId: cand.id, candidateName: cand.name, candidateAliases: (cand.aliases ?? []).map((x) => x.text) };
      }
      if (!q) continue;
      const out = await resolveNameWithAi(db, householdId, deps, q, actor, it.proposal.subKind === "master_candidate" || it.action === "merge_master" ? { excludeMasterId: it.target_id } : {});
      report.units++;
      if (out.learned) report.learned.push(out.learned);
      await save(it, out);
      // 重複の候補（音の近さなど）をAIが同一と確認したら、統合の項目を作る（統合元が仮登録のときだけ適用される。元に戻せる）
      if (it.proposal.subKind === "master_candidate" && out.verdict === "confirm" && (it.target_type === "chain" || it.target_type === "product") && it.proposal.relatedId) {
        await a.from("master_reeval_items").upsert({ batch_id: batchId, household_id: householdId, seq: 100000 + it.seq, target_type: it.target_type, target_id: it.target_id, action: "merge_master", risk: "medium", proposal: { reason: `AIが調べて「${q.candidateName}」と同じと確認（${String(out.summary.rationale ?? "").slice(0, 100)}）`, relatedId: it.proposal.relatedId, evidence: { keep: q.candidateName, from: q.observed, confidence: "ai_confirmed", cites: out.summary.cites ?? null } }, ai_state: "investigated", ai_result: { verdict: "confirm", ...out.summary }, ai_cost_jpy: 0, ai_at: new Date().toISOString() }, { onConflict: "batch_id,target_type,target_id,action", ignoreDuplicates: true });
      }
      continue;
    }
    // ---- 抽選候補（確認待ち）: 候補の下書きと情報源を、AIが調べ直す
    if (it.target_type === "candidate") {
      const cands = await loadCandidates();
      const c = cands.get(it.target_id);
      if (!c) continue;
      if (it.proposal.subKind === "region") {
        const sName = c.store;
        if (!sName) continue;
        const out = await researchRegion(deps, { chain: c.chain, name: sName, prefecture: c.prefecture, knownDomains: [], siblingNames: [], chainAliases: [] }, null, prefs);
        report.units++;
        await save(it, out);
        continue;
      }
      if (it.proposal.subKind === "expired") {
        const out = await reinvestigateLottery(deps, c.asLottery, now);
        report.units++;
        await save(it, out);
        continue;
      }
      continue;
    }
    // ---- 同じ抽選の店舗別カード: AIが情報源から応募構造（店舗選択式か店舗別か）を判断する。正解は渡さない
    if (it.action === "consolidate_lotteries") {
      const keepL = existingOf(it.target_id);
      if (!keepL) continue;
      const memberIds = ((it.proposal as { evidence?: { memberIds?: string[] } }).evidence?.memberIds ?? []).filter((x) => x !== it.target_id);
      const urls = [...new Set([...keepL.sourceUrls, ...memberIds.flatMap((m) => existingOf(m)?.sourceUrls ?? [])])].slice(0, 5);
      const out = await judgeFormGroup(deps, { ...keepL, store: null, storeMode: "fixed", sourceUrls: urls }, now);
      report.units++;
      await save(it, { ...out, summary: { ...out.summary, memberIds: [it.target_id, ...memberIds] } });
      if (o.learn !== false && out.result && out.aiState !== "failed") report.learned.push(...(await learnFromInvestigation(db, householdId, out.result, actor)));
      continue;
    }
    const l = existingOf(it.target_id);
    if (!l) continue;
    if (it.action === "archive_region") {
      const sid = row.get(it.target_id)?.store_id;
      const st = sid ? storeRow.get(sid) : undefined;
      if (!st) continue;
      let out = doneStores.get(st.id);
      const fresh = !out;
      if (!out) {
        const siblings = [...storeRow.values()].filter((s) => s.chain_id === st.chain_id && s.id !== st.id).map((s) => s.name).slice(0, 12);
        const aliasList = ((aliases ?? []) as { chain_id: string; alias: string }[]).filter((x) => x.chain_id === st.chain_id).map((x) => x.alias);
        out = await researchRegion(deps, { chain: l.chain, name: st.name, prefecture: st.prefecture ?? "", knownDomains: [], siblingNames: siblings, chainAliases: aliasList }, st.address_optional || null, prefs);
        doneStores.set(st.id, out);
        report.units++;
        if (out.research) report.locations.push({ store: st.name, ...(await accumulateStoreLocation(db, st.id, out.research)) });
      }
      await save(it, { ...out, costJpy: fresh ? out.costJpy : 0 });
      continue;
    }
    // 日付の補完・期限切れ: 情報元URL・公式情報を調べ直す
    const out = await reinvestigateLottery(deps, l, now);
    report.units++;
    // 期限切れの確認は、締切の判断（調査）に従う。日付の補完のみの項目（review）は、補完できたものを確認とする
    const verdict = it.action === "review" ? ((out.assessment?.fills.length ?? 0) > 0 ? "confirm" : "inconclusive") : out.verdict;
    await save(it, { ...out, verdict });
    if (out.assessment && out.assessment.fills.length > 0) {
      const fill = out.assessment.fills;
      const { error } = await a.from("master_reeval_items").upsert(
        {
          batch_id: batchId,
          household_id: householdId,
          seq: 100000 + report.fillsCreated,
          target_type: "lottery",
          target_id: it.target_id,
          action: "fill_fields",
          risk: "low",
          proposal: { reason: `AIが情報元を調べて、空欄の日付を確認できた（${fill.map((f) => f.label).join("・")}）`, changes: fill.map((f) => ({ field: f.field, to: f.to, from: f.from })), evidence: fill.map((f) => ({ field: f.field, evidence: f.evidence, independentOrigins: f.independentOrigins })) },
          ai_state: "investigated",
          ai_result: { verdict: "confirm", basis: "ai_investigation", fetched: out.assessment.fetched, differs: out.assessment.differs },
          ai_cost_jpy: 0,
          ai_at: new Date().toISOString(),
        },
        { onConflict: "batch_id,target_type,target_id,action", ignoreDuplicates: true },
      );
      if (!error) report.fillsCreated++;
    }
    if (o.learn !== false && out.result && out.aiState !== "failed") report.learned.push(...(await learnFromInvestigation(db, householdId, out.result, actor)));
  }

  // 重複: AIが組ごとの関係（A重複／B別店舗／C独立）を判断する。登録済みの事実だけでの判断は「調査済み」にしない（情報源の調査を経てから）
  const dups = all.filter((i) => i.action === "archive_duplicate" && i.target_type === "lottery" && i.proposal.relatedId && report.units < o.limit && !deps.stopped() && budgetLeft() >= 3);
  if (dups.length > 0) {
    const facts = (id: string): RelFacts | null => {
      const e = existingOf(id);
      return e ? { id, chain: e.chain, store: e.store, storeMode: e.storeMode, products: e.products, applyStart: e.applyStart, applyDeadline: e.applyDeadline, resultDate: e.resultDate, urls: e.sourceUrls, humanConfirmed: !!row.get(id)?.confirmed_at } : null;
    };
    const lotsF = [...new Set(dups.flatMap((i) => [i.target_id, i.proposal.relatedId as string]))].map(facts).filter((x): x is RelFacts => !!x);
    const pairs = dups.map((i): [string, string] => [i.target_id, i.proposal.relatedId as string]);
    const before = deps.spentJpy();
    try {
      const j = await deps.judge(lotsF, pairs);
      report.units++;
      const per = (deps.spentJpy() - before) / dups.length;
      for (const it of dups) {
        const v = j.judgments.find((x) => (x.a === it.target_id && x.b === it.proposal.relatedId) || (x.b === it.target_id && x.a === it.proposal.relatedId));
        if (!v) {
          await save(it, { aiState: "insufficient", verdict: "inconclusive", summary: { note: "AIがこの組を判断しなかった" }, costJpy: per });
          continue;
        }
        await save(it, { aiState: "insufficient", verdict: v.relation === "duplicate" && v.autoApplicable ? "confirm" : v.relation === "undetermined" ? "inconclusive" : "refute", summary: { relation: v.relation, rationale: v.rationale, cites: v.cites, adjusted: v.adjusted, basis: "登録済みの事実のみ（情報源の調査は未実施）" }, costJpy: per });
      }
    } catch (e) {
      for (const it of dups) await save(it, { aiState: "failed", verdict: "inconclusive", summary: { error: e instanceof Error ? e.message.slice(0, 160) : "判定に失敗" }, costJpy: 0 });
    }
  }
  report.costJpy = Math.round((deps.spentJpy() - startSpent) * 100) / 100;
  // 一括再評価の費用を、バッチに別枠で記録する（通常収集の予算とは別）
  await a.from("master_reeval_batches").update({ params: { ...(batch.params as object), costJpy: Math.round((priorCost + report.costJpy) * 100) / 100, costCapJpy: deps.capJpy + priorCost, lastAiRunAt: new Date().toISOString() } }).eq("id", batchId);
  const fs9z = deps.fetchStats?.();
  if (fs9z) report.fetch = fs9z;
  return report;
}
