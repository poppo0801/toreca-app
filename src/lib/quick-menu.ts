/**
 * 長押しクイックメニュー（Stage UI-1）の純粋なロジック。
 * 操作: 「メニュー」を長押し → 上に項目が展開 → 指を離さず上へドラッグ → 指の位置の項目をハイライト → 離すとその項目へ移動。
 * 項目の外で離したときはキャンセル（移動しない）。
 */

/** 長押しとみなす時間（ミリ秒。従来420の半分）。通常のタップ（これより短い）と区別する。タップは150ms前後が大半のため210msでも競合しない（移動12pxで長押しを取り消す） */
export const LONG_PRESS_MS = 210;
/** 長押しが成立する前に、指がこれ以上動いたら長押しをやめる（スクロールや別の操作とみなす） */
export const MOVE_CANCEL_PX = 12;
/** 項目の外側（左右）に許す余白（px）。指が横に少しずれても選択を続ける */
export const HIT_SLOP_X = 40;

export interface Box {
  left: number;
  right: number;
  top: number;
  bottom: number;
}

/**
 * 指の位置に対応する項目の番号（なければ -1）。縦は項目の範囲内、横は範囲＋余白の内側。
 * 項目どうしの隙間にいるときは、直前の項目を保つのではなく -1（離したらキャンセル）とする。
 */
export function hitQuickItem(point: { x: number; y: number }, boxes: readonly (Box | null)[], slopX = HIT_SLOP_X): number {
  for (let i = 0; i < boxes.length; i++) {
    const b = boxes[i];
    if (!b) continue;
    if (point.y >= b.top && point.y <= b.bottom && point.x >= b.left - slopX && point.x <= b.right + slopX) return i;
  }
  return -1;
}

/** 長押しの開始後、成立前に動いた距離が閾値を超えたか */
export const movedTooFar = (from: { x: number; y: number }, to: { x: number; y: number }, limit = MOVE_CANCEL_PX): boolean => Math.hypot(to.x - from.x, to.y - from.y) > limit;
