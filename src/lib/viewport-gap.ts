/**
 * iOS のホーム画面アプリ（standalone）で、起動直後だけ window.innerHeight が実際の画面より Safe Area(上)の分だけ低いことがある
 * （実機の診断: innerHeight=793 / 100vh=852 / 100dvh=793 / safe-top=59）。`position: fixed; bottom: 0` はこの低い表示領域の下端に置かれ、
 * 画面の下に空白ができる。操作すると表示領域が更新されて正常に戻る。
 * 100vh（大きい表示領域）と innerHeight の差を測り、固定要素の bottom をその分だけ下げて、実際の画面の下端に合わせる。
 * Safari のタブ（ツールバーあり）では 100vh と innerHeight の差は正常な状態なので、standalone のときだけ補正する。
 */
export const MAX_GAP_PX = 120;

export function viewportGap(vh100: number, innerHeight: number, standalone: boolean): number {
  if (!standalone) return 0;
  const gap = Math.round(vh100 - innerHeight);
  // 実機の差は Safe Area(上)の高さ(約47〜59px)。極端な値（デスクトップの開発者ツールなど）は補正しない
  return gap > 0 && gap <= MAX_GAP_PX ? gap : 0;
}
