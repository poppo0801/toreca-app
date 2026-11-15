import "server-only";
import type { InvestigationRequest, InvestigationResponse } from "@/lib/case-model/investigation-types";

/**
 * 収集処理からAI調査を呼び出す口（Stage 9H-3B）。grouping-hook.ts と同じ作り。
 *  - **開発環境（TOREMANE_ENV=local）だけ**で動く。本番（Vercel）では何もせず、収集の動作は変わらない（先頭の判定で即座に戻る）。
 *  - 調査のコード（AI・台帳・検証層）は、環境の判定を通ったあとに初めて読み込む（本番では読み込まれない）。
 *  - 既定では調査機能は接続されていない（実AIの頭脳・実検索は承認制）。接続されていない場合は skipped を返し、収集は従来どおり進む。
 *  - 失敗しても収集を止めない。
 */
export async function runInvestigation(req: InvestigationRequest): Promise<InvestigationResponse> {
  if (process.env.TOREMANE_ENV !== "local") return { skipped: "disabled" };
  try {
    const { investigateForCollection } = await import("@/lib/server/agent/case-bridge");
    return await investigateForCollection(req);
  } catch {
    return { skipped: "error" };
  }
}
