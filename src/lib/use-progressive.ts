import { useEffect, useState } from "react";

/**
 * 一覧を段階的に描画する件数（Stage 7O）。最初の画面分（initial）だけをすぐ描画し、残りは画面が落ち着いてから少しずつ足す。
 * 件数の多い一覧（抽選が100件を超えても）で、最初の表示・保存直後の再描画で主スレッドを長く占有しないようにする。
 * resetKey（タブなど）が変わると、先頭の分から描画し直す。必要なら needed（フォーカス先の位置など）まで即座に広げる。
 */
export function useProgressiveCount(total: number, resetKey: string, opts: { initial?: number; step?: number; needed?: number } = {}): number {
  const initial = opts.initial ?? 24;
  const step = opts.step ?? 24;
  const [state, setState] = useState({ key: resetKey, n: initial });
  // キーが変わったら先頭から（レンダー中に調整する）
  const n = state.key === resetKey ? state.n : initial;
  if (state.key !== resetKey) setState({ key: resetKey, n: initial });
  const want = Math.max(n, opts.needed ?? 0);
  useEffect(() => {
    if (want >= total) return;
    // 画面の描画を優先し、空き時間（なければ短い待ち）に次の分を足す
    const w = window as unknown as { requestIdleCallback?: (cb: () => void, o?: { timeout: number }) => number; cancelIdleCallback?: (id: number) => void };
    let id: number;
    const grow = () => setState((s) => ({ key: s.key, n: Math.min(Math.max(s.n, want) + step, total) }));
    if (w.requestIdleCallback) {
      id = w.requestIdleCallback(grow, { timeout: 400 });
      return () => w.cancelIdleCallback?.(id);
    }
    id = window.setTimeout(grow, 60);
    return () => window.clearTimeout(id);
  }, [want, total, step]);
  return Math.min(want, total);
}
