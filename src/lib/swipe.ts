/**
 * スワイプ操作の判定（純関数）。抽選画面は縦スクロールが非常に多いので、縦スクロールを横スワイプと誤判定しないことを最優先にする。
 *  1) 指を置いてから LOCK_PX 動くまでは「未確定」。この間は何も変えない（タップ・縦スクロールの開始を妨げない）。
 *  2) 動いた方向で軸を一度だけ確定する。横が縦の DOMINANCE 倍以上のときだけ「横」、そうでなければ「縦」（縦ならスワイプは以後無視）。
 *  3) 横に確定してから、離した位置が COMMIT_PX（またはカード幅の COMMIT_RATIO）以上動いていれば確定。足りなければ元に戻す。
 *  4) 指を離す前に状態を変えない。確定後の連続操作・通信中の重複は呼び出し側で止める。
 */
export const SWIPE = {
  /** 軸を判定する最小の移動量(px) */
  LOCK_PX: 10,
  /** 横移動が縦移動のこの倍数以上なら横スワイプ */
  DOMINANCE: 1.8,
  /** 確定に必要な横移動(px)。カード幅が広いときは COMMIT_RATIO のほうを使う */
  COMMIT_PX: 72,
  COMMIT_RATIO: 0.25,
  /** 見た目の最大移動量(px) */
  MAX_PULL_PX: 132,
  /** 確定後、次のスワイプを受け付けない時間(ms)。連続スワイプ対策 */
  COOLDOWN_MS: 450,
} as const;

export type SwipeAxis = "pending" | "horizontal" | "vertical";
export type SwipeDirection = "left" | "right";

/** 開始位置からの移動量(dx, dy)から軸を判定する。LOCK_PX に届くまでは pending */
export function classifyAxis(dx: number, dy: number): SwipeAxis {
  const ax = Math.abs(dx);
  const ay = Math.abs(dy);
  if (ax < SWIPE.LOCK_PX && ay < SWIPE.LOCK_PX) return "pending";
  return ax >= ay * SWIPE.DOMINANCE ? "horizontal" : "vertical";
}

/** 離した位置で確定するか。確定するなら方向、足りなければ null（元に戻す） */
export function commitDirection(dx: number, width: number): SwipeDirection | null {
  const need = Math.min(SWIPE.COMMIT_PX, Math.max(48, width * SWIPE.COMMIT_RATIO));
  if (Math.abs(dx) < need) return null;
  return dx > 0 ? "right" : "left";
}

/** カードの見た目の移動量（指に追従しつつ、端に近づくほど重くする） */
export function pullOffset(dx: number): number {
  const sign = dx < 0 ? -1 : 1;
  const a = Math.abs(dx);
  const eased = a <= SWIPE.COMMIT_PX ? a : SWIPE.COMMIT_PX + (a - SWIPE.COMMIT_PX) * 0.35;
  return sign * Math.min(eased, SWIPE.MAX_PULL_PX);
}
