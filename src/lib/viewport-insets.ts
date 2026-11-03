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

/**
 * 見えている領域の下端と、レイアウト上の下端(innerHeight)のずれ（--vv-shift。符号あり）。
 * iOS はキーボードを閉じたあとも visualViewport の位置・高さが古いまま残ることがあり、position:fixed（レイアウト上の下端が基準）の
 * 下部メニューが、実際に見える下端より上に浮いたり下へはみ出して途切れる。固定要素の bottom をこの分だけ動かし、常に見える下端へ合わせる。
 * 入力欄を編集中（キーボード表示中）は0（メニューはキーボードの下に隠れてよく、ボトムシートは --kb-inset で上げる）。
 * ピンチ拡大中・極端な値は0。
 */
export function visualShift(innerHeight: number, vv: { height: number; offsetTop: number; scale: number } | null, editing: boolean): number {
  if (!vv || editing || Math.abs(vv.scale - 1) > 0.01) return 0;
  const shift = Math.round(vv.offsetTop + vv.height - innerHeight);
  return Math.abs(shift) >= 2 && Math.abs(shift) <= innerHeight * 0.5 ? shift : 0;
}

/** 文字を入力できる要素にフォーカスがあるか（iOS のキーボードが出ている状態の目安） */
export function isEditingElement(el: Element | null): boolean {
  if (!el) return false;
  const tag = el.tagName;
  if (tag === "TEXTAREA" || tag === "SELECT") return true;
  if (tag === "INPUT") return !["checkbox", "radio", "button", "submit", "reset", "file", "range", "color", "image"].includes((el as HTMLInputElement).type);
  return (el as HTMLElement).isContentEditable === true;
}

/** 起動直後〜操作直後など、表示領域が後から変わる場面で、フレームごとに測り直す期間(ms) */
export const SETTLE_MS = 4000;
