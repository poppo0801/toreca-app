"use client";

import { usePathname } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import { useApp } from "@/components/app-provider";
import { BUILD_ID, hasUnsavedInput, markResume, recordClientError, startLifecycleTracking, touchLifecycle, tryAutoReload } from "@/lib/client-resilience";
import { IS_SUPABASE_MODE } from "@/lib/data-source";
import { resumeAction } from "@/lib/resilience";

/**
 * iPhoneのホーム画面アプリを別のアプリから戻したときの安定化（Stage 7C）。画面は作り直さず、必要なものだけを静かに更新する。
 *  - バックグラウンドから戻ったとき: 30秒以上離れていたら、データだけを再取得（失敗しても通知を出さない。切断中は復帰を待つ）。タブ・プロフィール・フィルター・スクロール・開いた画面はそのまま
 *  - 画面側のエラー（読み込み失敗・古いJavaScript）を記録。新しいバージョンのデプロイを検出したら、小さな通知を出し、次の画面移動のときに（入力中でなければ）自然に切り替える。利用中の画面を突然リロードしない
 */
export function ResilienceWatcher() {
  const { reload } = useApp();
  const pathname = usePathname();
  const hiddenAt = useRef<number | null>(null);
  const lastLoad = useRef(0);
  const busy = useRef(false);
  const waitingOnline = useRef(false);
  const reloadRef = useRef(reload);
  const [stale, setStale] = useState(false);
  const staleRef = useRef(false);
  useEffect(() => {
    staleRef.current = stale;
  }, [stale]);
  useEffect(() => {
    reloadRef.current = reload;
    if (lastLoad.current === 0) lastLoad.current = Date.now();
  });

  const checkVersion = useCallback(async () => {
    if (!IS_SUPABASE_MODE || BUILD_ID === "dev") return;
    try {
      const res = await fetch("/api/version", { cache: "no-store" });
      if (!res.ok) return;
      const j = (await res.json()) as { build?: string };
      if (j.build && j.build !== "dev" && j.build !== BUILD_ID) setStale(true);
    } catch {
      /* 確認できなければ次の機会に */
    }
  }, []);

  // 前回の終わり方（表示中に終了／バックグラウンドで破棄）の検出と、状態の記録
  useEffect(() => startLifecycleTracking(() => window.location.pathname), []);
  useEffect(() => touchLifecycle(), [pathname]);

  const resumed = useCallback(async (force = false) => {
    // force: 切断中に復帰して待っていた場合（接続が戻ったので、離れていた時間にかかわらず取得する）
    const hiddenMs = force ? Number.POSITIVE_INFINITY : hiddenAt.current ? Date.now() - hiddenAt.current : 0;
    hiddenAt.current = null;
    markResume();
    const action = resumeAction({ hiddenMs, sinceLastLoadMs: Date.now() - lastLoad.current, online: navigator.onLine, loading: busy.current });
    if (action === "wait-online") waitingOnline.current = true;
    if (action !== "refresh") return;
    // 設定・マスター管理などの画面は、開くたびに自分のデータを取得している。復帰のたびに全データを取り直さない
    if (window.location.pathname.startsWith("/settings")) return;
    busy.current = true;
    try {
      const d = await reloadRef.current({ silent: true });
      if (d) lastLoad.current = Date.now();
    } finally {
      busy.current = false;
    }
    void checkVersion();
  }, [checkVersion]);

  useEffect(() => {
    const onVis = () => {
      if (document.visibilityState === "hidden") hiddenAt.current = Date.now();
      else void resumed();
    };
    const onShow = (e: PageTransitionEvent) => {
      if (e.persisted) void resumed(); // 戻る/進むのキャッシュ（bfcache）や凍結からの復帰
    };
    const onOnline = () => {
      if (waitingOnline.current) {
        waitingOnline.current = false;
        void resumed(true);
      }
    };
    const onError = (e: ErrorEvent) => {
      const kind = recordClientError(e.error ?? e.message, "error");
      if (kind === "chunk" || kind === "skew") setStale(true);
    };
    const onRejection = (e: PromiseRejectionEvent) => {
      const kind = recordClientError(e.reason, "unhandledrejection");
      if (kind === "chunk" || kind === "skew") setStale(true);
    };
    document.addEventListener("visibilitychange", onVis);
    window.addEventListener("pageshow", onShow);
    window.addEventListener("online", onOnline);
    window.addEventListener("error", onError);
    window.addEventListener("unhandledrejection", onRejection);
    return () => {
      document.removeEventListener("visibilitychange", onVis);
      window.removeEventListener("pageshow", onShow);
      window.removeEventListener("online", onOnline);
      window.removeEventListener("error", onError);
      window.removeEventListener("unhandledrejection", onRejection);
    };
  }, [resumed]);

  // 新しいバージョンへの切り替え: 次の画面移動のときに、入力中でなければ自然に行う（回数制限あり）
  const first = useRef(true);
  useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    // 画面を移動したそのときだけ判断する（通知を出した直後には切り替えない）
    if (staleRef.current && !hasUnsavedInput()) tryAutoReload();
  }, [pathname]);

  if (!stale) return null;
  return (
    <div role="status" data-testid="update-banner" className="fixed inset-x-3 bottom-[calc(3.25rem_+_env(safe-area-inset-bottom)_+_0.5rem)] z-40 flex items-center gap-2 rounded-xl border border-primary bg-card px-3 py-2 text-sm shadow-[var(--shadow-sheet)] md:left-auto md:right-6 md:w-96">
      <span className="size-2 shrink-0 rounded-full bg-primary" aria-hidden="true" />
      <span className="min-w-0 flex-1">新しいバージョンがあります</span>
      <button type="button" onClick={() => window.location.reload()} className="shrink-0 text-xs font-bold text-primary-ink underline" data-testid="update-reload">
        更新
      </button>
    </div>
  );
}
