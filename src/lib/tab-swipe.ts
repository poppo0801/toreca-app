import { classifyAxis } from "@/lib/swipe";

/**
 * 抽選管理のタブ切替スワイプ（Stage 7B・純関数）。左スワイプ（指が左へ）で次のタブ、右スワイプで前のタブ。端のタブではそれ以上動かない。
 * 縦スクロールとの誤判定は、カードのスワイプと同じ軸判定（classifyAxis）を使う。
 */
export const TAB_SWIPE = {
  /** 確定に必要な横移動(px)。画面幅が広いときは幅の割合を使う */
  COMMIT_PX: 64,
  COMMIT_RATIO: 0.2,
  /** iOSの戻るジェスチャー・ホームバーと競合しないよう、画面の左右端からこの幅(px)以内で始まった操作は使わない */
  EDGE_PX: 28,
  /** この時間(ms)より長くかかった操作（ゆっくりした移動・長押しからの移動）はタブ切替にしない */
  MAX_MS: 900,
} as const;

export type TabDirection = "next" | "prev";

/** 現在のタブから、スワイプ方向の隣のタブ。端なら null */
export function adjacentTab<T>(order: readonly T[], current: T, dir: TabDirection): T | null {
  const i = order.indexOf(current);
  if (i < 0) return null;
  return order[dir === "next" ? i + 1 : i - 1] ?? null;
}

/** 画面の左右の端から始まった操作か（iOSの戻る操作など、システムのジェスチャーに任せる） */
export function startsAtEdge(x: number, viewportWidth: number): boolean {
  return x <= TAB_SWIPE.EDGE_PX || x >= viewportWidth - TAB_SWIPE.EDGE_PX;
}

/** 指を離したときの判定。タブ切替にする方向、または null（何もしない） */
export function tabSwipeDirection(dx: number, dy: number, viewportWidth: number, elapsedMs: number): TabDirection | null {
  if (elapsedMs > TAB_SWIPE.MAX_MS) return null;
  if (classifyAxis(dx, dy) !== "horizontal") return null;
  const need = Math.max(TAB_SWIPE.COMMIT_PX, viewportWidth * TAB_SWIPE.COMMIT_RATIO * 0.5);
  if (Math.abs(dx) < need) return null;
  return dx < 0 ? "next" : "prev";
}

/** 横スクロールできる要素（表・カルーセルなど）の中で始まった操作か。その要素のスクロールを優先する */
export function inHorizontalScroller(el: Element | null, stop: Element | null = null): boolean {
  for (let n: Element | null = el; n && n !== stop && n !== document.body; n = n.parentElement) {
    if (n.scrollWidth <= n.clientWidth + 1) continue;
    const ox = getComputedStyle(n).overflowX;
    if (ox === "auto" || ox === "scroll") return true;
  }
  return false;
}
