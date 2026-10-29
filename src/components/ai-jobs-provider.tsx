"use client";

import Link from "next/link";
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { X } from "lucide-react";
import { IS_SUPABASE_MODE } from "@/lib/data-source";
import { completionMessage, isActive, needsAttention, type JobSummary } from "@/lib/ai-job";

/**
 * AI一括解析のジョブの状態（サーバーに保存されたもの）を、アプリ全体で共有する。
 *  - 画面を移動・再読み込みしても、サーバーの状態から復元される。
 *  - 解析が進行中の間だけ短い間隔で確認し、待機中の項目があれば解析の続きを促す（アプリを開いたとき自動で再開）。
 *  - 解析が完了して未確認のジョブがあれば、アプリ内に小さな通知（トースト）を出す。タップで結果の確認画面へ。
 */
interface Ctx {
  jobs: JobSummary[];
  /** 完了して、まだ結果を確認していないジョブの数 */
  unseen: number;
  /** 月間予算に達していて、待機中の解析を始められない */
  blocked: boolean;
  refresh: () => Promise<void>;
}
const AiJobsContext = createContext<Ctx>({ jobs: [], unseen: 0, blocked: false, refresh: async () => undefined });
export const useAiJobs = () => useContext(AiJobsContext);

const POLL_ACTIVE_MS = 4000;
const NOTIFIED_KEY = "tcg.aijobs.notified";

function readNotified(): Record<string, string> {
  try {
    return JSON.parse(window.localStorage.getItem(NOTIFIED_KEY) ?? "{}") as Record<string, string>;
  } catch {
    return {};
  }
}

export function AiJobsProvider({ children }: { children: React.ReactNode }) {
  const [jobs, setJobs] = useState<JobSummary[]>([]);
  const [blocked, setBlocked] = useState(false);
  const [toast, setToast] = useState<JobSummary | null>(null);
  const lastKick = useRef(0);
  const alive = useRef(true);

  const kick = useCallback(async () => {
    // 待機中の項目の解析を進める。短時間に何度も呼ばない（呼ばれても二重実行にはならない）
    if (Date.now() - lastKick.current < 15_000) return;
    lastKick.current = Date.now();
    try {
      await fetch("/api/ai-jobs/process", { method: "POST" });
    } catch {
      /* 次の確認で再試行 */
    }
  }, []);

  const refresh = useCallback(async () => {
    if (!IS_SUPABASE_MODE) return;
    try {
      const res = await fetch("/api/ai-jobs", { cache: "no-store" });
      if (!res.ok) return;
      const j = (await res.json()) as { ok: boolean; jobs?: JobSummary[]; blocked?: boolean; pending?: boolean };
      if (!alive.current || !j.ok || !j.jobs) return;
      setJobs(j.jobs);
      setBlocked(j.blocked === true);
      if (j.pending && !j.blocked) void kick();
      // 完了の通知: 解析が終わって未確認のジョブを、状態ごとに1回だけ知らせる
      const seen = readNotified();
      const next = j.jobs.find((x) => needsAttention(x) && seen[x.id] !== x.status);
      if (next) {
        try {
          window.localStorage.setItem(NOTIFIED_KEY, JSON.stringify({ ...seen, [next.id]: next.status }));
        } catch {
          /* 保存できなくても通知は出す */
        }
        setToast(next);
      }
    } catch {
      /* 通信エラーは次の確認で */
    }
  }, [kick]);

  const active = jobs.some((j) => isActive(j.status));
  useEffect(() => {
    alive.current = true;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- 外部（サーバー）の状態の取得
    void refresh();
    const onVisible = () => document.visibilityState === "visible" && void refresh();
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      alive.current = false;
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [refresh]);
  useEffect(() => {
    if (!active) return;
    const t = window.setInterval(() => void refresh(), POLL_ACTIVE_MS);
    return () => window.clearInterval(t);
  }, [active, refresh]);

  const value = useMemo<Ctx>(() => ({ jobs, unseen: jobs.filter(needsAttention).length, blocked, refresh }), [jobs, blocked, refresh]);

  return (
    <AiJobsContext.Provider value={value}>
      {children}
      {toast && (
        <div role="status" data-testid="ai-job-toast" className="fixed inset-x-3 bottom-[calc(3.25rem+env(safe-area-inset-bottom)+0.5rem-var(--vp-gap,0px))] z-40 flex items-center gap-2 rounded-xl border border-primary bg-card px-3 py-2 text-sm shadow-[var(--shadow-sheet)] md:left-auto md:right-6 md:w-96">
          <span className="size-2 shrink-0 rounded-full bg-primary" aria-hidden="true" />
          <span className="min-w-0 flex-1">{completionMessage(toast)}</span>
          <Link href={`/lotteries/bulk?job=${toast.id}`} onClick={() => setToast(null)} className="shrink-0 text-xs font-bold text-primary underline" data-testid="ai-job-toast-link">
            結果を確認
          </Link>
          <button type="button" onClick={() => setToast(null)} aria-label="通知を閉じる" className="flex size-8 shrink-0 items-center justify-center text-muted-foreground">
            <X className="size-4" aria-hidden="true" />
          </button>
        </div>
      )}
    </AiJobsContext.Provider>
  );
}
