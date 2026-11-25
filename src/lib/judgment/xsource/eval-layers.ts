/**
 * 評価の3層分離と、分母・対応関係の監査（純関数・採点値は変えない。既存の指標・閾値は比較用にそのまま保持する）。
 *
 *   発見（discovery）   : 応募機会が存在し、見つけられたか（再現率・適合率・誤統合・誤分割）
 *   抽出（extraction）  : 抽出した項目の精度と根拠の確度（店舗・商品・締切・時刻・年・応募単位・URL・引用の有効性）
 *   運用（operation）   : 本登録／保留／除外の判断（判断の一致・誤登録・取りこぼし・誤除外）
 *
 * 守ること: 分母が0（測定する例が無い）は「未測定（unmeasured）」であり、0%や100%として扱わない。
 * 既存の falseRegisterRate は分母が「対応づいた全機会」で、goldに登録しない例が無いと常に0%になる。ここでは、正しい分母（登録すべきでないgold機会）で別に数え、未測定を明示する。
 */
import { aggregate, type CaseScore, type GoldCase, type Rate } from "./compare-eval";
import type { ProposalRecord } from "./proposal";
import { classifyUnitAgreement, type UnitAgreement } from "./apply-scope";

export type MetricStatus = "measured" | "unmeasured";
export interface LayerMetric {
  key: string;
  label: string;
  k: number | null;
  n: number;
  value: number | null;
  status: MetricStatus;
  /** 未測定の理由・分母の注意 */
  note?: string;
}

const metric = (key: string, label: string, k: number, n: number, note?: string): LayerMetric => ({ key, label, k: n === 0 ? null : k, n, value: n === 0 ? null : k / n, status: n === 0 ? "unmeasured" : "measured", ...(n === 0 ? { note: note ?? "測定する例が無い（0%でも100%でもない）" } : note ? { note } : {}) });
const fromRate = (key: string, label: string, r: Rate | { n: number; value: number | null }, note?: string): LayerMetric => ("k" in r ? metric(key, label, r.k, r.n, note) : { key, label, k: null, n: r.n, value: r.value, status: r.value === null ? "unmeasured" : "measured", ...(note ? { note } : {}) });

export interface LayeredReport {
  discovery: LayerMetric[];
  extraction: LayerMetric[];
  operation: LayerMetric[];
  /** goldの限界（測定できないもの）。評価の読み方に必ず付ける */
  goldLimits: string[];
  /** 応募単位の食い違いの内訳（明確な誤り／定義が決まらないための食い違い） */
  unitAgreement: Record<UnitAgreement, number>;
  /** 分母・対象・対応関係の監査 */
  audit: { goldOpps: number; goldNonRegisterOpps: number; goldDecisionCounts: Record<string, number>; matchedOpps: number; unmatchedGoldOpps: number; unmatchedRegisterProposals: number; casesScored: number };
}

export function layeredReport(a: { scores: readonly CaseScore[]; gold: readonly GoldCase[]; recordsByCase?: ReadonlyMap<string, readonly ProposalRecord[]> }): LayeredReport {
  const agg = aggregate(a.scores);
  const goldBy = new Map(a.gold.map((g) => [g.caseId, g]));
  const scored = a.scores.filter((s) => goldBy.has(s.caseId));
  const goldOpps = scored.flatMap((s) => goldBy.get(s.caseId)!.opportunities);
  const dec: Record<string, number> = { register: 0, tentative: 0, exclude: 0 };
  for (const o of goldOpps) dec[o.decision] = (dec[o.decision] ?? 0) + 1;
  const nonRegister = goldOpps.filter((o) => o.decision !== "register");
  const ms = scored.flatMap((s) => s.matches);
  const nonRegIds = new Set(nonRegister.map((o) => o.oppId));
  const falseReg = ms.filter((m) => m.falseRegister && nonRegIds.has(m.oppId)).length;
  const registerGold = goldOpps.filter((o) => o.decision === "register").length;

  const goldLimits: string[] = [];
  if (nonRegister.length === 0) goldLimits.push("判断のgoldは全件 register で、登録すべきでない・保留すべき例が無い。誤登録（登録すべきでないものを登録）は測定できない（未測定。0%ではない）");
  else if (dec.exclude === 0) goldLimits.push("goldに除外（exclude）の例が無く、正しい除外の再現は測定できない");
  if (registerGold === 0) goldLimits.push("goldに登録すべき例が無く、取りこぼし・誤除外は測定できない");
  goldLimits.push("goldの decision は、応募単位が確定していない機会でも register としている場合がある（運用の登録条件＝応募単位の確定、とは別の定義）");

  // 応募単位: 食い違いの内訳
  const unitAgreement: Record<UnitAgreement, number> = { agree: 0, scope_ambiguous: 0, disagree: 0, unmeasured: 0 };
  for (const s of scored) {
    const g = goldBy.get(s.caseId)!;
    const recs = a.recordsByCase?.get(s.caseId) ?? [];
    for (const m of s.matches) {
      const o = g.opportunities.find((x) => x.oppId === m.oppId);
      const r = recs.find((x) => x.proposalKey === m.proposalKey);
      unitAgreement[classifyUnitAgreement({ ai: r?.applyUnit && r.applyUnit !== "unknown" ? r.applyUnit : null, gold: o?.applyUnit ?? null, goldQuotes: (o?.evidence ?? []).map((e) => e.quote) })]++;
    }
  }

  const matchedOpps = ms.filter((m) => m.proposalKey).length;
  // goldのどの機会にも対応しない register の登録案（goldに無い機会を登録した可能性。gold側の不足か誤登録かは人が確認する）
  let unmatchedRegister = 0;
  for (const s of scored) {
    const used = new Set(s.matches.map((m) => m.proposalKey).filter(Boolean));
    unmatchedRegister += (a.recordsByCase?.get(s.caseId) ?? []).filter((r) => r.decision === "register" && !used.has(r.proposalKey)).length;
  }
  return {
    discovery: [fromRate("oppRecall", "応募機会の発見（再現率）", agg.oppRecall), fromRate("oppPrecision", "登録案の適合率", agg.oppPrecision), fromRate("mismergeCount", "誤統合（件数）", agg.mismergeCount), fromRate("oversplitCount", "誤分割（件数）", agg.oversplitCount)],
    extraction: [
      fromRate("storeAccuracy", "店舗", agg.storeAccuracy),
      fromRate("productAccuracy", "商品", agg.productAccuracy),
      fromRate("deadlineAccuracy", "締切（日付）", agg.deadlineAccuracy),
      fromRate("deadlineTimeAccuracy", "締切（時刻）", agg.deadlineTimeAccuracy, "時刻のgoldが無ければ未測定"),
      fromRate("deadlineYearAccuracy", "締切（年）", agg.deadlineYearAccuracy),
      fromRate("applyUnitAccuracy", "応募単位（旧列挙の一致）", agg.applyUnitAccuracy, "定義が確定するまで暫定。食い違いの内訳は unitAgreement"),
      fromRate("urlAccuracy", "応募先URL", agg.urlAccuracy),
      fromRate("invalidQuoteRate", "無効な引用（観察のみ・旧定義）", agg.invalidQuoteRate),
      fromRate("invalidQuoteAllBasisRate", "無効な引用（全根拠種別）", agg.invalidQuoteAllBasisRate),
    ],
    operation: [
      fromRate("decisionAccuracy", "判断の一致", agg.decisionAccuracy, "goldが全件 register なら、保留・除外の妥当性は測れない"),
      metric("falseRegister", "誤登録（登録すべきでないものを登録）", falseReg, nonRegister.length, "分母は登録すべきでないgold機会。例が無ければ未測定"),
      metric("missedRegister", "取りこぼし（登録すべきものを登録しない）", ms.filter((m) => m.missedRegister).length, registerGold),
      metric("wronglyExcluded", "誤除外（登録すべきものを除外）", ms.filter((m) => m.wronglyExcluded).length, registerGold),
    ],
    goldLimits,
    unitAgreement,
    audit: { goldOpps: goldOpps.length, goldNonRegisterOpps: nonRegister.length, goldDecisionCounts: dec, matchedOpps, unmatchedGoldOpps: goldOpps.length - matchedOpps, unmatchedRegisterProposals: unmatchedRegister, casesScored: scored.length },
  };
}

/** 報告用の1行（未測定は「未測定」と明記し、0%・100%と書かない） */
export function renderMetric(m: LayerMetric): string {
  return m.status === "unmeasured" ? `${m.label}: 未測定（n=0）` : m.k !== null ? `${m.label}: ${m.k}/${m.n} (${((m.value ?? 0) * 100).toFixed(1)}%)` : `${m.label}: ${m.value}`;
}
