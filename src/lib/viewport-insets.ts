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

/** 補正値を採用するために、同じ値が続く必要があるフレーム数（約0.17秒）。オーバースクロールのバウンス中は毎フレーム値が変わるので採用されない */
export const SHIFT_STABLE_FRAMES = 10;

export interface ShiftState {
  /** 直近の測定値 */
  raw: number;
  /** raw が同じ値で続いたフレーム数 */
  same: number;
  /** 実際に CSS へ反映している値 */
  applied: number;
}

/**
 * --vv-shift に反映する値を決める（過剰補正の防止）。
 * 最下部・最上部のオーバースクロール（ゴム紐のバウンス）中も visualViewport.offsetTop は動くが、これは「ずれたまま残った」状態ではなく一時的な動き。
 * ここで補正すると下部メニューがバウンスの分だけ浮き上がる。そこで:
 *  - 指が触れている間は更新しない（現在値のまま）
 *  - 0 に戻った測定値はすぐ採用（通常の位置は安全）
 *  - 0 以外の値は、SHIFT_STABLE_FRAMES 連続で同じ値になったときだけ採用（キーボードを閉じたあとに残る静的なずれだけが対象）
 */
export function stabilizeShift(prev: ShiftState, raw: number, touching: boolean): ShiftState {
  if (touching) return { raw, same: 0, applied: prev.applied };
  const same = raw === prev.raw ? prev.same + 1 : 1;
  if (raw === 0) return { raw, same, applied: 0 };
  return { raw, same, applied: same >= SHIFT_STABLE_FRAMES ? raw : prev.applied };
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

/** 指が触れている状態の有効期間(ms)。touchend/touchcancel を取りこぼしても（アラート・システムジェスチャー・バックグラウンド移行）、これを過ぎたら離れたものとして扱う */
export const TOUCH_STALE_MS = 1500;
/**
 * 「触れている」と見なすか。以前は touchend を取りこぼすと触れたままの扱いが残り、補正値（--vv-shift）が更新されず、
 * 下部メニューが途切れたまま固定される危険があった。最後のタッチイベントから TOUCH_STALE_MS を過ぎたら触れていない扱いにする。
 */
export function isTouchingNow(flag: boolean, lastTouchAt: number, now: number): boolean {
  return flag && now - lastTouchAt < TOUCH_STALE_MS;
}
