"use client";

import { useCallback, useRef, useState } from "react";

type Result<T> = { ok: true; data: T } | { ok: false; error: string };

/**
 * コレクションの集計データの取得（Stage 7C）。価格・相場を更新したあとの再取得で使う。
 *  - 取得の順序を保証する: 後から始めた取得が先に反映され、遅れて届いた古い応答は捨てる（古い集計で上書きしない）
 *  - 取得中は refreshing=true（集計を薄く表示して、更新途中の値を確定表示しない）。失敗時は1回だけ取り直し、それでも失敗したら今の表示は変えずエラーを返す
 *  - 画面全体のリロードはしない。必要なデータだけを取り直す
 */
export function useLatestLoader<T>(fetcher: () => Promise<Result<T>>, onData: (d: T) => void, onError: (message: string | null) => void) {
  const seq = useRef(0);
  const [refreshing, setRefreshing] = useState(false);
  const load = useCallback(async () => {
    const my = ++seq.current;
    setRefreshing(true);
    try {
      let r = await fetcher().catch(() => null);
      if (!r || !r.ok) r = await fetcher().catch(() => null);
      if (my !== seq.current) return;
      if (r?.ok) {
        onData(r.data);
        onError(null);
      } else onError(r ? r.error : "集計を更新できませんでした。通信を確認して、もう一度お試しください");
    } finally {
      if (my === seq.current) setRefreshing(false);
    }
    // fetcher/onData/onError は呼び出し側で安定した関数を渡す
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fetcher, onData, onError]);
  return { load, refreshing };
}
