/**
 * 収集処理の段階別の件数と、API費用の集計（Stage 9H-3L・純関数）。費用を下げるためではなく、将来の最適化に必要な実績を見えるようにする。
 *
 * 既存の記録だけを使う（新しいテーブル・列を足さない）:
 *   - 候補（collection_candidates）: 状態・理由・解析回数。収集した件数・段階別の除外（地域外・商品対象外・重複）・取得失敗・保留
 *   - AI利用ログ（ai_extraction_logs）: モデル・トークン数。**費用はこのログだけから算出する**（日別統計・候補の費用は別の集計なので足さない＝二重計上しない）
 *   - 検索API（調査エージェントの記録）: 記録があるときだけ。無い（通常の収集は検索APIを使わない／開発環境のみの記録）ときは「未記録」
 * 費用が不明（モデル・トークン数が分からない）な呼び出しは 0円にせず、「不明N回」として別に数える。
 *
 * 段階の位置（有料AIの前か後か）は、その候補でAI解析が行われたか（解析回数 > 0）で判別する:
 *   AIの前（費用なし）: 除外ルール・一覧の見出しによる事前除外・同じURLの再処理の防止
 *   AIの後: 抽出された店舗による地域判定・商品の対象外・内容による重複判定
 */
import { estimateCostJpy, type AiLogRow } from "@/lib/ai-cost";

export interface CandidateCostRow {
  status: string;
  job_state: string;
  created_at: string;
  fail_kind?: string | null;
  triage?: string | null;
  reasons?: string[] | null;
  ai_calls?: number | null;
}

export interface SearchStepRow {
  created_at: string;
  tool: string;
  cost_jpy: number | string | null;
}

export type StageKey = "region" | "product" | "duplicate" | "fetchFailed" | "held";

export interface StageCounts {
  /** 収集した情報（候補）の件数 */
  collected: number;
  /** AI解析を行った件数（解析回数が1以上の候補） */
  aiAnalyzed: number;
  /** 段階別: 位置（AIの前＝費用なし／AIの後＝費用あり）に分けた件数 */
  region: { beforeAi: number; afterAi: number };
  product: { beforeAi: number; afterAi: number };
  duplicate: { beforeAi: number; afterAi: number };
  /** 取得失敗（原因が受付終了でない失敗） */
  fetchFailed: number;
  /** 保留・要手動確認（自動再調査待ち・手動確認が必要） */
  held: number;
}

const emptyStage = (): StageCounts => ({ collected: 0, aiAnalyzed: 0, region: { beforeAi: 0, afterAi: 0 }, product: { beforeAi: 0, afterAi: 0 }, duplicate: { beforeAi: 0, afterAi: 0 }, fetchFailed: 0, held: 0 });

const REGION = /対象外の地域|地域外|地域.*除外/;
const PRODUCT = /ポケモンカード以外|別ゲーム|対象外の商品|商品.*対象外|商品の絞り込み/;

const jstDay = (iso: string) => new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Tokyo", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(iso));

/** 候補1件の段階の分類。1件は、最も先に当てはまる1つの段階にだけ数える（二重に数えない） */
export function classifyStage(r: CandidateCostRow): StageKey | null {
  const text = (r.reasons ?? []).join(" ");
  if (r.status === "excluded" && REGION.test(text)) return "region";
  if (r.status === "excluded" && PRODUCT.test(text)) return "product";
  if (r.status === "duplicate") return "duplicate";
  if (r.job_state === "failed" || (r.fail_kind && r.fail_kind !== "expired" && r.status !== "excluded")) return "fetchFailed";
  if (r.triage === "auto_retry" || r.triage === "manual") return "held";
  return null;
}

export interface ModelCost {
  model: string;
  calls: number;
  inputTokens: number;
  outputTokens: number;
  /** 推定できた呼び出しの費用（円）。不明な呼び出しは含めない */
  costJpy: number;
  /** モデル・トークン数が不明で費用を推定できなかった呼び出し */
  unknownCalls: number;
}

export interface DayCost {
  day: string;
  stages: StageCounts;
  aiCalls: number;
  aiCostJpy: number;
  unknownCostCalls: number;
}

export interface CostReport {
  days: DayCost[];
  stages: StageCounts;
  ai: {
    calls: number;
    costJpy: number;
    /** 費用を推定できなかった呼び出し（0円として扱っていない） */
    unknownCalls: number;
    byModel: ModelCost[];
    /** 1件あたりの平均AI費用（円）。推定できた呼び出しだけで計算。1件も無ければ null（不明） */
    avgPerCallJpy: number | null;
    /** 解析した候補1件あたりの平均AI費用（円）。解析した候補が無い・費用を推定できた呼び出しが無いときは null */
    avgPerAnalyzedCandidateJpy: number | null;
  };
  search: {
    /** 検索APIの記録の有無。記録が無いときは回数・費用とも null（0としない） */
    recorded: boolean;
    calls: number | null;
    costJpy: number | null;
  };
  /** 有料AIの後で除外・重複と判明した件数（将来の事前判定の余地。今回は事前除外を導入しない） */
  afterAiDiscarded: number;
}

const round = (v: number) => Math.round(v * 10000) / 10000;

/**
 * 集計する。費用は logs だけから算出する（candidates の解析回数は段階の位置の判別にだけ使い、費用には使わない）。
 * searchSteps が undefined のときは検索APIの記録が無い（未記録）。配列（空でもよい）のときは記録あり。
 */
export function buildCostReport(input: { candidates: CandidateCostRow[]; logs: AiLogRow[]; searchSteps?: SearchStepRow[] | null; rate?: number }): CostReport {
  const days = new Map<string, DayCost>();
  const day = (d: string) => {
    let x = days.get(d);
    if (!x) days.set(d, (x = { day: d, stages: emptyStage(), aiCalls: 0, aiCostJpy: 0, unknownCostCalls: 0 }));
    return x;
  };
  const total = emptyStage();
  let afterAiDiscarded = 0;
  for (const r of input.candidates) {
    const d = day(jstDay(r.created_at));
    const analyzed = (r.ai_calls ?? 0) > 0;
    for (const s of [d.stages, total]) {
      s.collected += 1;
      if (analyzed) s.aiAnalyzed += 1;
    }
    const k = classifyStage(r);
    if (!k) continue;
    for (const s of [d.stages, total]) {
      if (k === "fetchFailed") s.fetchFailed += 1;
      else if (k === "held") s.held += 1;
      else s[k][analyzed ? "afterAi" : "beforeAi"] += 1;
    }
    if (analyzed && (k === "region" || k === "product" || k === "duplicate")) afterAiDiscarded += 1;
  }
  // AI費用: 実際にAIを呼んだログだけ（モックは費用なし・取得失敗などAIを呼んでいないものは数えない）
  const models = new Map<string, ModelCost>();
  let calls = 0;
  let cost = 0;
  let unknown = 0;
  let knownCalls = 0;
  for (const l of input.logs) {
    if (l.engine !== "anthropic") continue;
    calls += 1;
    const d = day(jstDay(l.created_at));
    d.aiCalls += 1;
    const model = l.model ?? "（モデル不明）";
    const m = models.get(model) ?? { model, calls: 0, inputTokens: 0, outputTokens: 0, costJpy: 0, unknownCalls: 0 };
    models.set(model, m);
    m.calls += 1;
    m.inputTokens += l.input_tokens ?? 0;
    m.outputTokens += l.output_tokens ?? 0;
    const c = estimateCostJpy(l.model, l.input_tokens, l.output_tokens, input.rate);
    if (c === null) {
      unknown += 1;
      m.unknownCalls += 1;
      d.unknownCostCalls += 1;
    } else {
      knownCalls += 1;
      cost += c;
      m.costJpy += c;
      d.aiCostJpy += c;
    }
  }
  const search = (() => {
    if (!input.searchSteps) return { recorded: false, calls: null, costJpy: null };
    const ss = input.searchSteps.filter((s) => /search/i.test(s.tool));
    return { recorded: true, calls: ss.length, costJpy: round(ss.reduce((a, s) => a + (Number(s.cost_jpy) || 0), 0)) };
  })();
  return {
    days: [...days.values()].map((d) => ({ ...d, aiCostJpy: round(d.aiCostJpy) })).sort((a, b) => b.day.localeCompare(a.day)),
    stages: total,
    ai: {
      calls,
      costJpy: round(cost),
      unknownCalls: unknown,
      byModel: [...models.values()].map((m) => ({ ...m, costJpy: round(m.costJpy) })).sort((a, b) => b.calls - a.calls),
      avgPerCallJpy: knownCalls > 0 ? round(cost / knownCalls) : null,
      avgPerAnalyzedCandidateJpy: total.aiAnalyzed > 0 && knownCalls > 0 ? round(cost / total.aiAnalyzed) : null,
    },
    search,
    afterAiDiscarded,
  };
}
