/**
 * 抽選情報の段階の分類（Stage 6B・6C・純関数）。まとめアカウントは、受付開始前の「予告」も重要な情報として投稿する。
 *   open      受付中で詳細確定（応募締切が分かり、まだ過ぎていない。開始前でない）
 *   upcoming  受付前で詳細確定（応募開始が未来で、応募締切が分かっている）
 *   teaser    抽選予告・詳細未発表（応募締切も応募開始も分からない）
 *   partial   一部だけ判明（片方の日時のみ）
 *   closed    受付終了（応募締切が過ぎている）
 * 受付前という理由だけで除外しない。詳細が確定していれば通常の登録対象、未発表なら再調査（保留・追跡）として保持する。
 * 「抽選と無関係」は AI の判定（抽選告知でない）と、予告の文言の検査（hasLotteryWording）で別に扱う。
 */
export type LotteryStage = "open" | "upcoming" | "teaser" | "partial" | "closed";
export const STAGE_LABEL: Record<LotteryStage, string> = { open: "受付中（詳細確定）", upcoming: "受付前（詳細確定）", teaser: "抽選予告（詳細未発表）", partial: "一部判明", closed: "受付終了" };

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
  if ((i.applyDeadline.date as string) < today) return "closed";
  if (startKnown && (i.applyStart!.date as string) > today) return "upcoming";
  return "open";
}

/** 告知（投稿）からの経過日数。投稿日時が無い・読み取れないときは null（古さを理由に止めない） */
export function ageDaysOf(postedAt: string | null | undefined, now: Date): number | null {
  if (!postedAt) return null;
  const t = Date.parse(postedAt);
  return Number.isFinite(t) ? Math.max(0, (now.getTime() - t) / 86_400_000) : null;
}

/** 追跡する予告の段階（受付前、または詳細未発表） */
export const isTrackableStage = (s: LotteryStage) => s === "teaser" || s === "partial" || s === "upcoming";

/**
 * 抽選の実施を示す文言があるか。単に「新商品が発売される」「入荷予定」だけの告知を、抽選予告として追跡しないための検査。
 * 抽選・当選・応募・エントリー・申込のいずれかが、告知の本文・引用元・画像から読み取った根拠の文のどこかにあること。
 */
const LOTTERY_WORDING = /抽選|当選|応募|エントリー|申込|申し込み/;
export const hasLotteryWording = (texts: (string | null | undefined)[]) => texts.some((t) => !!t && LOTTERY_WORDING.test(t.normalize("NFKC")));

/**
 * 憶測・未確定の表現（Stage 9A）。日時が未発表の告知を登録するとき、確定した抽選の告知か判断するために使う。
 * 「〜の模様」「〜かもしれません」「噂」「詳細不明」など、告知元が確定していない情報を示す表現。
 */
const SPECULATIVE = /模様|かもしれ|かも？|噂|うわさ|予想|予測|未確定|詳細不明|ではないか|と思われ|らしい|可能性があ/;
export const isSpeculative = (texts: (string | null | undefined)[]) => texts.some((t) => !!t && SPECULATIVE.test(t.normalize("NFKC")));
