import { useCallback, useRef, useState } from "react";

/**
 * 非同期の操作（保存・応募・削除など）の二重実行を防ぐ。実行中は busy=true（ボタンを無効にする）で、
 * 実行中の再呼び出しは無視する（state の更新前に連続して呼ばれても、ref で確実に止める）。
 */
export function useBusy(): [busy: boolean, run: <T>(fn: () => Promise<T>) => Promise<T | undefined>] {
  const [busy, setBusy] = useState(false);
  const flag = useRef(false);
  const run = useCallback(async <T,>(fn: () => Promise<T>): Promise<T | undefined> => {
    if (flag.current) return undefined;
    flag.current = true;
    setBusy(true);
    try {
      return await fn();
    } finally {
      flag.current = false;
      setBusy(false);
    }
  }, []);
  return [busy, run];
}
