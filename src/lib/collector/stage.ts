/**
 * 抽選情報の段階の分類（Stage 6B・純関数）。まとめアカウントは、受付開始前の「予告」も重要な情報として投稿する。
 *   open      受付中で詳細確定（応募締切が分かり、まだ過ぎていない。開始前でない）
 *   upcoming  受付前で詳細確定（応募開始が未来で、応募締切が分かっている）
 *   teaser    抽選予告・詳細未発表（応募締切も応募開始も分からない）
 *   partial   一部だけ判明（片方の日時のみ）
 * 受付前という理由だけで除外しない。詳細が確定していれば通常の登録対象、未発表なら再調査（保留）として保持する。
 * 「抽選と無関係」「公式情報の紹介（まとめアカウントの紹介元）」は AI の判定（抽選告知でない）と投稿者の関係で別に扱う。
 */
export type LotteryStage = "open" | "upcoming" | "teaser" | "partial";
export const STAGE_LABEL: Record<LotteryStage, string> = { open: "受付中（詳細確定）", upcoming: "受付前（詳細確定）", teaser: "抽選予告（詳細未発表）", partial: "一部判明" };

interface FlexLike {
  precision: string;
  date?: string | null;
}

export function classifyStage(i: { applyStart?: FlexLike; applyDeadline: FlexLike }, today: string): LotteryStage {
  const known = (f?: FlexLike) => !!f && f.precision !== "unknown" && !!f.date;
  const startKnown = known(i.applyStart);
  const deadlineKnown = known(i.applyDeadline);
  if (!startKnown && !deadlineKnown) return "teaser";
  if (!deadlineKnown) return "partial";
  if (startKnown && (i.applyStart!.date as string) > today) return "upcoming";
  return "open";
}
