import "server-only";
import type { Db } from "@/lib/server/lottery-service";

/**
 * 自動収集で登録された抽選に対する、グループ判定の呼び出し口（Stage 8F）。
 *  - **開発環境（TOREMANE_ENV=local）だけ**で動く。本番（Vercel）では何もせず、収集の動作は変わらない（先頭の判定で即座に戻る）。
 *  - 判定は、既存の抽選グループとの関係（既存グループへ追加／新規グループ／単独／保留）を調べるだけで、失敗しても収集を止めない（例外を握りつぶして終了）。
 *  - グループ判定のコード（AI・検証層・保存）は、環境の判定を通ったあとに初めて読み込む（本番では読み込まれない）。
 */
export async function afterCollectedRegistration(db: Db, householdId: string, lotteryId: string, opts: { asService: boolean; actor: string | null }): Promise<void> {
  if (process.env.TOREMANE_ENV !== "local") return;
  try {
    const { createGroupingFetcher, createGroupingLlm } = await import("@/lib/server/agent/lottery-grouping-engine");
    const { runLotteryGrouping } = await import("@/lib/server/agent/lottery-grouping-service");
    const { canAutoGroup } = await import("@/lib/agent/lottery-grouping/flags");
    const engine = createGroupingLlm(process.env);
    await runLotteryGrouping(db, householdId, lotteryId, { llm: engine.llm, allowAuto: canAutoGroup(), asService: opts.asService, actor: opts.actor, followUps: 1, fetcher: await createGroupingFetcher(process.env) });
  } catch {
    /* グループ判定の失敗で収集を止めない */
  }
}
