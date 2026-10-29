import "server-only";
import { DEFAULT_BUDGET_JPY, budgetStatus, emptySummary, summarizeUsage, type AiLogRow, type BudgetStatus } from "@/lib/ai-cost";
import type { Db } from "@/lib/server/lottery-service";

/**
 * 今月のAI利用料金（推定）と月間予算の状態。一括解析・カード画像の解析は、予算を超えていたら新しい解析を始めない。
 * 呼び出した本人の世帯の記録だけを見る（RLS）。
 */
export async function monthBudget(db: Db): Promise<{ status: BudgetStatus; blocked: boolean }> {
  const since = new Date(Date.now() - 40 * 86400_000).toISOString();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- model 列などは生成型に無い場合がある
  const any = db as any;
  const logs = await any.from("ai_extraction_logs").select("created_at,kind,status,engine,model,input_tokens,output_tokens").gte("created_at", since).limit(5000);
  const st = await any.from("household_settings").select("ai_monthly_budget_jpy").maybeSingle();
  const budget: number = !st.error && st.data && typeof st.data.ai_monthly_budget_jpy === "number" ? st.data.ai_monthly_budget_jpy : DEFAULT_BUDGET_JPY;
  const month = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Tokyo", year: "numeric", month: "2-digit" }).format(new Date()).slice(0, 7);
  const current = summarizeUsage((logs.data ?? []) as AiLogRow[]).find((m) => m.month === month) ?? emptySummary(month);
  const status = budgetStatus(current.costJpy, budget);
  return { status, blocked: status.level === "over" };
}
