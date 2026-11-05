/**
 * 除外済み候補のアーカイブ規則（Stage 6G・純関数）。候補は削除せず、通常の一覧から隠すだけ。
 *   明確な重複・応募期限終了・地域対象外 … 即時 / 自動除外・手動除外 … 3日後
 * 理由の種類は、除外時に記録した理由の文言から判定する（追加の列は持たない）。アーカイブ済みでも、管理画面から確認・再評価できる。
 * 同じ抽選の再掲載は、候補の識別キー（投稿ID・URL）が残っているため、新規の確認待ちを作らない。
 */
export type ArchiveReason = "duplicate" | "expired" | "region" | "auto" | "manual";

export const ARCHIVE_LABEL: Record<ArchiveReason, string> = { duplicate: "重複", expired: "応募期限終了", region: "地域対象外", auto: "自動除外", manual: "手動除外" };
/** 自動除外・手動除外を通常の一覧に残す日数 */
export const ARCHIVE_DELAY_DAYS = 3;
const USER_EXCLUDED_TEXT = "利用者が除外しました";

export interface ArchivableRow {
  status: string;
  reasons: string[];
  resolved_at: string | null;
}

/** 除外・重複の候補の理由の種類。対象外の状態（確認待ち・登録済みなど）は null */
export function archiveReasonOf(c: Pick<ArchivableRow, "status" | "reasons">): ArchiveReason | null {
  if (c.status === "duplicate") return "duplicate";
  if (c.status !== "excluded") return null;
  const text = (c.reasons ?? []).join("／");
  if (text.includes(USER_EXCLUDED_TEXT)) return "manual";
  if (/応募締切を過ぎています|受付終了|締切を過ぎ/.test(text)) return "expired";
  if (/対象外の地域/.test(text)) return "region";
  return "auto";
}

/** 通常の一覧から隠すか。除外時刻が不明な「自動／手動」は、すぐには隠さない（時刻から判断できないため） */
export function isArchived(c: ArchivableRow, now: Date): boolean {
  const r = archiveReasonOf(c);
  if (!r) return false;
  if (r === "duplicate" || r === "expired" || r === "region") return true;
  if (!c.resolved_at) return false;
  return now.getTime() - new Date(c.resolved_at).getTime() >= ARCHIVE_DELAY_DAYS * 86_400_000;
}

/** 将来の設定変更（対象地域・収集条件）で再評価できる種類 */
export const isReevaluable = (r: ArchiveReason | null): boolean => r === "region" || r === "auto";

export function archiveCounts(rows: ArchivableRow[], now: Date): { total: number; byReason: Record<ArchiveReason, number> } {
  const byReason: Record<ArchiveReason, number> = { duplicate: 0, expired: 0, region: 0, auto: 0, manual: 0 };
  let total = 0;
  for (const c of rows) {
    if (!isArchived(c, now)) continue;
    const r = archiveReasonOf(c);
    if (r) {
      byReason[r]++;
      total++;
    }
  }
  return { total, byReason };
}
