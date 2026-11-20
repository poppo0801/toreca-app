/**
 * 履歴保護の判定（Stage 10D・純関数）。
 * 応募・当落・購入・スルー・通知・手動修正などの「人の記録・確定」を持つ抽選を、AI・自動処理が勝手に変更・統合・削除しない。
 * 記録の有無はDB関数 `lottery_history_blockers`（理由コードの配列）が返し、ここでは操作の種類ごとに許可・拒否を決める。
 * UI側のチェックに頼らず、サーバー側の共通入口（`server/case-foundation/guard.ts`）から必ず通す。
 */

/** DB関数が返す理由コード */
export type BlockerCode =
  | "not_found"
  | "confirmed"
  | "human_registered"
  | "manual_form"
  | "managed"
  | "applications"
  | "notifications"
  | "skip"
  | "rules"
  | "memo_feedback"
  | "user_exclusion"
  | "x_bookmark";

/**
 * 自律的な操作の種類。
 *  - link_case   : 案件への関連づけ（lotteries.case_id の設定）。既存の値・履歴を変えない非破壊の操作＝保護対象でも許可
 *  - change      : 値の変更（上書き・補完以外の更新）
 *  - fill_empty  : 空欄だけの補完（既存の値を変えない）。人が確定した項目（confirmed・manual_form）は対象外にしやすいよう、呼び出し側が項目を選ぶ
 *  - merge       : 他の抽選との統合（非表示化・参照の付け替えを含む）
 *  - delete      : 削除（非表示化を含む）
 *  - move_history: 応募・当落・購入などの記録の付け替え
 */
export type AutonomousOp = "link_case" | "change" | "fill_empty" | "merge" | "delete" | "move_history";

const LABEL: Record<BlockerCode, string> = {
  not_found: "抽選が見つかりません",
  confirmed: "利用者が確認済み",
  human_registered: "人が登録・確認した抽選",
  manual_form: "抽選形態を利用者が手動で分類済み",
  managed: "要チェック（★）に指定済み",
  applications: "応募・当落の記録あり",
  notifications: "通知の記録あり",
  skip: "スルーの設定あり",
  rules: "応募ルール・上限例外あり",
  memo_feedback: "メモ・AI修正の記録あり",
  user_exclusion: "利用者が重複候補から除外した記録あり",
  x_bookmark: "Xブックマークに紐づく",
};

/** 常に許可される操作（既存の値・履歴を変えない） */
const ALWAYS_ALLOWED: AutonomousOp[] = ["link_case"];
/** 「見つからない」以外のどの理由があっても、空欄補完は許可しない理由（人が確定した値の周辺） */
const FILL_BLOCKING: BlockerCode[] = ["confirmed", "manual_form", "human_registered", "not_found"];

export interface GuardDecision {
  allowed: boolean;
  /** 拒否の理由（日本語）。許可のときは空 */
  reasons: string[];
  codes: BlockerCode[];
}

export function decideAutonomousOp(op: AutonomousOp, codes: readonly string[]): GuardDecision {
  const known = codes.filter((c): c is BlockerCode => c in LABEL);
  // 未知の理由コードは安全側（拒否）。DBが新しい理由を返してもAIが素通りしないように
  const unknown = codes.filter((c) => !(c in LABEL));
  const deny = (cs: BlockerCode[], extra: string[] = []): GuardDecision => ({ allowed: false, codes: cs, reasons: [...cs.map((c) => LABEL[c]), ...extra] });
  if (ALWAYS_ALLOWED.includes(op)) return known.includes("not_found") ? deny(["not_found"]) : { allowed: true, codes: [], reasons: [] };
  if (op === "fill_empty") {
    const hit = known.filter((c) => FILL_BLOCKING.includes(c));
    return hit.length || unknown.length ? deny(hit, unknown.map((u) => `未知の保護理由（${u}）`)) : { allowed: true, codes: [], reasons: [] };
  }
  // change / merge / delete / move_history: 記録上の保護が1つでもあれば拒否
  return known.length || unknown.length ? deny(known, unknown.map((u) => `未知の保護理由（${u}）`)) : { allowed: true, codes: [], reasons: [] };
}
