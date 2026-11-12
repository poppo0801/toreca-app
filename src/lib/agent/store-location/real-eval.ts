/**
 * 実在店舗での実API評価（Stage 8D-3）。**費用が発生する。ユーザーの承認（件数・費用の上限）なしには実行しない。**
 * 入力は eval/real-stores/targets.json（店舗マスターの凍結した断面）、正解は gold.json（採点だけが読む。システムには渡さない）。
 * モックの評価（eval.ts）とは別に集計し、結果は eval/runs/real/ に書く（Git管理外）。APIキーは出力・保存しない。
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { DEFAULT_LIMITS, type AgentLimits } from "@/lib/agent/core";
import { checkRealApi } from "@/lib/agent/real-gate";
import { type EvalGold, type EvalResult, matchesGold, matchesGoldV1, scoreEval, type EvalScore } from "@/lib/agent/store-location/eval";
import { researchStoreLocation, type ResearchDeps, type ResearchOutcome } from "@/lib/agent/store-location/run";
import { ledgerEntriesFromTrace, RunLedgerWriter } from "@/lib/agent/store-location/evidence-store";
import type { RoundRecord } from "@/lib/agent/store-location/followup";
import type { ResultCache } from "@/lib/agent/store-location/tools";
import type { StoreTarget } from "@/lib/agent/store-location/verify";
import goldJson from "../../../../eval/real-stores/gold.json";
import targetsJson from "../../../../eval/real-stores/targets.json";
import gold8d4 from "../../../../eval/real-stores/gold-8d4.json";
import targets8d4 from "../../../../eval/real-stores/targets-8d4.json";
import gold8d5 from "../../../../eval/real-stores/gold-8d5.json";
import targets8d5 from "../../../../eval/real-stores/targets-8d5.json";
import gold8d6 from "../../../../eval/real-stores/gold-8d6.json";
import targets8d6 from "../../../../eval/real-stores/targets-8d6.json";

export interface RealTarget {
  id: string;
  category: string;
  store: StoreTarget;
}
export type RealGold = EvalGold & { evidence?: unknown[]; unknown?: string[]; /** 正解不明。正解率の分母に含めず、調査結果と確認状況を別に報告する */ unknownGold?: boolean };
/** Stage 8D-3（R1〜R5）・8D-4（N01〜N20・U01〜U10）・8D-5（P01〜P20・Q01〜Q10）・8D-6（T01〜T20・W01〜W10）。ID で区別する */
export const REAL_TARGETS = [...(targetsJson.targets as unknown as RealTarget[]), ...(targets8d4.targets as unknown as RealTarget[]), ...(targets8d5.targets as unknown as RealTarget[]), ...(targets8d6.targets as unknown as RealTarget[])];
export const REAL_GOLD = [...(goldJson.gold as unknown as RealGold[]), ...(gold8d4.gold as unknown as RealGold[]), ...(gold8d5.gold as unknown as RealGold[]), ...(gold8d6.gold as unknown as RealGold[])];

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
  /** 検証結果を受けた再調査の最大回数（既定 0）。再調査も1店舗の費用・時間・検索・取得の上限の中で行う（上限は増えない）。Stage 8D-6 */
  followUps?: number;
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
export function isFatalProblem(r: { status: string; rejectedCalls: number; costJpy: number; /** 実行の途中でAPI障害・実行エラーが起きた（再調査の途中を含む） */ runError?: boolean }, capJpy: number): string | null {
  if (r.status === "failed" || r.runError) return "調査が失敗した（API障害・実行エラー）";
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
  /** AIが提出した候補（提出ごと。引用は全文）。検証をやり直す（replay）ときの入力。AIの出力そのもの */
  proposals?: { address: string; sourceUrl: string; quote: string; closureHint?: string | null }[][];
  /** 提出ごとの検証と再調査の記録（0番目＝最初の提出。再調査しない実行では空または1件） */
  rounds?: RoundRecord[];
  /** 実行の終了状態（completed / limit_reached / error）と終了の理由 */
  runStatus?: string;
  stopReason?: string;
}
/** 実行ID（時刻。ファイル名にそのまま使える） */
export const newRunId = (): string => new Date().toISOString().replace(/[:.]/g, "-");
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
  /** 取得したページの台帳（pages-<実行ID>.jsonl）のファイル名。実行ごとに分離。再判定の証拠はこれだけを使う */
  ledgerFile?: string;
  records: RealRecord[];
  stoppedReason: string | null;
  spentJpy: number;
  score: EvalScore | null;
}

/** 実在店舗を1件ずつ実行する。1件ごとに結果を保存（途中で失敗しても履歴が残る）。承認範囲を超えない */
export async function runRealEval(plan: RealEvalPlan, makeDeps: (t: RealTarget) => ResearchDeps, opts: { limits?: AgentLimits; outDir?: string; onRecord?: (r: RealRecord) => void; /** 本日あと何回まで実行できるか（1日の上限）。超える実行はしない */ remainingRuns?: number; /** 実行ID（指定すると、その実行専用のキャッシュと台帳を呼び出し側が用意できる）。既存の実行と重複したら失敗する */ runId?: string } = {}): Promise<RealRunReport> {
  const limits = opts.limits ?? DEFAULT_LIMITS;
  const bad = validatePlan(plan, limits);
  if (bad) throw new Error(bad);
  const outDir = opts.outDir ?? "eval/runs/real";
  mkdirSync(outDir, { recursive: true });
  const runId = opts.runId ?? newRunId();
  if (existsSync(`${outDir}/real-${runId}.json`)) throw new Error("同じ実行IDの結果が既にあります（過去の結果を上書きしません）");
  const startedAt = new Date().toISOString();
  // 取得したページの台帳（実行ごとに新規作成。既存のファイルは上書きしない）
  const ledger = new RunLedgerWriter(outDir, runId, startedAt);
  const report: RealRunReport = { runId, startedAt, phase: plan.phase ?? "initial", plan, unknown: [], ledgerFile: ledger.path.replace(/^.*[\/]/, ""), records: [], stoppedReason: null, spentJpy: 0, score: null };
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
    const out = await researchStoreLocation(target.store, null, { ...makeDeps(target), limits, followUps: plan.followUps ?? 0 });
    ledger.append(ledgerEntriesFromTrace(runId, id, out.run.trace));
    const gold = REAL_GOLD.find((g) => g.id === id)!;
    const one = scoreEval("real", [toEvalResult(id, out, Date.now() - t0)], [gold]);
    const unknownGold = !!gold.unknownGold;
    // 誤った住所を「確認済み」にした（最重要の安全指標）: 継続指定でも即停止して、原因を調べる（Stage 8D-5）
    const wrongConfirmed = !unknownGold && out.result.status === "confirmed" && one.perCase[0].wrong;
    const fatal = isFatalProblem({ status: out.result.status, rejectedCalls: out.usage.rejectedCalls, costJpy: out.usage.costJpy, runError: out.run.status === "error" }, limits.maxCostJpy) ?? (wrongConfirmed ? "誤った住所を確認済みにした（重大な安全上の問題）" : null);
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
      // ツール呼び出し・重複して断った呼び出し・検証結果を受けた再調査の依頼（review）を、起きた順に記録する
      actions: out.run.trace.flatMap((e) => (e.t === "tool" ? [{ name: e.name, ok: e.ok, arg: String(e.input.query ?? e.input.url ?? "").slice(0, 120) }] : e.t === "duplicate" ? [{ name: "duplicate", ok: false, arg: e.name }] : e.t === "review" ? [{ name: "review", ok: true, arg: String((e.meta as { gaps?: string[] } | undefined)?.gaps?.join(",") ?? "") }] : [])),
      engine: out.engine,
      problem,
      proposals: out.submissions,
      rounds: out.rounds,
      runStatus: out.run.status,
      stopReason: out.run.stopReason,
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

// ---------------------------------------------------------------- 集計（Stage 8D-4）: 初回の実行を主要評価値とし、再実行は別集計
export interface StoreMetric {
  id: string;
  store: string;
  category: string;
  /** 正解あり（true）／正解不明（false） */
  known: boolean;
  status: string;
  address: string | null;
  confidence: number;
  /** 正解ありのとき: 正しい住所を採用したか（確認済み・候補）。正解不明は null */
  correct: boolean | null;
  /** 正解ありのとき: 誤った住所を採用したか */
  wrongAdopted: boolean | null;
  wrongConfirmed: boolean | null;
  /** 正解ありのとき: 公式サイトを（trusted/verified と）判定できたか。公式ドメインの正解が無ければ null */
  officialFound: boolean | null;
  wrongOfficial: boolean;
  /** 自律的な追加調査（最初の取得のあとに検索した／検索3回以上）をしたか */
  additionalSearch: boolean;
  searches: number;
  fetches: number;
  steps: number;
  inputTokens: number;
  outputTokens: number;
  costJpy: number;
  ms: number;
  humanReview: boolean;
  problem: string | null;
  /** 自律性（調査の経過から機械的に判定。検索回数を増やすこと自体は評価しない） */
  autonomy: Autonomy;
}
export interface Autonomy {
  /** 別の検索語で検索し直した（最初の検索で足りないとき別の方法を選べた） */
  reformulated: boolean;
  /** 同じ検索語を繰り返した（無駄な再検索。少ないほどよい） */
  duplicateSearch: boolean;
  /** 複数のサイトを調べた（公式情報が不十分なとき、別の情報源を追加できた） */
  addedSource: boolean;
  /** 異なる住所が見つかったあとも調査を続けた（矛盾の発見後の継続） */
  conflictContinued: boolean;
  /** 確認済みの根拠が揃い、上限に達する前に終了した（無駄な検索の打ち切り） */
  earlyStop: boolean;
  /** 根拠が不十分で確認済みにせず、候補・保留にとどめた（安全な保留） */
  safeHold: boolean;
}
export interface RunSummary {
  stores: number;
  known: {
    n: number;
    correctRate: number | null;
    confirmedSuccessRate: number | null;
    wrongAdopted: number;
    wrongConfirmed: number;
    officialFound: number;
    officialTargets: number;
    wrongOfficial: number;
    humanReviewRate: number | null;
    additionalSearchRate: number | null;
  };
  autonomy: { stores: number; reformulatedRate: number | null; duplicateSearchRate: number | null; addedSourceRate: number | null; conflictContinuedCount: number; earlyStopRate: number | null; safeHoldRate: number | null };
  unknown: { n: number; confirmed: number; candidate: number; other: number; officialVerified: number };
  totals: { costJpy: number; avgCostJpy: number; searches: number; ms: number; avgMs: number; p50Ms: number; p95Ms: number; inputTokens: number; outputTokens: number };
  perStore: StoreMetric[];
}
const rate = (a: number, b: number) => (b === 0 ? null : a / b);
const pct = (xs: number[], q: number) => (xs.length ? [...xs].sort((a, b) => a - b)[Math.min(xs.length - 1, Math.floor(q * xs.length))] : 0);

const SEARCH_LIMIT = 4;
const FETCH_LIMIT = 6;
/** 調査の経過（ツール呼び出しの順序・検索語・取得先）から、自律的な調査行動を判定する */
export function autonomyOf(r: RealRecord): Autonomy {
  const searches = r.actions.filter((a) => a.name === "web_search").map((a) => a.arg.trim());
  const hosts = new Set(r.actions.filter((a) => a.name === "fetch_page").map((a) => { try { return new URL(a.arg).hostname.replace(/^www\./, ""); } catch { return a.arg; } }));
  const addrs = new Set((r.outcome.candidates ?? []).map((c) => c.address.replace(/[ 　]+/g, "")));
  const status = r.outcome.status;
  return {
    reformulated: searches.length >= 2 && new Set(searches).size >= 2,
    duplicateSearch: searches.length !== new Set(searches).size,
    addedSource: hosts.size >= 2,
    conflictContinued: (status === "conflict" || addrs.size >= 2) && r.usage.searches + r.usage.fetches >= 3,
    earlyStop: status === "confirmed" && r.usage.searches < SEARCH_LIMIT && r.usage.fetches < FETCH_LIMIT,
    safeHold: status !== "confirmed",
  };
}

export function summarizeRecords(records: RealRecord[], scorer: typeof matchesGold = matchesGold): RunSummary {
  const perStore: StoreMetric[] = records.map((r) => {
    const g = REAL_GOLD.find((x) => x.id === r.target.id);
    const known = !!g && !g.unknownGold;
    const adopted = (r.outcome.status === "confirmed" || r.outcome.status === "candidate") && !!r.outcome.address;
    const correct = known && g ? adopted && scorer(r.outcome.address, g) : null;
    const isOff = (d: string) => r.outcome.officialSites.some((o) => o.domain === d && (o.status === "verified" || o.status === "trusted"));
    const offDomains = known && g ? g.officialDomains ?? [] : [];
    const a = r.actions;
    const firstFetch = a.findIndex((x) => x.name === "fetch_page");
    return {
      id: r.target.id,
      store: `${r.target.store.chain} ${r.target.store.name}`,
      category: r.target.category,
      known,
      status: r.outcome.status,
      address: r.outcome.address,
      confidence: r.outcome.confidence,
      correct,
      wrongAdopted: known ? adopted && correct === false : null,
      wrongConfirmed: known ? r.outcome.status === "confirmed" && correct === false : null,
      officialFound: known && offDomains.length ? offDomains.some(isOff) : null,
      wrongOfficial: known && g ? (g.notOfficialDomains ?? []).some(isOff) : false,
      additionalSearch: r.usage.searches >= 3 || (firstFetch >= 0 && a.slice(firstFetch).some((x) => x.name === "web_search")),
      searches: r.usage.searches,
      fetches: r.usage.fetches,
      steps: r.usage.steps,
      inputTokens: r.usage.inputTokens,
      outputTokens: r.usage.outputTokens,
      costJpy: r.usage.costJpy,
      ms: r.usage.ms,
      humanReview: r.outcome.status !== "confirmed",
      problem: r.problem,
      autonomy: autonomyOf(r),
    };
  });
  const k = perStore.filter((s) => s.known);
  const u = perStore.filter((s) => !s.known);
  const offT = k.filter((s) => s.officialFound !== null);
  const ms = perStore.map((s) => s.ms);
  const cost = perStore.reduce((t, s) => t + s.costJpy, 0);
  return {
    stores: perStore.length,
    known: {
      n: k.length,
      correctRate: rate(k.filter((s) => s.correct).length, k.length),
      confirmedSuccessRate: rate(k.filter((s) => s.status === "confirmed" && s.correct).length, k.length),
      wrongAdopted: k.filter((s) => s.wrongAdopted).length,
      wrongConfirmed: k.filter((s) => s.wrongConfirmed).length,
      officialFound: offT.filter((s) => s.officialFound).length,
      officialTargets: offT.length,
      wrongOfficial: k.filter((s) => s.wrongOfficial).length,
      humanReviewRate: rate(k.filter((s) => s.humanReview).length, k.length),
      additionalSearchRate: rate(k.filter((s) => s.additionalSearch).length, k.length),
    },
    autonomy: (() => {
      const a = perStore.map((p) => p.autonomy);
      const held = perStore.filter((p) => p.status !== "confirmed");
      return {
        stores: perStore.length,
        reformulatedRate: rate(a.filter((x) => x.reformulated).length, a.length),
        duplicateSearchRate: rate(a.filter((x) => x.duplicateSearch).length, a.length),
        addedSourceRate: rate(a.filter((x) => x.addedSource).length, a.length),
        conflictContinuedCount: a.filter((x) => x.conflictContinued).length,
        earlyStopRate: rate(perStore.filter((p) => p.status === "confirmed" && p.autonomy.earlyStop).length, perStore.filter((p) => p.status === "confirmed").length),
        safeHoldRate: rate(held.filter((p) => p.autonomy.safeHold && p.wrongAdopted !== true).length, held.length),
      };
    })(),
    unknown: { n: u.length, confirmed: u.filter((s) => s.status === "confirmed").length, candidate: u.filter((s) => s.status === "candidate").length, other: u.filter((s) => s.status !== "confirmed" && s.status !== "candidate").length, officialVerified: u.filter((s) => records.find((r) => r.target.id === s.id)?.outcome.officialSites.some((o) => o.status === "verified" || o.status === "trusted")).length },
    totals: {
      costJpy: Math.round(cost * 100) / 100,
      avgCostJpy: perStore.length ? Math.round((cost / perStore.length) * 100) / 100 : 0,
      searches: perStore.reduce((t, s) => t + s.searches, 0),
      ms: Math.round(ms.reduce((t, x) => t + x, 0)),
      avgMs: ms.length ? Math.round(ms.reduce((t, x) => t + x, 0) / ms.length) : 0,
      p50Ms: Math.round(pct(ms, 0.5)),
      p95Ms: Math.round(pct(ms, 0.95)),
      inputTokens: perStore.reduce((t, s) => t + s.inputTokens, 0),
      outputTokens: perStore.reduce((t, s) => t + s.outputTokens, 0),
    },
    perStore,
  };
}

/** eval/runs/real/ の実行結果から、指定した phase の各店舗の「最初の実行」を集める（初回の集計＝主要評価値。再実行は別に集計） */
export function collectRecords(dir: string, phase: "initial" | "rerun", idFilter: (id: string) => boolean): RealRecord[] {
  const out = new Map<string, RealRecord>();
  const files = existsSync(dir) ? readdirSync(dir).filter((f) => /^real-.*\.json$/.test(f)).sort() : [];
  for (const f of files) {
    const rep = JSON.parse(readFileSync(`${dir}/${f}`, "utf8")) as RealRunReport;
    if ((rep.phase ?? "initial") !== phase) continue;
    for (const r of rep.records) if (idFilter(r.target.id) && !out.has(r.target.id)) out.set(r.target.id, r);
  }
  return [...out.values()];
}

// ---------------------------------------------------------------- 再調査の効果（Stage 8D-6）
/** 検証結果を受けた再調査のあと、AIが実際に追加調査をしたか（review のあと、次の review までに検索・取得があったか）を、実行の経過から数える */
export function followUpActions(actions: { name: string; ok: boolean; arg: string }[]): { acted: number; resubmittedWithoutAction: number } {
  let acted = 0;
  let held = 0;
  for (let i = 0; i < actions.length; i++) {
    if (actions[i].name !== "review") continue;
    let did = false;
    for (let j = i + 1; j < actions.length && actions[j].name !== "review"; j++) if (actions[j].name === "web_search" || (actions[j].name === "fetch_page" && actions[j].ok)) did = true;
    if (did) acted++;
    else held++;
  }
  return { acted, resubmittedWithoutAction: held };
}

export interface FollowUpSummary {
  /** 再調査を有効にして実行した店舗数 */
  stores: number;
  /** 1回以上、再調査した店舗 */
  followedUp: number;
  totalRounds: number;
  /** 再調査の依頼のあと、AIが実際に追加の検索・取得をした回数／追加調査せず再提出した回数 */
  acted: number;
  resubmittedWithoutAction: number;
  /** 最終の提出に対する、再調査の判断（終了の理由）の内訳 */
  stopCodes: Record<string, number>;
  /** 同じ検索・URLの重複を断った回数 */
  duplicateCalls: number;
  known: {
    n: number;
    /** 最初の提出だけの結果（再調査しなかった場合に相当）と、最終の結果 */
    first: { correct: number; confirmedSuccess: number; wrongAdopted: number; wrongConfirmed: number };
    final: { correct: number; confirmedSuccess: number; wrongAdopted: number; wrongConfirmed: number };
    /** 再調査により、確認済みで正しい結果になった店舗／最初は正しかったが最終は正しくなくなった店舗 */
    improved: string[];
    worsened: string[];
  };
  /** 再調査した店舗の、最初の提出からの追加（最終 − 最初の提出時点）。再調査は同じ予算の中で行うため、1店舗の上限は超えない */
  added: { costJpy: number; ms: number; searches: number; fetches: number; steps: number };
  /** 再調査しなかった店舗も含めた、全体の合計 */
  totalCostJpy: number;
}

/** 再調査（followUps）を有効にした実行の記録から、最初の提出と最終の結果の違い・追加費用・時間・AIの行動を集計する。初回の主要評価値は最初の提出ではなく最終の結果 */
export function summarizeFollowUps(records: RealRecord[], scorer: typeof matchesGold = matchesGold): FollowUpSummary {
  const withRounds = records.filter((r) => (r.rounds?.length ?? 0) > 0);
  const stopCodes: Record<string, number> = {};
  let acted = 0;
  let held = 0;
  let duplicateCalls = 0;
  let totalRounds = 0;
  const added = { costJpy: 0, ms: 0, searches: 0, fetches: 0, steps: 0 };
  const first = { correct: 0, confirmedSuccess: 0, wrongAdopted: 0, wrongConfirmed: 0 };
  const final = { correct: 0, confirmedSuccess: 0, wrongAdopted: 0, wrongConfirmed: 0 };
  const improved: string[] = [];
  const worsened: string[] = [];
  let n = 0;
  const judge = (status: string, address: string | null, gold: RealGold) => {
    const adopted = (status === "confirmed" || status === "candidate") && !!address;
    const correct = adopted && scorer(address, gold);
    return { correct, adopted, wrongAdopted: adopted && !correct, wrongConfirmed: status === "confirmed" && adopted && !correct, confirmedSuccess: status === "confirmed" && correct };
  };
  for (const r of withRounds) {
    const rounds = r.rounds!;
    const r0 = rounds[0];
    const fr = rounds.filter((x) => x.continued).length;
    totalRounds += fr;
    const last = rounds[rounds.length - 1];
    if (last.stopCode) stopCodes[last.stopCode] = (stopCodes[last.stopCode] ?? 0) + 1;
    const fu = followUpActions(r.actions);
    acted += fu.acted;
    held += fu.resubmittedWithoutAction;
    duplicateCalls += r.usage.duplicateCalls ?? 0;
    if (fr > 0) {
      added.costJpy += r.usage.costJpy - r0.usage.costJpy;
      added.ms += r.usage.ms - r0.usage.ms;
      added.searches += r.usage.searches - r0.usage.searches;
      added.fetches += r.usage.fetches - r0.usage.fetches;
      added.steps += r.usage.steps - r0.usage.steps;
    }
    const g = REAL_GOLD.find((x) => x.id === r.target.id);
    if (!g || g.unknownGold) continue;
    n++;
    const a = judge(r0.status, r0.address, g);
    const b = judge(r.outcome.status, r.outcome.address, g);
    for (const [acc, j] of [[first, a], [final, b]] as const) {
      if (j.correct) acc.correct++;
      if (j.confirmedSuccess) acc.confirmedSuccess++;
      if (j.wrongAdopted) acc.wrongAdopted++;
      if (j.wrongConfirmed) acc.wrongConfirmed++;
    }
    if (!a.confirmedSuccess && b.confirmedSuccess) improved.push(r.target.id);
    if ((a.correct && !b.correct) || (a.confirmedSuccess && !b.confirmedSuccess)) worsened.push(r.target.id);
  }
  const rd = (x: number) => Math.round(x * 100) / 100;
  return {
    stores: withRounds.length,
    followedUp: withRounds.filter((r) => r.rounds!.some((x) => x.continued)).length,
    totalRounds,
    acted,
    resubmittedWithoutAction: held,
    stopCodes,
    duplicateCalls,
    known: { n, first, final, improved, worsened },
    added: { costJpy: rd(added.costJpy), ms: Math.round(added.ms), searches: added.searches, fetches: added.fetches, steps: added.steps },
    totalCostJpy: rd(records.reduce((t, r) => t + r.usage.costJpy, 0)),
  };
}
