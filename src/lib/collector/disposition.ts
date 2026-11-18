/**
 * 収集した情報の扱いの判断（Stage 9C・純関数）。新しく見つけた情報を、次のどれにするかを1つに決めて記録する。
 *   new          新規の抽選として登録
 *   complete     既存の抽選へ不足している情報を補完（日時の補完・複数商品の追加・情報源の追加）
 *   update       既存の抽選の変更情報として更新（自動反映できるもの・提案にするものは 9B の方針）
 *   duplicate    重複として記録し、新規カードは作らない
 *   investigate  根拠が不足しているため追加調査（情報源の再確認・続報待ち）。情報不足だけを理由にした新規扱い・保留はしない
 * 既存データは変更・削除しない（判断の記録だけ）。
 */
export type DispositionKind = "new" | "complete" | "update" | "duplicate" | "investigate";

export interface Disposition {
  kind: DispositionKind;
  targetLotteryId: string | null;
  reason: string;
}

export function decideDisposition(o: {
  dups: { lotteryId: string; level: "high" | "medium"; reason: string }[];
  /** 既存の抽選に対する変更（日時・条件の違い）が検出されたか */
  changed?: boolean;
  /** 既存の抽選に商品を追加する計画（同一企画の複数商品） */
  multiProduct?: { lotteryId: string; reason: string } | null;
  /** 既存の抽選に不足（日時未確認など）があり、今回の情報で補えるか */
  fillsGap?: boolean;
  /** 抽選として認識できているか（文言・店舗・商品など） */
  recognized: boolean;
}): Disposition {
  const high = o.dups.find((d) => d.level === "high");
  const medium = o.dups.find((d) => d.level === "medium");
  if (o.multiProduct) return { kind: "complete", targetLotteryId: o.multiProduct.lotteryId, reason: o.multiProduct.reason };
  if (high) {
    if (o.changed) return { kind: "update", targetLotteryId: high.lotteryId, reason: `${high.reason}（内容に変更があります）` };
    if (o.fillsGap) return { kind: "complete", targetLotteryId: high.lotteryId, reason: `${high.reason}（不足していた情報を補います）` };
    return { kind: "duplicate", targetLotteryId: high.lotteryId, reason: high.reason };
  }
  if (medium) return { kind: "investigate", targetLotteryId: medium.lotteryId, reason: `${medium.reason}。既存データは変更せず、追加調査・続報で判断します` };
  if (!o.recognized) return { kind: "investigate", targetLotteryId: null, reason: "抽選として認識するための根拠が不足しています。追加調査します" };
  return { kind: "new", targetLotteryId: null, reason: "登録済みの抽選と同じと言える根拠がないため、新規の抽選として扱います" };
}
