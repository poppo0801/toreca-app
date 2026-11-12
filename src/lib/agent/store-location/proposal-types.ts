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


/** 一括操作の種類。承認は反映（開発DBの店舗マスターを更新）、保留・却下は状態の変更だけ */
export type BulkOp = "apply" | "hold" | "reject";
export const BULK_OP_LABEL: Record<BulkOp, string> = { apply: "承認して反映", hold: "保留", reject: "却下" };

/**
 * 一括操作できない理由（できるなら null）。UI の事前確認とサーバーの両方で同じ判定を使う（サーバー側でも必ず再判定する）。
 * 一括の承認は、根拠が最も強いものに限る: 調査が「確認済み」・公式（登録済み／検証済み）の情報源・既存の住所が無い。
 * それ以外（候補・公式を確認できない・既存の住所の置き換え）は、情報源と差異を見て個別に承認する。
 * （店舗の同一性・編集の競合・二重反映などの整合性は、一括でも1件ずつ DB 関数が検証し、拒否した理由を履歴に残す）
 */
export function bulkBlockReason(p: ProposalView, op: BulkOp): string | null {
  if (op === "apply") {
    if (p.status !== "pending" && p.status !== "on_hold") return "この状態では承認できません";
    if (p.researchStatus !== "confirmed") return "調査が「確認済み」でないため、個別に承認してください";
    if (p.officialStatus !== "trusted" && p.officialStatus !== "verified") return "公式の情報源を確認できないため、個別に承認してください";
    if (p.current.address.trim() !== "") return "既存の住所があるため、個別に承認してください";
    return null;
  }
  if (op === "hold") return p.status === "pending" ? null : "承認待ちの候補だけ保留にできます";
  return p.status === "pending" || p.status === "on_hold" ? null : "この状態では却下できません";
}

export interface BulkResult {
  id: string;
  storeLabel: string;
  ok: boolean;
  /** 失敗・対象外の理由（利用者向け） */
  message: string | null;
}
