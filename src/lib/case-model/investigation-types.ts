/**
 * 収集処理 ↔ AI調査の境界の型（Stage 9H-3B）。収集処理（lib/server/collector）は、この型だけを知っていて、調査エージェントの部品を静的に読み込まない。
 */
import type { ExtractedLottery } from "@/lib/ai/extraction";
import type { InvestigationState } from "./judgment";
import type { CaseFile, CaseFieldKey } from "./types";

export interface InvestigationRequest {
  candidateId: string;
  /** 候補の情報元URL */
  url: string;
  title: string;
  /** 固定ロジックの前段（アカウント特定まで）を通った抽出結果 */
  extraction: ExtractedLottery;
  /** 調査が必要と判断された理由 */
  needs: InvestigationState;
  /** 過去の人間の判断（参考。確定値として使わない） */
  humanHints: string[];
  /** 人間が確定した項目（調査結果で上書きしない） */
  humanLocked: CaseFieldKey[];
  /** 情報源の分類の材料（利用者が登録した公式サイト・公式X・まとめ）。無ければ、取得したページは公式と判定されない */
  classify?: { officialHosts: string[]; officialAccounts: string[]; aggregatorHosts: string[]; aggregatorAccounts: string[] };
  /** 投稿者のXアカウント（あれば） */
  account?: { username?: string; displayName?: string };
}

export type InvestigationResponse = { caseFile: CaseFile; stopReason?: string } | { skipped: string };
export type InvestigateFn = (req: InvestigationRequest) => Promise<InvestigationResponse>;
