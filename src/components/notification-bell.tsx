"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import { Bell } from "lucide-react";
import { closeBookmarkAction, getRunNoticesAction } from "@/app/(app)/collection-notice-actions";
import { useApp } from "@/components/app-provider";
import { RunCounts, RunStateLabel } from "@/components/collection-result-notice";
import { ManualBanner, ManualItemSummary } from "@/components/manual-review";
import { BookmarkRow } from "@/components/bookmark-list";
import type { BookmarkView } from "@/lib/collector/bookmark-state";
import { isApplicationClosed } from "@/lib/collector/closed";
import { useMinuteNow } from "@/lib/use-minute-now";
import type { ManualItem } from "@/lib/collector/manual-items";
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { runTitle, type RunSummary } from "@/lib/collector/run-summary";
import { computeAlerts } from "@/lib/notifications";
import { cn } from "@/lib/utils";

const READ_KEY = (profileId: string) => `tcg.read.${profileId}`;

function loadRead(profileId: string): Set<string> {
  try {
    return new Set(JSON.parse(window.localStorage.getItem(READ_KEY(profileId)) ?? "[]") as string[]);
  } catch {
    return new Set();
  }
}

/**
 * アプリ内通知。要対応の抽選を1つのベルに集約する（画面上部に縦に並べない）。
 *  - バッジ = 未対応の件数（抽選単位。1応募に複数商品があっても重複計上しない）。応募・当落・購入が済むと自動で減る。
 *  - 既読 = 一覧を開いて確認した状態（端末ごと）。既読でも未対応のうちはバッジに残り、対応完了で一覧から消える。
 */
export function NotificationBell() {
  const { data, profile, now } = useApp();
  const [open, setOpen] = useState(false);
  const [read, setRead] = useState<Set<string>>(new Set());
  // 自動収集の結果の履歴（抽選の通知とは別の区画。通知を開いたときに読み込む）
  const [runs, setRuns] = useState<RunSummary[]>([]);
  // 要手動確認（自動収集で解決できなかった案件）。閉じたポップアップに関係なく、対応するまで通知に残す
  const [rawManual, setManual] = useState<ManualItem[]>([]);
  // Xブックマークの未解決（取得失敗・情報不足・要手動確認）。解決するか、利用者が「対象外」「調査終了」を選ぶまで残す
  const [bookmarks, setBookmarks] = useState<BookmarkView[]>([]);
  // 画面を開いたまま受付終了を迎えた案件は、件数・バッジからも外す
  const tick = useMinuteNow();
  const manual = rawManual.filter((i) => !isApplicationClosed({ dueAt: i.dueAt }, tick));
  const alerts = useMemo(() => computeAlerts(data, profile.id, now), [data, profile.id, now]);
  const count = alerts.length + manual.length + bookmarks.length;

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- 端末ローカルの既読状態の復元
    setRead(loadRead(profile.id));
  }, [profile.id]);

  // ホーム画面アイコンのバッジ（対応ブラウザ/PWAのみ。非対応でもアプリ内表示は動作する）
  useEffect(() => {
    const nav = navigator as Navigator & { setAppBadge?: (n?: number) => Promise<void>; clearAppBadge?: () => Promise<void> };
    try {
      if (count > 0) void nav.setAppBadge?.(count).catch(() => {});
      else void nav.clearAppBadge?.().catch(() => {});
    } catch {
      /* 非対応 */
    }
  }, [count]);

  useEffect(() => {
    let live = true;
    void getRunNoticesAction(profile.id).then((r) => {
      if (!live) return;
      setManual(r.manual ?? []);
      setBookmarks([...(r.bookmarks?.unresolved ?? []), ...(r.bookmarks?.fresh ?? []).filter((b) => b.unresolved)]);
    });
    return () => {
      live = false;
    };
  }, [open, profile.id]);

  const closeBookmark = async (id: string, kind: "excluded" | "investigation_ended") => {
    const r = await closeBookmarkAction(id, kind);
    if (r.ok) setBookmarks((s) => s.filter((b) => b.id !== id));
  };

  useEffect(() => {
    if (!open) return;
    let live = true;
    void getRunNoticesAction().then((r) => live && setRuns(r.summaries.filter((s) => !s.legacy).slice(0, 4)));
    return () => {
      live = false;
    };
  }, [open]);

  const markAllRead = useCallback(() => {
    const next = new Set([...read, ...alerts.map((a) => a.key)]);
    setRead(next);
    try {
      window.localStorage.setItem(READ_KEY(profile.id), JSON.stringify([...next].slice(-300)));
    } catch {
      /* 保存できなくても動作は継続 */
    }
  }, [alerts, profile.id, read]);

  const unread = alerts.filter((a) => !read.has(a.key)).length;

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        aria-label={count > 0 ? `通知 ${count}件の未対応` : "通知（未対応なし）"}
        data-testid="notification-bell"
        className="relative flex size-10 items-center justify-center rounded-full hover:bg-muted"
      >
        <Bell className="size-5" aria-hidden="true" />
        {count > 0 && (
          <span
            data-testid="notification-badge"
            className="absolute right-0 top-0.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-danger px-1 text-[10px] font-bold leading-none text-white"
          >
            {count > 99 ? "99+" : count}
          </span>
        )}
      </button>
      <Dialog
        open={open}
        onOpenChange={(v) => {
          setOpen(v);
          if (!v) markAllRead();
        }}
      >
        <DialogContent className="max-w-lg">
          <DialogTitle>{profile.label} の通知</DialogTitle>
          <DialogDescription>
            {count === 0 && manual.length === 0 ? "未対応の項目はありません。" : `未対応 ${count}件${unread > 0 ? `（未読 ${unread}件）` : ""}。応募・当落登録・購入が済むと自動で消えます。`}
          </DialogDescription>
          {manual.length > 0 && (
            <section className="mt-3 space-y-1.5" data-testid="manual-section">
              <ManualBanner count={manual.length} urgent={manual.some((i) => i.urgency === "today" || i.urgency === "tomorrow")} />
              <ul className="max-h-48 space-y-1.5 overflow-y-auto">
                {manual.slice(0, 6).map((it) => (
                  <li key={it.id} className="rounded-md border border-danger/40 p-1.5">
                    <ManualItemSummary it={it} />
                  </li>
                ))}
              </ul>
              <Link href="/settings/collection#manual" onClick={() => setOpen(false)} className="block text-right text-xs text-info underline" data-testid="manual-section-link">
                要手動確認の一覧へ{manual.length > 6 ? `（ほか${manual.length - 6}件）` : ""}
              </Link>
            </section>
          )}
          {bookmarks.length > 0 && (
            <section className="mt-3 space-y-1.5" data-testid="bookmark-section">
              <p className="text-sm font-semibold text-warn">⚠ 未解決のXブックマーク：{bookmarks.length}件</p>
              <ul className="max-h-48 space-y-1.5 overflow-y-auto">
                {bookmarks.map((b) => (
                  <BookmarkRow
                    key={b.id}
                    b={b}
                    actions={
                      <span className="flex gap-1.5 pl-5">
                        <button type="button" onClick={() => void closeBookmark(b.id, "excluded")} className="min-h-8 rounded-md border px-2 text-xs" data-testid="bookmark-exclude">
                          対象外
                        </button>
                        <button type="button" onClick={() => void closeBookmark(b.id, "investigation_ended")} className="min-h-8 rounded-md border px-2 text-xs" data-testid="bookmark-end">
                          調査終了
                        </button>
                      </span>
                    }
                  />
                ))}
              </ul>
            </section>
          )}
          <ul className="mt-3 space-y-1.5" data-testid="alerts-list">
            {alerts.map((a) => (
              <li key={a.key}>
                <Link
                  href={a.lotteryId ? `/lotteries?focus=${a.lotteryId}` : "/settings/masters"}
                  onClick={() => setOpen(false)}
                  className={cn("flex items-start gap-2 rounded-md border p-2 text-sm hover:bg-muted", a.urgent && "border-danger")}
                >
                  <span
                    aria-label={read.has(a.key) ? "既読" : "未読"}
                    className={cn("mt-1.5 size-2 shrink-0 rounded-full", read.has(a.key) ? "bg-transparent" : "bg-info")}
                  />
                  <span className="min-w-0">
                    <span className="block font-medium">{a.title}</span>
                    <span className="block text-xs text-muted-foreground">{a.detail}</span>
                  </span>
                </Link>
              </li>
            ))}
          </ul>
          {runs.length > 0 && (
            <section className="mt-3 space-y-1.5 border-t pt-2" data-testid="run-history">
              <h3 className="text-xs font-semibold text-muted-foreground">自動収集の結果</h3>
              {runs.map((s) => (
                <Link key={s.runId} href="/settings/collection#history" onClick={() => setOpen(false)} className="block space-y-1 rounded-md border p-2 hover:bg-muted" data-testid="run-history-row">
                  <span className="flex items-center gap-2 text-sm font-medium">
                    {runTitle(s)}
                    <RunStateLabel s={s} />
                  </span>
                  <RunCounts s={s} compact />
                </Link>
              ))}
            </section>
          )}
          <div className="mt-3 flex justify-end">
            <DialogClose className="min-h-10 rounded-md px-3 text-sm text-muted-foreground hover:bg-muted">閉じる</DialogClose>
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}
