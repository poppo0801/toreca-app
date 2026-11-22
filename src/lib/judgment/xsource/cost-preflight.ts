/**
 * 実AI評価の費用の事前検査（Stage 10Y・課金なし・純関数）。Stage 10X の再試験で、**1件の上限が予約額の合計より小さく、調査が一度も始まらない**設定を2回実行してしまったため、
 * 実行**前**に 総額・1件・判断用の予約・検索の予約 を計算して検査する。実際のAPI呼び出しの前に呼ぶ（呼ばなければ実行しない設計は、各 real テストで静的に確認する）。
 *
 * 保証の範囲（正直な制約）: 予約は「呼び出しの前に、残りの上限に収まるか」を見る仕組み。**1回の呼び出しの実費は、呼び出しの後でしか分からない**。
 *  - 入力の大きさ・出力の上限（max_tokens）が有限なので、1回の最悪の費用は計算できる（`worstCaseCallJpy`）。**予約額がその最悪費用以上**なら、1回の呼び出しで予約を超えることはない。
 *  - 予約が最悪費用より小さい設定は `reserveBelowWorstCase` として警告し、実費が予約を超えたときは**事後に実費で計上し、残りが無ければ以降の呼び出しを開始しない**（CallBudget が overrun を記録）。
 *    この場合、承認額を**1回分の最悪費用だけ超えうる**。承認額の絶対保証は、予約額を最悪費用以上にした設定でのみ成立する。
 *  - Web検索（サーバー側ツール）は、1回の問い合わせで内部の継続（pause_turn）により複数メッセージになりうる。メッセージ数の上限（maxMessages）を指定して最悪費用を計算する。
 */
import { MODEL_PRICES, USD_JPY_ESTIMATE } from "@/lib/ai-cost";

export interface PreflightInput {
  model: string;
  totalJpy: number;
  perCaseJpy: number;
  cases: number;
  limits: { maxTurns: number; maxSearches: number; maxRevisions: number; agentReserveJpy: number; judgeReserveJpy: number; searchReserveJpy: number };
  /** 1回の呼び出しの入力の最大トークン（保守的な概算。1文字=1トークン換算など） */
  maxInputTokens: number;
  /** 1回の呼び出しの出力の上限（max_tokens） */
  maxOutputTokens: number;
  /** 検索1回あたりの最悪費用（円）。検索を使わなければ 0 */
  searchWorstJpy?: number;
  /** 関門の候補上限（1件） */
  gatePerCaseCapJpy?: number;
}

export interface PreflightResult {
  ok: boolean;
  errors: string[];
  warnings: string[];
  /** 調査が1回始まるのに必要な最小の1件上限（調査＋判断の予約。検索を使うなら検索の予約も） */
  minPerCaseJpy: number;
  /** 1件で使いうる最大の予約合計（全ターン・再評価・検索を使い切った場合） */
  maxReservedPerCaseJpy: number;
  worstCaseCallJpy: number;
  /** 予約額が最悪費用以上か（以上なら、1回の呼び出しで予約を超えない＝承認額を超えない保証が成り立つ） */
  reservationCoversWorstCase: boolean;
}

const r4 = (n: number): number => Math.round(n * 10_000) / 10_000;

export function worstCaseCallJpy(model: string, inputTokens: number, outputTokens: number, rate = USD_JPY_ESTIMATE): number {
  const p = MODEL_PRICES[model];
  if (!p) return Number.POSITIVE_INFINITY; // 単価が不明なモデルは、費用を保証できない
  return r4(((inputTokens * p.input + outputTokens * p.output) / 1_000_000) * rate);
}

export function preflightRun(i: PreflightInput): PreflightResult {
  const errors: string[] = [];
  const warnings: string[] = [];
  const L = i.limits;
  const useSearch = L.maxSearches > 0;
  const worst = worstCaseCallJpy(i.model, i.maxInputTokens, i.maxOutputTokens);
  if (!Number.isFinite(worst)) errors.push(`model_price_unknown:${i.model}`);
  const eps = 1e-9;
  // 調査の各ターンは、調査＋判断の予約が残っていることを要求する。検索は検索の予約も要る
  const minPerCase = r4(L.agentReserveJpy + L.judgeReserveJpy);
  const minWithSearch = useSearch ? r4(minPerCase + L.searchReserveJpy) : minPerCase;
  const maxReserved = r4(L.maxTurns * L.agentReserveJpy + L.maxSearches * L.searchReserveJpy + (1 + L.maxRevisions) * L.judgeReserveJpy);
  if (!(i.totalJpy > 0) || !(i.perCaseJpy > 0) || !Number.isFinite(i.totalJpy) || !Number.isFinite(i.perCaseJpy)) errors.push("approval_amounts_missing");
  if (i.perCaseJpy > i.totalJpy + eps) errors.push("per_case_exceeds_total");
  if (i.gatePerCaseCapJpy !== undefined && i.perCaseJpy > i.gatePerCaseCapJpy + eps) errors.push(`per_case_exceeds_gate_cap:${i.gatePerCaseCapJpy}`);
  // 調査が一度も始まらない設定（Stage 10X の再試験で2回発生）
  if (i.perCaseJpy + eps < minPerCase) errors.push(`per_case_below_min_reserve:${i.perCaseJpy}<${minPerCase}`);
  else if (useSearch && i.perCaseJpy + eps < minWithSearch) errors.push(`per_case_below_search_reserve:${i.perCaseJpy}<${minWithSearch}`);
  if (i.totalJpy + eps < minPerCase) errors.push(`total_below_min_reserve:${i.totalJpy}<${minPerCase}`);
  if (Number.isFinite(worst)) {
    if (L.agentReserveJpy + eps < worst || L.judgeReserveJpy + eps < worst) warnings.push(`reserve_below_worst_case_call:${L.agentReserveJpy}/${L.judgeReserveJpy}<${worst}`);
    if (useSearch && L.searchReserveJpy + eps < (i.searchWorstJpy ?? Number.POSITIVE_INFINITY)) warnings.push(`search_reserve_below_worst_case:${L.searchReserveJpy}<${i.searchWorstJpy ?? "unknown"}`);
  }
  if (i.cases * Math.min(i.perCaseJpy, maxReserved) > i.totalJpy * 4) warnings.push("total_much_smaller_than_sum_of_case_caps（総額が先に尽きる設定。後ろの事例が評価されない可能性）");
  const coversCall = Number.isFinite(worst) && L.agentReserveJpy + eps >= worst && L.judgeReserveJpy + eps >= worst;
  const coversSearch = !useSearch || L.searchReserveJpy + eps >= (i.searchWorstJpy ?? Number.POSITIVE_INFINITY);
  return { ok: errors.length === 0, errors, warnings, minPerCaseJpy: useSearch ? minWithSearch : minPerCase, maxReservedPerCaseJpy: maxReserved, worstCaseCallJpy: Number.isFinite(worst) ? worst : -1, reservationCoversWorstCase: coversCall && coversSearch };
}
