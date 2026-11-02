import "server-only";
import { DEFAULT_BUDGET_JPY, USD_JPY_ESTIMATE, budgetStatus, emptySummary, summarizeUsage, type AiLogRow, type BudgetStatus } from "@/lib/ai-cost";
import type { Db } from "@/lib/server/lottery-service";

/** 料金を推定できなかった呼び出し（モデル・トークン数が不明）を、予算の判定では安全側に1回あたりこの金額として数える */
export const UNESTIMATED_CALL_JPY = 5;

export interface MonthBudgetInfo {
  status: BudgetStatus;
  blocked: boolean;
  /** 今月（日本時間）の推定AI料金。推定できなかった呼び出しは安全側の金額で加算済み */
  costJpy: number;
  budgetJpy: number;
  /** 円換算に使う為替レート（1ドルあたりの円。世帯の設定。概算） */
  rate: number;
  calls: number;
  /** 今月の1回あたりの平均（実測。呼び出しが無ければ null） */
  avgPerCallJpy: number | null;
  autoAiEnabled: boolean;
}

/**
 * 今月のAI利用料金（推定）と月間予算の状態。一括解析・カード画像の解析・自動収集は、予算を超えていたら新しい解析を始めない。
 * 料金は既存の利用記録（ai_extraction_logs: 実際の入出力トークン数×モデル別単価）から計算する。月の区切りは日本時間。
 * householdId を指定すると、その世帯だけを集計する（service_role で複数世帯を扱う定期処理用）。
 */
export async function monthBudget(db: Db, householdId?: string): Promise<MonthBudgetInfo> {
  const since = new Date(Date.now() - 40 * 86400_000).toISOString();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- model 列などは生成型に無い場合がある
  const any = db as any;
  let lq = any.from("ai_extraction_logs").select("created_at,kind,status,engine,model,input_tokens,output_tokens").gte("created_at", since).limit(5000);
  let sq = any.from("household_settings").select("ai_monthly_budget_jpy,ai_usd_jpy_rate,auto_ai_enabled");
  if (householdId) {
    lq = lq.eq("household_id", householdId);
    sq = sq.eq("household_id", householdId);
  }
  const [logs, st] = await Promise.all([lq, sq.maybeSingle()]);
  const row = !st.error && st.data ? st.data : null;
  const budget: number = row && typeof row.ai_monthly_budget_jpy === "number" ? row.ai_monthly_budget_jpy : DEFAULT_BUDGET_JPY;
  const rate: number = row && Number(row.ai_usd_jpy_rate) > 0 ? Number(row.ai_usd_jpy_rate) : USD_JPY_ESTIMATE;
  const month = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Tokyo", year: "numeric", month: "2-digit" }).format(new Date()).slice(0, 7);
  const current = summarizeUsage((logs.data ?? []) as AiLogRow[], rate).find((m) => m.month === month) ?? emptySummary(month);
  const costJpy = current.costJpy + current.unestimated * UNESTIMATED_CALL_JPY;
  const status = budgetStatus(costJpy, budget);
  return {
    status,
    blocked: status.level === "over",
    costJpy,
    budgetJpy: budget,
    rate,
    calls: current.calls,
    avgPerCallJpy: current.calls > 0 ? costJpy / current.calls : null,
    autoAiEnabled: row ? row.auto_ai_enabled !== false : true,
  };
}
