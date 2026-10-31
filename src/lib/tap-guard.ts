import { useMemo } from "react";

/**
 * 表示切替・フィルターなど「同じ操作の誤った連続発火」を抑える短い間隔の門。
 * 通すのは最初の1回だけで、ms 以内の次の呼び出しは無視する（タップの二重発火・指の迷い・遅れて見えるUIへの再タップ対策）。
 * アプリ全体に一律には掛けず、切替系のボタンごとに使う。保存・送信は busy 中の無効化（useBusy）で守る。
 */
export function createTapGate(ms = 300, now: () => number = () => performance.now()) {
  let last = -Infinity;
  return function pass(): boolean {
    const t = now();
    if (t - last < ms) return false;
    last = t;
    return true;
  };
}

/** ボタンごとに1つ。`const gate = useTapGate(); onClick={() => gate() && toggle()}` */
export function useTapGate(ms = 300): () => boolean {
  return useMemo(() => createTapGate(ms), [ms]);
}
