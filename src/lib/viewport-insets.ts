/**
 * iPhone の表示領域まわりの純粋な計算。
 *  - 画面下のキーボードが隠している高さ（--kb-inset）: レイアウト上の高さ(innerHeight)のうち、見えている領域(visualViewport)の外にある下側。
 *    ボトムシートの bottom をこの分だけ上げ、保存ボタンなどをキーボードの上に出す。ピンチ拡大中(scale≠1)は値が意味を持たないので 0。
 */
export function keyboardInset(innerHeight: number, vv: { height: number; offsetTop: number; scale: number } | null): number {
  if (!vv || Math.abs(vv.scale - 1) > 0.01) return 0;
  const inset = Math.round(innerHeight - vv.height - vv.offsetTop);
  // 小さな差（丸め・ツールバーの出入り）は無視する。極端に大きい値も採用しない
  return inset > 40 && inset < innerHeight * 0.7 ? inset : 0;
}

/** 起動直後〜操作直後など、表示領域が後から変わる場面で、フレームごとに測り直す期間(ms) */
export const SETTLE_MS = 4000;
