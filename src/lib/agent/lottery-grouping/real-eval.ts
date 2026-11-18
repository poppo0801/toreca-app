/**
 * 抽選グループ判定の実データ評価の基盤（Stage 8F-2）。純粋なロジックと、注入された LLM での実行。ここ自体はネットワーク・DB に触れない。
 *
 * 原則:
 *  - 入力（cases）と正解（gold）は別ファイル。入力に正解を混ぜない。正解は AI にも判定ロジックにも渡さない（採点だけが読む）。
 *  - 正解は、AIの実行前に独立した根拠（公式の告知・利用者の手動グループ化・手動の分離）で確定し、根拠なしの正解は認めない。確定できないものは unknown（別集計）。
 *  - 費用: 合計・1ケースの上限を、実行前に（最悪ケースで）検査し、実行中も「残りが1ケースの上限に満たなければ開始しない」で、上限を超えないことを保証する。
 *  - 結果の種類を混ぜない: kind = real（新規の実API）／replay（保存済みの提出を現在の検証層でやり直す）／mock（模擬）。
 *  - APIキー・個人情報は結果に含めない（結果に残るのは判定・使用量・費用・時間だけ）。
 */
import { createHash } from "node:crypto";
import type { AgentLLM, AgentUsage } from "@/lib/agent/core";
import { estimateCostJpy } from "@/lib/ai-cost";
import { GOLD_KEYS, score, worldOf, type Label, type Scenario, type Score } from "@/lib/agent/lottery-grouping/eval-world";
import { isPlausiblePeer } from "@/lib/agent/lottery-grouping/compare";
import { evaluateGrouping, type GroupingOutcome } from "@/lib/agent/lottery-grouping/run";
import { verifyProposal } from "@/lib/agent/lottery-grouping/verify";
import type { AgentProposal } from "@/lib/agent/lottery-grouping/types";
import { RecordingLlm, redact, type StepLog } from "@/lib/agent/lottery-grouping/recorder";
import type { FetchedPage, PageFetcher } from "@/lib/agent/store-location/tools";

export const REAL_EVAL_LIMITS = { totalJpy: 500, perCaseJpy: 15 } as const;

export const CATEGORIES = [
  "multi_store_same", // 同一系列・同一商品・同一期間の複数店舗
  "period_differs", // 同一系列でも応募期間が異なる
  "conditions_differ", // 応募条件が異なる
  "multi_product", // 複数商品を対象とする
  "source_mixed", // X投稿と公式サイトなど、情報源が異なる
  "add_to_group", // 既存グループに新店舗が加わる
  "duplicate_post", // 同じ店舗の重複投稿・再収集
  "insufficient", // 情報不足で判断が難しい
  "manual_separated", // 利用者が手動で分けた組
] as const;
export type Category = (typeof CATEGORIES)[number];

export interface SourceRef {
  url: string;
  fetchedAt: string;
  sha256?: string;
}
export type RealCase = Scenario & { category: Category; capturedAt: string; sources: SourceRef[] };
export type GoldLabel = Label | "unknown";
export interface GoldBasis {
  kind: "official_announcement" | "manual_group" | "manual_separation" | "human_review";
  ref: string;
  checkedAt: string;
}
export interface RealGold {
  label: GoldLabel;
  basis: GoldBasis[];
  note?: string;
}

/** 入力と正解の整合・独立性の検査。問題の一覧を返す（空なら合格） */
export function validateDataset(cases: RealCase[], gold: Record<string, RealGold>): string[] {
  const errs: string[] = [];
  const ids = new Set<string>();
  for (const c of cases) {
    if (ids.has(c.id)) errs.push(`${c.id}: IDが重複しています`);
    ids.add(c.id);
    if (!(CATEGORIES as readonly string[]).includes(c.category)) errs.push(`${c.id}: 分類が不正です（${c.category}）`);
    if (!c.capturedAt) errs.push(`${c.id}: 取得日時がありません`);
    if (!c.sources?.length) errs.push(`${c.id}: 情報源のURLと取得日時がありません`);
    for (const s of c.sources ?? []) if (!/^https?:\/\//.test(s.url) || !s.fetchedAt) errs.push(`${c.id}: 情報源の記録が不正です`);
    const walk = (v: unknown, path: string): void => {
      if (Array.isArray(v)) v.forEach((x, i) => walk(x, `${path}[${i}]`));
      else if (v && typeof v === "object")
        for (const [k, x] of Object.entries(v)) {
          if (GOLD_KEYS.includes(k)) errs.push(`${c.id}: 入力に正解らしきキーがあります（${path}.${k}）`);
          walk(x, `${path}.${k}`);
        }
    };
    walk(c, c.id);
  }
  for (const id of ids) if (!gold[id]) errs.push(`${id}: 正解がありません`);
  for (const [id, g] of Object.entries(gold)) {
    if (!ids.has(id)) errs.push(`${id}: 入力に無い正解です`);
    if (!["auto", "review", "none", "unknown"].includes(g.label)) errs.push(`${id}: 正解のラベルが不正です`);
    if (g.label !== "unknown" && !(g.basis?.length > 0)) errs.push(`${id}: 正解に独立した根拠がありません（確定できないものは unknown にする）`);
    for (const b of g.basis ?? []) if (!b.ref || !b.checkedAt) errs.push(`${id}: 根拠の記録が不完全です`);
  }
  return errs;
}

const sha = (s: string): string => createHash("sha256").update(s.replace(/\r\n/g, "\n")).digest("hex");
/** データセットの凍結用ハッシュ（入力・正解を別々に。実行前に固定し、実行時に照合する） */
export const datasetHashes = (casesText: string, goldText: string): { cases: string; gold: string } => ({ cases: sha(casesText), gold: sha(goldText) });

// ---------------------------------------------------------------- 費用の制御
export class BudgetGuard {
  private spentJpy = 0;
  private started = 0;
  constructor(readonly totalJpy: number = REAL_EVAL_LIMITS.totalJpy, readonly perCaseJpy: number = REAL_EVAL_LIMITS.perCaseJpy) {}
  get spent(): number {
    return this.spentJpy;
  }
  get remaining(): number {
    return Math.max(0, this.totalJpy - this.spentJpy);
  }
  get runs(): number {
    return this.started;
  }
  /** 次のケースを開始してよいか。最悪（1ケースの上限まで使う）でも合計を超えないときだけ */
  canStart(): { ok: true } | { ok: false; reason: string } {
    if (this.remaining < this.perCaseJpy) return { ok: false, reason: `残り予算（${this.remaining.toFixed(1)}円）が1ケースの上限（${this.perCaseJpy}円）に満たないため停止` };
    return { ok: true };
  }
  /** そのケースに許す費用上限（円）。1ケースの上限と残りの小さい方 */
  caseLimit(): number {
    return Math.min(this.perCaseJpy, this.remaining);
  }
  begin(): void {
    this.started += 1;
  }
  record(costJpy: number): void {
    this.spentJpy += Math.max(0, costJpy);
  }
}

/** 実行前の見積もり（接続なし）。想定の使用量は保守的な仮定（トークン数は仮定であり、実測ではない） */
export interface RunPlan {
  caseCount: number;
  /** AIを呼ぶ見込みのケース（比較する相手がいるもの） */
  aiCases: number;
  passes: number;
  maxRuns: number;
  model: string;
  assumedTokensPerRun: { input: number; output: number };
  expectedJpy: number;
  /** 最悪（すべての実行が1ケースの上限まで使う）の合計。ガードにより totalJpy を超えない */
  worstCaseJpy: number;
  guaranteedMaxJpy: number;
  perCaseJpy: number;
  totalJpy: number;
  fitsOnePass: boolean;
  problems: string[];
}
export function planRun(input: { cases: RealCase[]; model: string; stabilityRepeats: number; assumed?: { input: number; output: number }; totalJpy?: number; perCaseJpy?: number }): RunPlan {
  const total = input.totalJpy ?? REAL_EVAL_LIMITS.totalJpy;
  const per = input.perCaseJpy ?? REAL_EVAL_LIMITS.perCaseJpy;
  const assumed = input.assumed ?? { input: 40_000, output: 4_000 }; // 数ステップのツール呼び出し＋追加調査1回を見込む
  const aiCases = input.cases.filter((c) => needsAi(c)).length;
  const passes = 1 + Math.max(0, Math.floor(input.stabilityRepeats));
  const maxRuns = aiCases * passes;
  const one = estimateCostJpy(input.model, assumed.input, assumed.output);
  const problems: string[] = [];
  if (one === null) problems.push(`モデル（${input.model}）の料金が未登録のため、費用を見積もれません`);
  const expected = (one ?? 0) * maxRuns;
  const worst = maxRuns * per;
  if (per > total) problems.push("1ケースの上限が合計の上限を超えています");
  if (aiCases * per > total) problems.push(`最悪ケース（${aiCases}件×${per}円=${aiCases * per}円）が合計上限（${total}円）を超えます。ガードにより途中で停止します`);
  return { caseCount: input.cases.length, aiCases, passes, maxRuns, model: input.model, assumedTokensPerRun: assumed, expectedJpy: Math.round(expected * 100) / 100, worstCaseJpy: worst, guaranteedMaxJpy: Math.min(total, worst), perCaseJpy: per, totalJpy: total, fitsOnePass: aiCases * per <= total, problems };
}

/** AIを呼ぶ必要があるか（事前の絞り込みで比較相手がいなければ呼ばない）。費用見積もりと実行で同じ判定を使う */
export function needsAi(c: RealCase): boolean {
  const w = worldOf(c);
  return w.lotteries.some((l) => isPlausiblePeer(w.subject, l));
}

// ---------------------------------------------------------------- 実行
export interface RunRecord {
  caseId: string;
  pass: number;
  kind: "real" | "replay" | "mock";
  status: "ok" | "error" | "stopped";
  error?: string;
  tier?: string;
  confidence?: number;
  action?: string;
  firstAction?: string;
  firstTier?: string;
  memberIds?: string[];
  mismatches?: string[];
  downgrades?: string[];
  rationale?: string;
  claim?: AgentProposal | null;
  firstClaim?: AgentProposal | null;
  followUps: number;
  /** 追加調査の内訳（format=形式の指摘による再提出／evidence=根拠不足の追加調査） */
  followUpKinds?: string[];
  /** 最終の提出の形式のずれ（補正した項目・却下の理由） */
  parseIssues?: { path: string; code: string; detail: string }[];
  /** 各ステップの記録（停止理由・呼んだツール・提出の生の内容。伏せ字済み） */
  trace?: StepLog[];
  usage?: Pick<AgentUsage, "steps" | "fetches" | "inputTokens" | "outputTokens" | "costJpy" | "ms" | "retries" | "rejectedCalls" | "injectionFlags">;
  score?: Score;
}
export interface RunDeps {
  makeLlm: () => AgentLLM;
  guard: BudgetGuard;
  followUps: number;
  kind: RunRecord["kind"];
  /** 連続して失敗したら止める回数（認証・通信障害での浪費を防ぐ） */
  maxConsecutiveErrors?: number;
  onRecord?: (r: RunRecord) => void;
  /** 情報源の取得部品（保存済みのページの台帳 LedgerFetcher など）。渡すとAIが fetch_source_page で根拠を集められる */
  fetcher?: PageFetcher;
}

const toRecord = (c: RealCase, g: RealGold, pass: number, kind: RunRecord["kind"], o: GroupingOutcome): RunRecord => {
  const verifiedFirst = o.firstClaim ? verifyProposal(worldOf(c), o.firstClaim, { allowAuto: true }) : null;
  return {
    caseId: c.id, pass, kind, status: "ok",
    tier: o.decision.skipReason ? "single" : o.decision.tier, confidence: o.decision.confidence, action: o.claim?.action ?? "none",
    firstAction: o.firstClaim?.action ?? "none", firstTier: verifiedFirst?.tier,
    memberIds: o.decision.lotteryIds, mismatches: o.decision.mismatches.map((m) => `${m.field}:${m.severity}`), downgrades: o.decision.downgrades, rationale: o.decision.rationale.slice(0, 400),
    claim: o.claim, firstClaim: o.firstClaim, followUps: o.followUps.length, followUpKinds: o.followUps.map((f) => f.kind ?? "evidence"), parseIssues: o.parseIssues,
    usage: o.usage ? { steps: o.usage.steps, fetches: o.usage.fetches, inputTokens: o.usage.inputTokens, outputTokens: o.usage.outputTokens, costJpy: o.usage.costJpy, ms: o.usage.ms, retries: o.usage.retries, rejectedCalls: o.usage.rejectedCalls, injectionFlags: o.usage.injectionFlags } : undefined,
    score: g.label === "unknown" ? undefined : score(g.label, o),
  };
};

/** 実行。入力（cases）だけを使い、正解は採点のためにだけ渡す（AIの入力・判定には使わない）。1ケースずつ、予算ガードを通してから開始する */
export async function runCases(cases: RealCase[], gold: Record<string, RealGold>, passes: number, deps: RunDeps): Promise<{ records: RunRecord[]; stoppedBy: "done" | "budget" | "errors"; stopReason: string }> {
  const records: RunRecord[] = [];
  let consecutive = 0;
  for (let pass = 0; pass < passes; pass++) {
    for (const c of cases) {
      if (!needsAi(c)) continue;
      const can = deps.guard.canStart();
      if (!can.ok) return { records, stoppedBy: "budget", stopReason: can.reason };
      deps.guard.begin();
      const world = worldOf(c);
      let rec: RunRecord;
      let recorder: RecordingLlm | null = null;
      try {
        const rl = new RecordingLlm(deps.makeLlm());
        recorder = rl;
        const o = await evaluateGrouping(world, { llm: rl, allowAuto: true, followUps: deps.followUps, fetcher: deps.fetcher, limits: { maxCostJpy: deps.guard.caseLimit() } });
        deps.guard.record(o.usage?.costJpy ?? 0);
        rec = toRecord(c, gold[c.id], pass, deps.kind, o);
        rec.trace = rl.steps;
        // 実行が完了しなかった（API障害・上限）ものは、問題として数える
        consecutive = o.run && o.run.status !== "completed" && o.run.output === undefined ? consecutive + 1 : 0;
        if (consecutive > 0) rec.error = o.run?.stopReason;
      } catch (e) {
        rec = { caseId: c.id, pass, kind: deps.kind, status: "error", error: redact(String((e as Error).message ?? e)).slice(0, 200), followUps: 0, trace: recorder?.steps };
        consecutive += 1;
      }
      records.push(rec);
      deps.onRecord?.(rec);
      if (consecutive >= (deps.maxConsecutiveErrors ?? 2)) return { records, stoppedBy: "errors", stopReason: `連続して${consecutive}件で実行が完了しなかったため停止（${rec.error ?? "不明"}）` };
    }
  }
  return { records, stoppedBy: "done", stopReason: "" };
}

/** 保存済みの提出（claim）を、現在の検証層でやり直す（AI・API なし。kind=replay）。ロジックを変えた後の再判定は新規の精度評価ではない */
export function replayRecords(cases: RealCase[], gold: Record<string, RealGold>, saved: RunRecord[]): RunRecord[] {
  const by = new Map(cases.map((c) => [c.id, c]));
  const out: RunRecord[] = [];
  for (const r of saved) {
    const c = by.get(r.caseId);
    if (!c || r.status !== "ok") continue;
    if (!r.claim && !r.usage) { out.push({ ...r, kind: "replay" }); continue; } // AIを呼ばなかった（比較する相手がいない）ものは、そのまま
    const d = verifyProposal(worldOf(c), r.claim ?? null, { allowAuto: true });
    const o = { decision: d, ranAgent: true, skipped: null, claim: r.claim ?? null, run: null, usage: null, engine: "replay", followUps: [], parseIssues: [], startHash: "", firstClaim: r.firstClaim ?? null } as GroupingOutcome;
    out.push({ ...toRecord(c, gold[c.id], r.pass, "replay", o), usage: r.usage, followUps: r.followUps });
  }
  return out;
}

// ---------------------------------------------------------------- 集計
const rate = (n: number, d: number): number | null => (d === 0 ? null : Math.round((n / d) * 1000) / 1000);
const groupAction = (a: string | undefined): boolean => a === "new_group" || a === "add_to_group";

export interface RealSummary {
  kind: string;
  cases: number;
  unknownCases: number;
  runsScored: number;
  /** AIの提案そのもの（検証前）の正しさ */
  proposal: { shouldGroup: number; groupedCorrectly: number; missed: number; wronglyGrouped: number; mustNotGroup: number; recall: number | null; wrongRate: number | null };
  /** 独立検証を通った結果（実際に起きること） */
  gated: { autoAdopted: number; autoHarm: number; autoHits: number; precisionAuto: number | null; suggest: number; hold: number; single: number; noise: number; reviewHit: number; reviewMissed: number; autoMissed: number; autoToSuggest: number; autoShare: number | null; suggestShare: number | null; holdShare: number | null; singleShare: number | null };
  followUp: { casesWithFollowUp: number; improved: number; worsened: number; improvementRate: number | null };
  cost: { totalJpy: number; perRunJpy: number | null; maxRunJpy: number; perRunMs: number | null; inputTokens: number; outputTokens: number; steps: number };
  stability: { casesRepeated: number; stable: number; rate: number | null; unstableIds: string[] };
  unknownResults: { auto: number; suggest: number; other: number };
  /** 評価から除いたケース（評価側の不具合・データの誤り。AIの誤判定とは別） */
  excluded: Exclusion[];
  /** ケース単位の集計（反復は独立した件数として数えない） */
  caseLevel: { cases: CaseLevel[]; counts: Record<string, Record<string, number>>; independentCases: number };
}
/** 保存済みのページの台帳（実際に取得したページを、取得日時・ハッシュつきで保存したもの）から返す取得部品。評価でネットワークに出ず、同じ入力で再現できる */
export interface LedgerPage {
  url: string;
  finalUrl: string;
  title: string;
  text: string;
  links: string[];
  /** HTML全体から取り出した、同じイベントを示す識別子（取得時に抽出） */
  identifiers?: { kind: string; value: string }[];
  fetchedAt: string;
  hash: string;
}
const normalizeUrl = (u: string): string => u.replace(/#.*$/, "").replace(/\/+$/, "").toLowerCase();
export class LedgerFetcher implements PageFetcher {
  private readonly by = new Map<string, LedgerPage>();
  constructor(pages: LedgerPage[]) {
    for (const p of pages) this.by.set(normalizeUrl(p.url), p);
  }
  async fetchPage(url: string): Promise<FetchedPage> {
    const p = this.by.get(normalizeUrl(url));
    if (!p) return { ok: false, message: "保存済みのページがありません（取得できなかったページ）" };
    return { ok: true, url, finalUrl: p.finalUrl, title: p.title, text: p.text, links: p.links.map((href) => ({ text: "", href })), identifiers: p.identifiers, fetchedAt: p.fetchedAt };
  }
}

/** 評価から除く記録（評価側の不具合・評価データの誤り）。AIの誤判定と区別して報告する。データ・正解は変更しない（別ファイルで管理） */
export interface Exclusion {
  set: string;
  caseId: string;
  kind: "harness_defect" | "data_error";
  reason: string;
}

export interface CaseLevel {
  caseId: string;
  gold: GoldLabel;
  passes: number;
  /** 各回の区分 */
  tiers: string[];
  /** 全回で同じ区分なら、その区分。違えば unstable */
  stable: string;
}
/** ケース単位の集計: 同じケースの反復は独立した成功件数として数えない（ケースを1件として数える） */
export function caseLevelSummary(gold: Record<string, RealGold>, recs: RunRecord[], excluded: Set<string> = new Set()): { cases: CaseLevel[]; counts: Record<string, Record<string, number>> } {
  const by = new Map<string, RunRecord[]>();
  for (const r of recs) if (r.status === "ok" && !excluded.has(r.caseId)) by.set(r.caseId, [...(by.get(r.caseId) ?? []), r]);
  const cases: CaseLevel[] = [...by.entries()].map(([caseId, rs]) => {
    const tiers = rs.sort((a, b) => a.pass - b.pass).map((x) => x.tier ?? "none");
    return { caseId, gold: gold[caseId]?.label ?? "unknown", passes: rs.length, tiers, stable: new Set(tiers).size === 1 ? tiers[0] : "unstable" };
  });
  const counts: Record<string, Record<string, number>> = {};
  for (const c of cases) {
    counts[c.gold] ??= { cases: 0 };
    counts[c.gold].cases += 1;
    counts[c.gold][c.stable] = (counts[c.gold][c.stable] ?? 0) + 1;
  }
  return { cases, counts };
}

const rank: Record<string, number> = { single: 0, hold: 0, suggest: 1, auto: 2 };
export function summarizeRuns(cases: RealCase[], gold: Record<string, RealGold>, allRecs: RunRecord[], exclusions: Exclusion[] = []): RealSummary {
  const excludedIds = new Set(exclusions.map((e) => e.caseId));
  const recs = allRecs.filter((r) => !excludedIds.has(r.caseId));
  const ok = recs.filter((r) => r.status === "ok");
  const known = ok.filter((r) => gold[r.caseId]?.label && gold[r.caseId].label !== "unknown");
  const lab = (r: RunRecord): Label => gold[r.caseId].label as Label;
  const should = known.filter((r) => lab(r) !== "none");
  const never = known.filter((r) => lab(r) === "none");
  const sc = (f: (s: Score) => boolean) => known.filter((r) => r.score && f(r.score)).length;
  const autoAdopted = known.filter((r) => r.tier === "auto").length;
  const autoHits = sc((s) => s.autoHit);
  const labelAuto = known.filter((r) => lab(r) === "auto").length;
  const cnt = (t: string) => known.filter((r) => r.tier === t).length;
  const fu = ok.filter((r) => r.followUps > 0 && r.firstTier !== undefined && r.tier !== undefined);
  const costs = ok.map((r) => r.usage?.costJpy ?? 0);
  const byCase = new Map<string, RunRecord[]>();
  for (const r of ok) byCase.set(r.caseId, [...(byCase.get(r.caseId) ?? []), r]);
  const repeated = [...byCase.entries()].filter(([, v]) => v.length > 1);
  const unstable = repeated.filter(([, v]) => new Set(v.map((x) => `${x.tier}|${[...(x.memberIds ?? [])].sort().join(",")}`)).size > 1).map(([id]) => id);
  const unk = ok.filter((r) => gold[r.caseId]?.label === "unknown");
  void labelAuto;
  return {
    kind: [...new Set(recs.map((r) => r.kind))].join("+") || "none",
    cases: cases.length,
    unknownCases: cases.filter((c) => gold[c.id]?.label === "unknown").length,
    runsScored: known.length,
    proposal: {
      shouldGroup: should.length,
      groupedCorrectly: should.filter((r) => groupAction(r.firstAction ?? r.action)).length,
      missed: should.filter((r) => !groupAction(r.firstAction ?? r.action)).length,
      wronglyGrouped: never.filter((r) => groupAction(r.firstAction ?? r.action)).length,
      mustNotGroup: never.length,
      recall: rate(should.filter((r) => groupAction(r.firstAction ?? r.action)).length, should.length),
      wrongRate: rate(never.filter((r) => groupAction(r.firstAction ?? r.action)).length, never.length),
    },
    gated: {
      autoAdopted, autoHarm: sc((s) => s.autoHarm), autoHits, precisionAuto: rate(autoHits, autoAdopted),
      suggest: cnt("suggest"), hold: cnt("hold"), single: cnt("single"), noise: sc((s) => s.noise), reviewHit: sc((s) => s.reviewHit), reviewMissed: sc((s) => s.reviewMissed), autoMissed: sc((s) => s.autoMissed), autoToSuggest: sc((s) => s.autoToSuggest),
      autoShare: rate(autoAdopted, known.length), suggestShare: rate(cnt("suggest"), known.length), holdShare: rate(cnt("hold"), known.length), singleShare: rate(cnt("single"), known.length),
    },
    followUp: {
      casesWithFollowUp: fu.length,
      improved: fu.filter((r) => rank[r.tier!] > rank[r.firstTier!]).length,
      worsened: fu.filter((r) => rank[r.tier!] < rank[r.firstTier!]).length,
      improvementRate: rate(fu.filter((r) => rank[r.tier!] > rank[r.firstTier!]).length, fu.length),
    },
    cost: { totalJpy: Math.round(costs.reduce((a, b) => a + b, 0) * 100) / 100, perRunJpy: ok.length ? Math.round((costs.reduce((a, b) => a + b, 0) / ok.length) * 1000) / 1000 : null, maxRunJpy: Math.max(0, ...costs), perRunMs: ok.length ? Math.round(ok.reduce((a, r) => a + (r.usage?.ms ?? 0), 0) / ok.length) : null, inputTokens: ok.reduce((a, r) => a + (r.usage?.inputTokens ?? 0), 0), outputTokens: ok.reduce((a, r) => a + (r.usage?.outputTokens ?? 0), 0), steps: ok.reduce((a, r) => a + (r.usage?.steps ?? 0), 0) },
    stability: { casesRepeated: repeated.length, stable: repeated.length - unstable.length, rate: rate(repeated.length - unstable.length, repeated.length), unstableIds: unstable },
    unknownResults: { auto: unk.filter((r) => r.tier === "auto").length, suggest: unk.filter((r) => r.tier === "suggest").length, other: unk.filter((r) => r.tier !== "auto" && r.tier !== "suggest").length },
    excluded: exclusions,
    caseLevel: (() => { const cl = caseLevelSummary(gold, recs, excludedIds); return { ...cl, independentCases: cl.cases.length }; })(),
  };
}

/** 誤判定・見逃しの原因の分類（人が記入。集計のための語彙を固定する） */
export const CAUSES = ["ai_understanding", "source_missing_or_conflict", "chain_store_identification", "product_period_interpretation", "existing_lottery_matching", "verification_too_strict", "verification_too_loose"] as const;
