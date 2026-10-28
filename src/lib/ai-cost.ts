/**
 * AI利用料金の管理（推定）。実際の請求額は Anthropic Console のデータが正で、ここでの金額はあくまで推定。
 * 料金は Anthropic 公式の料金ページ（platform.claude.com/docs/en/about-claude/pricing）で 2026-10-29 に確認した値:
 *   Claude Haiku 5.5（claude-haiku-5-5）  入力 $0.10 / 出力 $0.50  per 100万トークン（プロンプト10万トークン以下）
 *   Claude Sonnet 5.5（claude-sonnet-5-5） 入力 $2    / 出力 $10    per 100万トークン
 * 画像入力のトークン換算は料金ページに記載がないため、API応答の usage（画像分を含む実トークン数）をそのまま使う。
 * 円換算の為替レートは概算（実際のレートとは異なる）。
 */

export interface ModelPrice {
  /** USD per 1M tokens */
  input: number;
  output: number;
}

export const MODEL_PRICES: Record<string, ModelPrice> = {
  "claude-haiku-5-5": { input: 0.1, output: 0.5 },
  "claude-sonnet-5-5": { input: 2, output: 10 },
};

/** 標準のモデル（費用を抑えるため Haiku）。実際のAI解析での精度は未検証 */
export const DEFAULT_AI_MODEL = "claude-haiku-5-5";

/** 円換算の概算レート（1ドル=150円）。変動するため、請求額の確認は Anthropic Console で行う */
export const USD_JPY_ESTIMATE = 150;

export const DEFAULT_BUDGET_JPY = 3000;

/** 推定料金（円）。モデルの料金が不明・トークン数が不明なら null（0円にしない） */
export function estimateCostJpy(model: string | null | undefined, inputTokens: number | null | undefined, outputTokens: number | null | undefined, rate = USD_JPY_ESTIMATE): number | null {
  if (!model || inputTokens == null || outputTokens == null) return null;
  const p = MODEL_PRICES[model];
  if (!p) return null;
  return ((inputTokens * p.input + outputTokens * p.output) / 1_000_000) * rate;
}

export type AiKind = "text" | "image" | "url" | "x_url";

export interface AiLogRow {
  created_at: string;
  kind: string;
  status: string;
  engine: string;
  model: string | null;
  input_tokens: number | null;
  output_tokens: number | null;
}

export interface UsageSummary {
  /** YYYY-MM（JST） */
  month: string;
  /** 実際のAIを呼んだ回数（モック・未設定は含まない） */
  calls: number;
  byKind: Record<AiKind, number>;
  inputTokens: number;
  outputTokens: number;
  /** 使用モデルごとの回数 */
  byModel: Record<string, number>;
  /** 推定料金（円）。推定できなかった分は含まない */
  costJpy: number;
  /** モデルまたはトークン数が不明で推定できなかった回数 */
  unestimated: number;
  /** モック（開発用サンプル）の利用回数。料金は発生しない */
  mockCalls: number;
}

const jstMonth = (iso: string) => new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Tokyo", year: "numeric", month: "2-digit" }).format(new Date(iso)).slice(0, 7);

export const emptySummary = (month: string): UsageSummary => ({ month, calls: 0, byKind: { text: 0, image: 0, url: 0, x_url: 0 }, inputTokens: 0, outputTokens: 0, byModel: {}, costJpy: 0, unestimated: 0, mockCalls: 0 });

/** 月ごとの利用状況（新しい月順）。実際のAI呼び出し(engine=anthropic)だけが料金の対象 */
export function summarizeUsage(logs: AiLogRow[], rate = USD_JPY_ESTIMATE): UsageSummary[] {
  const map = new Map<string, UsageSummary>();
  for (const l of logs) {
    const m = jstMonth(l.created_at);
    const s = map.get(m) ?? emptySummary(m);
    map.set(m, s);
    if (l.engine === "mock") {
      s.mockCalls++;
      continue;
    }
    if (l.engine !== "anthropic") continue; // 未設定・取得失敗など、AIを呼んでいないもの
    s.calls++;
    if (l.kind in s.byKind) s.byKind[l.kind as AiKind]++;
    s.inputTokens += l.input_tokens ?? 0;
    s.outputTokens += l.output_tokens ?? 0;
    const model = l.model ?? "（モデル不明）";
    s.byModel[model] = (s.byModel[model] ?? 0) + 1;
    const c = estimateCostJpy(l.model, l.input_tokens, l.output_tokens, rate);
    if (c === null) s.unestimated++;
    else s.costJpy += c;
  }
  return [...map.values()].sort((a, b) => b.month.localeCompare(a.month));
}

export type BudgetLevel = "ok" | "warn1" | "warn2" | "warn3" | "over";

export interface BudgetStatus {
  level: BudgetLevel;
  /** 使用率（0〜）。予算0円のときは null */
  usedRate: number | null;
  budgetJpy: number;
  costJpy: number;
  /** 警告の閾値（円）。既定の予算3,000円なら 1,000 / 2,000 / 2,500 */
  thresholds: [number, number, number];
  message: string | null;
}

/** 警告の目安は予算の 1/3・2/3・5/6（予算3,000円で 1,000・2,000・2,500円）。予算を超えたら over */
export function budgetThresholds(budgetJpy: number): [number, number, number] {
  return [Math.round(budgetJpy / 3), Math.round((budgetJpy * 2) / 3), Math.round((budgetJpy * 5) / 6)];
}

export function budgetStatus(costJpy: number, budgetJpy: number): BudgetStatus {
  const [t1, t2, t3] = budgetThresholds(budgetJpy);
  const usedRate = budgetJpy > 0 ? costJpy / budgetJpy : null;
  let level: BudgetLevel = "ok";
  if (costJpy >= budgetJpy) level = "over";
  else if (costJpy >= t3) level = "warn3";
  else if (costJpy >= t2) level = "warn2";
  else if (costJpy >= t1) level = "warn1";
  const yen = (n: number) => `${Math.round(n).toLocaleString("ja-JP")}円`;
  const message =
    level === "ok"
      ? null
      : level === "over"
        ? `今月の推定AI料金が月間予算（${yen(budgetJpy)}）に達しました。自動AI解析は停止されます。`
        : `今月の推定AI料金が${yen(level === "warn1" ? t1 : level === "warn2" ? t2 : t3)}を超えました（月間予算 ${yen(budgetJpy)} の${Math.round((usedRate ?? 0) * 100)}%）。`;
  return { level, usedRate, budgetJpy, costJpy, thresholds: [t1, t2, t3], message };
}

/**
 * 自動AI解析（Stage 4C）を実行してよいか。予算超過、または利用者が自動解析をOFFにしているときは止める。
 * 手動の「AIで読み取る」は止めず、警告だけ表示する（利用者が自分で判断して使う）。
 */
export function canRunAutoAnalysis(status: Pick<BudgetStatus, "level">, autoAiEnabled: boolean): { allowed: boolean; reason: string | null } {
  if (!autoAiEnabled) return { allowed: false, reason: "自動AI解析がOFFに設定されています" };
  if (status.level === "over") return { allowed: false, reason: "月間のAI予算に達したため停止しています" };
  return { allowed: true, reason: null };
}
