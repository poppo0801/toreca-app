"use client";

import { useRouter } from "next/navigation";
import { startTransition, useEffect, useState } from "react";
import { recordClientError, takeAutoRetry, tryAutoReload } from "@/lib/client-resilience";
import { classifyError, retryDelayMs } from "@/lib/resilience";

/**
 * 画面のエラーからの自動復旧（Stage 7C）。アプリ全体のエラー画面にせず、その画面の部分だけを再取得・再描画する。
 *  1) 通信などの一時的な失敗: 少し待って自動で再取得（60秒に2回まで）
 *  2) 古い画面と新しいデプロイの不整合（JavaScriptの読み込み失敗など）: 最終手段として全画面を再読み込み。10分に1回・1日3回まで、入力中（ダイアログ表示中）は行わない
 *  3) 自動で直らなければ、操作ボタン（もう一度試す／再読み込み）を出す。通信エラーを理由にログアウトはしない
 * 表示中のデータ・選択中のプロフィールはレイアウトの状態に残るので、部分的な再描画では失われない。
 */
export function RecoverableError({ error, reset, scope }: { error: Error & { digest?: string }; reset: () => void; scope: string }) {
  const router = useRouter();
  const kind = classifyError(error);
  const [auto, setAuto] = useState<"waiting" | "gave_up">("waiting");

  useEffect(() => {
    recordClientError(error, `boundary:${scope}`);
  }, [error, scope]);

  const retry = () =>
    startTransition(() => {
      router.refresh();
      reset();
    });

  useEffect(() => {
    // 自動で直せないときの切り替えは、タイマー経由で行う（効果の中で同期的に状態を変えない）
    const giveUp = () => window.setTimeout(() => setAuto("gave_up"), 0);
    if (kind === "chunk" || kind === "skew") {
      if (tryAutoReload()) return;
      const t = giveUp();
      return () => window.clearTimeout(t);
    }
    if (!takeAutoRetry()) {
      const t = giveUp();
      return () => window.clearTimeout(t);
    }
    const t = window.setTimeout(retry, retryDelayMs(0));
    return () => window.clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [error]);

  return (
    <main role="alert" data-testid="recoverable-error" data-kind={kind} data-state={auto} className="mx-auto flex max-w-sm flex-col items-center gap-3 px-6 py-16 text-center">
      <p className="text-base font-bold">{auto === "waiting" ? "読み込み直しています…" : "画面を読み込めませんでした"}</p>
      {auto === "gave_up" && (
        <>
          <p className="text-sm text-muted-foreground">
            {kind === "chunk" || kind === "skew" ? "新しいバージョンに更新されたため、画面を読み込めませんでした。" : "通信が不安定なようです。入力したデータや選択中のユーザーは保たれています。"}
          </p>
          <div className="flex flex-wrap justify-center gap-2">
            <button type="button" onClick={retry} className="min-h-11 rounded-md bg-primary px-5 text-sm font-medium text-primary-foreground shadow-sm" data-testid="error-retry">
              もう一度試す
            </button>
            <button type="button" onClick={() => window.location.reload()} className="min-h-11 rounded-md border bg-input px-5 text-sm" data-testid="error-reload">
              アプリを再読み込み
            </button>
          </div>
        </>
      )}
    </main>
  );
}
