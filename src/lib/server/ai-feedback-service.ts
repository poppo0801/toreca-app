import type { ExtractedLottery } from "@/lib/ai/extraction";
import { aiSnapshot, compareFeedback, inputSnapshot } from "@/lib/ai/feedback";
import { lotteryInputSchema, type LotteryInputParsed } from "@/lib/lottery-input";
import type { Json } from "@/types/database";
import type { Db } from "@/lib/server/lottery-service";

/**
 * AI解析から新規登録した抽選について、AIの抽出結果と最終内容の比較を記録する（登録時に1回だけ）。
 *  - AIの抽出結果はサーバー側（解析ログ）に保存してあるものを使う（クライアントの申告値は使わない）。
 *  - 同じ解析(run_id)からの記録は1件だけ（二重送信・二重登録でも重複しない）。
 *  - 登録後の通常編集では呼ばれない（後日の締切更新などが、過去のAI誤認識として計上されない）。
 * 戻り値: recorded / duplicate（記録済み）/ skipped（記録できる解析結果が無い）
 */
export async function recordAiFeedback(db: Db, lotteryId: string, final: LotteryInputParsed, actor: string | null): Promise<"recorded" | "duplicate" | "skipped"> {
  const fb = final.aiFeedback;
  if (!fb) return "skipped";
  const { data: run } = await db.from("ai_extraction_logs").select("id,household_id,engine,kind,model,prompt_version,extraction").eq("id", fb.runId).maybeSingle();
  if (!run || !run.extraction) return "skipped";
  const filled = lotteryInputSchema.safeParse(fb.filled);
  if (!filled.success) return "skipped";

  const result = compareFeedback(aiSnapshot(run.extraction as unknown as ExtractedLottery), inputSnapshot(filled.data), inputSnapshot(final), fb.reason);
  const { error } = await db.from("ai_extraction_feedback").insert({
    household_id: run.household_id,
    run_id: run.id,
    lottery_id: lotteryId,
    finalized_by_profile_id: actor,
    engine: run.engine,
    kind: run.kind,
    model: run.model,
    prompt_version: run.prompt_version,
    field_results: result.fields as unknown as Json,
    adopted_count: result.adopted,
    modified_count: result.modified,
    supplemented_count: result.supplemented,
    normalized_count: result.normalized,
    explicit_error_count: result.explicitError,
    reason: fb.reason,
  });
  if (!error) return "recorded";
  if (error.code === "23505") return "duplicate";
  throw new Error("feedback insert failed");
}
