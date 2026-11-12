/** 反映候補の表示用の型・ラベル（Stage 8D-4）。画面（クライアント）とサーバーの両方から使うため、server-only の外に置く */
export type ProposalStatus = "pending" | "on_hold" | "rejected" | "applied" | "reverted";
export const PROPOSAL_STATUS_LABEL: Record<ProposalStatus, string> = { pending: "承認待ち", on_hold: "保留", rejected: "却下", applied: "反映済み", reverted: "取消済み" };
export const EVENT_LABEL: Record<string, string> = { created: "候補を作成", held: "保留", reopened: "保留を解除", rejected: "却下", applied: "承認して反映", apply_blocked: "反映できなかった", reverted: "反映を取消", revert_blocked: "取消できなかった" };

export interface ProposalView {
  id: string;
  storeId: string;
  chainName: string;
  storeName: string;
  status: ProposalStatus;
  researchStatus: "confirmed" | "candidate";
  confidence: number;
  officialStatus: "trusted" | "verified" | "candidate" | "none";
  current: { address: string; prefecture: string };
  proposed: { address: string; prefecture: string | null; hasLatLng: boolean };
  diff: { field: string; before: string | null; after: string | null }[];
  reasons: string[];
  sources: { url: string; official?: boolean; quote?: string }[];
  note: string | null;
  createdAt: string;
  events: { action: string; fromStatus: string | null; toStatus: string | null; note: string | null; occurredAt: string; detail: Record<string, unknown> }[];
}

