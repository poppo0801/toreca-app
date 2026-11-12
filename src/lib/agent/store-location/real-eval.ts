/**
 * 実在店舗での実API評価（Stage 8D-3）。**費用が発生する。ユーザーの承認（件数・費用の上限）なしには実行しない。**
 * 入力は eval/real-stores/targets.json（店舗マスターの凍結した断面）、正解は gold.json（採点だけが読む。システムには渡さない）。
 * モックの評価（eval.ts）とは別に集計し、結果は eval/runs/real/ に書く（Git管理外）。APIキーは出力・保存しない。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { DEFAULT_LIMITS, type AgentLimits } from "@/lib/agent/core";
import { checkRealApi } from "@/lib/agent/real-gate";
import { type EvalGold, type EvalResult, scoreEval, type EvalScore } from "@/lib/agent/store-location/eval";
import { researchStoreLocation, type ResearchDeps, type ResearchOutcome } from "@/lib/agent/store-location/run";
import type { ResultCache } from "@/lib/agent/store-location/tools";
import type { StoreTarget } from "@/lib/agent/store-location/verify";
import goldJson from "../../../../eval/real-stores/gold.json";
import targetsJson from "../../../../eval/real-stores/targets.json";
import gold8d4 from "../../../../eval/real-stores/gold-8d4.json";
import targets8d4 from "../../../../eval/real-stores/targets-8d4.json";

export interface RealTarget {
  id: string;
  category: string;
  store: StoreTarget;
}
export type RealGold = EvalGold & { evidence?: unknown[]; unknown?: string[]; /** 正解不明。正解率の分母に含めず、調査結果と確認状況を別に報告する */ unknownGold?: boolean };
/** Stage 8D-3（R1〜R5）と Stage 8D-4（N01〜N20・U01〜U10）。ID で区別する */
export const REAL_TARGETS = [...(targetsJson.targets as unknown as RealTarget[]), ...(targets8d4.targets as unknown as RealTarget[])];
export const REAL_GOLD = [...(goldJson.gold as unknown as RealGold[]), ...(gold8d4.gold as unknown as RealGold[])];

// ---------------------------------------------------------------- 費用の見積もり（実行前の報告用）
export interface CostEstimate {
  perStoreTypicalJpy: number;
  perStoreCapJpy: number;
  stores: number;
  totalTypicalJpy: number;
  /** 上限（1店舗の費用上限×件数）。推定値で、請求額を保証しない（1ステップ分は超えうる） */
  totalCapJpy: number;
  assumptions: string[];
}
/** Haiku 5.5 の料金（入力 $0.10 / 出力 $0.50 per MTok）と Web検索 $10/1000回、1ドル=150円での概算 */
export function estimateRealCost(stores: number, limits: AgentLimits = DEFAULT_LIMITS): CostEstimate {
  const usdJpy = 150;
  const tokenJpy = (inTok: number, outTok: number) => ((inTok * 0.1 + outTok * 0.5) / 1_000_000) * usdJpy;
  const searchFee = 0.01 * usdJpy; // 1.5円
  const typicalSearches = 3;
  const searchCall = searchFee + tokenJpy(8_000, 600);
  const agent = tokenJpy(10 * 12_000, 10 * 600); // 約10ステップ、平均の入力12K（会話が増えるため）、出力600（思考を含む）
  const typical = typicalSearches * searchCall + agent;
  const cap = limits.maxCostJpy;
  return {
    perStoreTypicalJpy: Math.round(typical * 10) / 10,
    perStoreCapJpy: cap,
    stores,
    totalTypicalJpy: Math.round(typical * stores * 10) / 10,
    totalCapJpy: cap * stores,
    assumptions: [
      "モデル claude-haiku-5-5（入力 $0.10 / 出力 $0.50 per MTok、プロンプト10万トークン以下）",
      "Web検索 $10 / 1,000回（1回約1.5円。エラーの検索は課金されない）。1店舗あたり検索3回前後を想定（上限4回）",
      "AIの約10ステップ（会話が増えるため平均の入力約12,000トークン、出力約600トークン）。検索ごとの問い合わせは入力約8,000トークンと想定",
      "1ドル=150円の概算。実測は未実施のため、典型値は目安（実際は数倍ずれうる）。上限（キャップ）は実行時に強制するが、請求額の厳密な保証ではない",
    ],
  };
}

// ---------------------------------------------------------------- 結果の保存・キャッシュ（ファイル）
export class FileCache implements ResultCache {
  private data: Record<string, { at: number; v: unknown }> = {};
  constructor(private readonly path: string, private readonly ttlMs = 24 * 3600_000, private readonly now: () => number = Date.now) {
    if (existsSync(path)) {
      try {
        this.data = JSON.parse(readFileSync(path, "utf8"));
      } catch {
        this.data = {};
      }
    }
  }
  get(key: string): unknown | undefined {
    const e = this.data[key];
    return e && this.now() - e.at <= this.ttlMs ? e.v : undefined;
  }
  set(key: string, value: unknown): void {
    this.data[key] = { at: this.now(), v: value };
    mkdirSync(this.path.replace(/[\\/][^\\/]*$/, ""), { recursive: true });
    writeFileSync(this.path, JSON.stringify(this.data));
  }
}

// ---------------------------------------------------------------- 実行計画（承認の範囲）
export interface RealEvalPlan {
  ids: string[];
  /** 承認された総費用の上限（円）。これを超える可能性がある実行はしない */
  approvedMaxJpy: number;
  /** 承認された件数 */
  approvedStores: number;
  /** 最初の1店舗だけで止める */
  firstOnly: boolean;
  /** 初回の実行か、修正後の再実行か（集計を分けるための記録。初回の結果が主要評価値） */
  phase?: "initial" | "rerun";
  /** 誤住所などの問題があっても続ける（API障害・ツールの不正使用・費用超過では必ず止まる）。問題が maxProblems 件に達したら止まる */
  continueOnProblem?: boolean;
  maxProblems?: number;
}

export function validatePlan(plan: RealEvalPlan, limits: AgentLimits = DEFAULT_LIMITS): string | null {
  if (!(plan.approvedMaxJpy > 0) || !(plan.approvedStores > 0)) return "承認された費用の上限と件数が必要です（REAL_EVAL_APPROVED_MAX_JPY・REAL_EVAL_APPROVED_STORES）";
  if (plan.ids.length === 0) return "対象の店舗がありません";
  if (plan.ids.length > plan.approvedStores) return `承認された件数（${plan.approvedStores}）を超えています`;
  const unknown = plan.ids.filter((id) => !REAL_TARGETS.some((t) => t.id === id));
  if (unknown.length) return `未知の店舗ID: ${unknown.join(", ")}`;
  const n = plan.firstOnly ? 1 : plan.ids.length;
  if (limits.maxCostJpy * n > plan.approvedMaxJpy) return `1店舗の費用上限（${limits.maxCostJpy}円）×${n}件が、承認された総費用（${plan.approvedMaxJpy}円）を超えています`;
  return null;
}

/** 最初の店舗で問題があれば、残りを止める（誤住所の採用・確認済みの誤り・ツールの不正使用・費用超過・実行失敗） */
/** 続行できない問題（API障害・ツールの不正使用・費用超過）。これが起きたら常に止める */
export function isFatalProblem(r: { status: string; rejectedCalls: number; costJpy: number }, capJpy: number): string | null {
  if (r.status === "failed") return "調査が失敗した（API障害・実行エラー）";
  if (r.rejectedCalls > 0) return "登録されていないツールを呼び出そうとした";
  if (r.costJpy > capJpy * 1.2) return "推定費用が上限を大きく超えた";
  return null;
}
export function isProblem(r: { status: string; wrong: boolean; rejectedCalls: number; costJpy: number }, capJpy: number): string | null {
  if (r.status === "failed") return "調査が失敗した（API障害・実行エラー）";
  if (r.wrong) return "誤った住所を採用した";
  if (r.rejectedCalls > 0) return "登録されていないツールを呼び出そうとした";
  if (r.costJpy > capJpy * 1.2) return "推定費用が上限を大きく超えた";
  return null;
}

export interface RealRecord {
  target: RealTarget;
  result: EvalResult;
  outcome: { status: string; address: string | null; confidence: number; reasons: string[]; officialSites: { domain: string; status: string; signals: string[]; problems: string[] }[]; sources: { url: string; official: boolean }[]; candidates?: { address: string; sourceUrl: string; quote: string; closureHint?: string | null; problems: string[] }[] };
  usage: ResearchOutcome["usage"];
  /** ツール呼び出しの経過（名前・成否・入力の検索語/URL。本文は保存しない） */
  actions: { name: string; ok: boolean; arg: string }[];
  engine: string;
  problem: string | null;
}
export interface UnknownGoldRow {
  id: string;
  store: string;
  status: string;
  address: string | null;
  confidence: number;
  /** 公式（trusted/verified）と判定したドメイン */
  officialDomains: string[];
  sources: string[];
  reasons: string[];
}
export interface RealRunReport {
  runId: string;
  startedAt: string;
  phase: "initial" | "rerun";
  plan: RealEvalPlan;
  /** 正解不明の店舗: 正解率の分母に含めず、調査結果と確認状況だけを記録する */
  unknown: UnknownGoldRow[];
  records: RealRecord[];
  stoppedReason: string | null;
  spentJpy: number;
  score: EvalScore | null;
}

/** 実在店舗を1件ずつ実行する。1件ごとに結果を保存（途中で失敗しても履歴が残る）。承認範囲を超えない */
export async function runRealEval(plan: RealEvalPlan, makeDeps: (t: RealTarget) => ResearchDeps, opts: { limits?: AgentLimits; outDir?: string; onRecord?: (r: RealRecord) => void; /** 本日あと何回まで実行できるか（1日の上限）。超える実行はしない */ remainingRuns?: number } = {}): Promise<RealRunReport> {
  const limits = opts.limits ?? DEFAULT_LIMITS;
  const bad = validatePlan(plan, limits);
  if (bad) throw new Error(bad);
  const outDir = opts.outDir ?? "eval/runs/real";
  mkdirSync(outDir, { recursive: true });
  const runId = new Date().toISOString().replace(/[:.]/g, "-");
  const report: RealRunReport = { runId, startedAt: new Date().toISOString(), phase: plan.phase ?? "initial", plan, unknown: [], records: [], stoppedReason: null, spentJpy: 0, score: null };
  let problems = 0;
  const save = () => writeFileSync(`${outDir}/real-${runId}.json`, JSON.stringify(report, null, 2));
  const ids = plan.firstOnly ? plan.ids.slice(0, 1) : plan.ids;

  for (const id of ids) {
    const target = REAL_TARGETS.find((t) => t.id === id)!;
    if (report.spentJpy + limits.maxCostJpy > plan.approvedMaxJpy) {
      report.stoppedReason = `承認された総費用（${plan.approvedMaxJpy}円）を超える可能性があるため、${id} 以降は実行しない`;
      break;
    }
    if (opts.remainingRuns !== undefined && report.records.length >= opts.remainingRuns) {
      report.stoppedReason = `本日の実行回数の上限に達したため、${id} 以降は実行しない`;
      break;
    }
    const t0 = Date.now();
    const out = await researchStoreLocation(target.store, null, { ...makeDeps(target), limits });
    const gold = REAL_GOLD.find((g) => g.id === id)!;
    const one = scoreEval("real", [toEvalResult(id, out, Date.now() - t0)], [gold]);
    const unknownGold = !!gold.unknownGold;
    const fatal = isFatalProblem({ status: out.result.status, rejectedCalls: out.usage.rejectedCalls, costJpy: out.usage.costJpy }, limits.maxCostJpy);
    const problem = fatal ?? (unknownGold ? null : isProblem({ status: out.result.status, wrong: one.perCase[0].wrong, rejectedCalls: out.usage.rejectedCalls, costJpy: out.usage.costJpy }, limits.maxCostJpy));
    const rec: RealRecord = {
      target,
      result: toEvalResult(id, out, Date.now() - t0),
      outcome: {
        status: out.result.status, address: out.result.address, confidence: out.result.confidence, reasons: out.result.reasons,
        officialSites: out.result.officialSites.map((o) => ({ domain: o.domain, status: o.status, signals: o.signals, problems: o.problems })),
        sources: out.result.sources.map((s) => ({ url: s.url, official: s.official })),
        // 採用されなかった候補も記録する（原因調査用。AIが提案した住所・引用・検証で見つかった問題）
        candidates: out.result.candidates.map((c) => ({ address: c.address, sourceUrl: c.sourceUrl, quote: c.quote.slice(0, 200), closureHint: c.closureHint ?? null, problems: c.problems })),
      },
      usage: out.usage,
      actions: out.run.trace.flatMap((e) => (e.t === "tool" ? [{ name: e.name, ok: e.ok, arg: String(e.input.query ?? e.input.url ?? "").slice(0, 120) }] : [])),
      engine: out.engine,
      problem,
    };
    report.records.push(rec);
    report.spentJpy += out.usage.costJpy;
    opts.onRecord?.(rec);
    save(); // 1件ごとに保存
    if (problem) {
      problems++;
      if (fatal || !plan.continueOnProblem || problems >= (plan.maxProblems ?? 3)) {
        report.stoppedReason = `${id} で問題があったため、残りの実行を停止した: ${problem}`;
        break;
      }
    }
  }
  const knownGold = REAL_GOLD.filter((g) => !g.unknownGold && report.records.some((r) => r.target.id === g.id));
  report.score = knownGold.length ? scoreEval("real-agent", report.records.map((r) => r.result), knownGold) : null;
  report.unknown = report.records
    .filter((r) => REAL_GOLD.find((g) => g.id === r.target.id)?.unknownGold)
    .map((r) => ({ id: r.target.id, store: `${r.target.store.chain} ${r.target.store.name}`, status: r.outcome.status, address: r.outcome.address, confidence: r.outcome.confidence, officialDomains: r.outcome.officialSites.filter((o) => o.status === "verified" || o.status === "trusted").map((o) => o.domain), sources: r.outcome.sources.map((x) => x.url), reasons: r.outcome.reasons }));
  save();
  return report;
}

function toEvalResult(id: string, out: ResearchOutcome, ms: number): EvalResult {
  const u = out.usage;
  return {
    caseId: id, status: out.result.status, address: out.result.address, confidence: out.result.confidence, searches: u.searches, fetches: u.fetches, steps: u.steps,
    costJpy: Math.round(u.costJpy * 100) / 100, ms, injectionFlags: u.injectionFlags, officialSites: out.result.officialSites.map((o) => ({ domain: o.domain, status: o.status })),
  };
}

/** 実行前の確認（API・ネットワークには接続しない）: 関門の判定（理由のみ。キーは出さない）・計画・費用の見積もり */
export function preflight(env: Record<string, string | undefined>, ids: string[]) {
  const gate = checkRealApi({ env, confirm: true, runsToday: 0 });
  const plan: RealEvalPlan = { ids, approvedMaxJpy: Number(env.REAL_EVAL_APPROVED_MAX_JPY) || 0, approvedStores: Number(env.REAL_EVAL_APPROVED_STORES) || 0, firstOnly: env.REAL_EVAL_FIRST_ONLY === "1" };
  const limits = gate.ok ? gate.limits : DEFAULT_LIMITS;
  return {
    gate: gate.ok ? { ok: true as const, model: gate.model, limits: gate.limits } : { ok: false as const, reason: gate.reason },
    plan,
    planProblem: validatePlan(plan, limits),
    estimate: estimateRealCost(plan.firstOnly ? 1 : ids.length, limits),
    targets: ids.map((id) => ({ id, store: REAL_TARGETS.find((t) => t.id === id)?.store.chain + " " + REAL_TARGETS.find((t) => t.id === id)?.store.name })),
  };
}
