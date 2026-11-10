"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { useApp } from "@/components/app-provider";
import { ackBookmarksShownAction, ackRunNoticesAction, getRunNoticesAction } from "@/app/(app)/collection-notice-actions";
import { BookmarkArea } from "@/components/bookmark-list";
import type { BookmarkView } from "@/lib/collector/bookmark-state";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { runTitle, type RunSummary } from "@/lib/collector/run-summary";
import { cn } from "@/lib/utils";

const SEEN_KEY = "trm.runNotice";

/** 収集結果の件数表（ポップアップ・ベル・設定の履歴で共通） */
export function RunCounts({ s, compact = false }: { s: RunSummary; compact?: boolean }) {
  const rows: [string, number, boolean][] = [
    ["発見", s.discovered, false],
    ["解析完了", s.analyzed, false],
    ["自動登録", s.autoRegistered, s.autoRegistered > 0],
    ["確認待ち", s.review, s.review > 0],
    ["取得失敗", s.failed, s.failed > 0],
    ["解析待ち", s.waiting, false],
  ];
  return (
    <dl className={cn("grid gap-x-3 gap-y-0.5 text-sm", compact ? "grid-cols-3 text-xs" : "grid-cols-2")} data-testid="run-counts" data-state={s.state}>
      {rows.map(([label, n, strong]) => (
        <div key={label} className="flex items-baseline justify-between gap-1">
          <dt className="text-muted-foreground">{label}</dt>
          <dd className={cn("tabular-nums", strong && "font-semibold")} data-testid={`run-${label}`}>
            {n}件
          </dd>
        </div>
      ))}
    </dl>
  );
}

/** 起動時ポップアップの収集結果（Stage 7M）。新しい抽選候補・自動登録・重複／除外の3つだけを簡潔に。通常の結果に警告色は使わない */
export function RunBrief({ s, fresh }: { s: RunSummary; fresh: { id: string; title: string }[] }) {
  const rows: [string, number, boolean][] = [
    ["新しい抽選候補", s.review, s.review > 0],
    ["自動登録", s.autoRegistered, false],
    ["重複・除外", s.duplicates + s.excluded, false],
  ];
  return (
    <div className="space-y-2" data-testid="run-brief">
      <dl className="space-y-1 text-sm">
        {rows.map(([label, n, strong]) => (
          <div key={label} className="flex items-baseline justify-between gap-2">
            <dt className="text-muted-foreground">{label}</dt>
            <dd className={cn("tabular-nums", strong && "font-semibold")} data-testid={`brief-${label}`}>
              {n}件
            </dd>
          </div>
        ))}
      </dl>
      {fresh.length > 0 && (
        <ul className="space-y-0.5 border-t pt-1.5 text-xs" data-testid="brief-fresh">
          {fresh.map((c) => (
            <li key={c.id} className="truncate">
              ・{c.title}
            </li>
          ))}
          {s.review > fresh.length && <li className="text-muted-foreground">ほか {s.review - fresh.length}件</li>}
        </ul>
      )}
      {s.failed > 0 && <p className="text-[11px] text-muted-foreground">取得できなかった情報 {s.failed}件（自動で再取得します）</p>}
    </div>
  );
}

export function RunStateLabel({ s }: { s: RunSummary }) {
  if (s.legacy) return <span className="text-[11px] text-muted-foreground">旧形式（内訳なし）</span>;
  if (s.state === "processing") return <span className="rounded bg-info/15 px-1.5 text-[11px] font-medium text-info" data-testid="run-processing">処理中</span>;
  if (s.state === "failed") return <span className="rounded bg-danger/15 px-1.5 text-[11px] font-medium text-danger">失敗</span>;
  return <span className="text-[11px] text-muted-foreground">完了</span>;
}

/**
 * 起動時の収集結果ポップアップ。定期収集（6時・18時など）の最新の1回の結果だけを、その収集のあと最初にアプリを開いたときに1回だけ表示する。
 * 確認済みの記録（collection_run_acks）はサーバー側で表示と同時に付けるので、以後は開くたびには出ない。
 * 以前の結果と要手動確認は出さない（通知のベル・設定の自動収集で確認できる）。解析の途中の結果は完了まで待つ。
 * 表示対象は、収集設定に固定IDで指定されたプロフィール（はとむぎ）だけ。他のプロフィールでは取得も表示もしない（判定はサーバー側）。
 * ボタンは「確認する」（要手動確認の一覧へ）と「閉じる」だけ。画面遷移は確認済みの記録の完了を待たない。
 */
export function CollectionResultNotice() {
  const router = useRouter();
  const { profile } = useApp();
  const [notice, setNotice] = useState<RunSummary | null>(null);
  const [fresh, setFresh] = useState<{ id: string; title: string }[]>([]);
  /** Xブックマーク（最上部の専用エリア）。新規は個別にすべて表示し、未解決は解決するまで残る */
  const [bm, setBm] = useState<{ fresh: BookmarkView[]; unresolved: BookmarkView[]; syncIssue: string | null } | null>(null);

  useEffect(() => {
    let live = true;
    void getRunNoticesAction(profile.id).then((r) => {
      if (!live) return;
      // 確認済みの記録は表示した時点（表示しないと判断した古い結果も含む）で行う。ボタンを押した後だと、アプリを閉じただけで毎回出てしまう
      if (r.ackIds.length > 0) void ackRunNoticesAction(r.ackIds);
      const b = r.bookmarks;
      const fresh = b?.fresh ?? [];
      // ブックマークの新規が無く、収集結果も無ければ何も出さない（未解決だけの場合は、通知のベルに残る）
      if (!r.notice && fresh.length === 0) return;
      // 同じ起動中の再描画では繰り返さない（確認済みの反映が間に合わない場合の保険）
      const key = r.notice ? `${r.notice.runId}:${fresh.map((x) => x.id).join(",")}` : `bm:${fresh.map((x) => x.id).join(",")}`;
      try {
        if (window.sessionStorage.getItem(SEEN_KEY) === key) return;
        window.sessionStorage.setItem(SEEN_KEY, key);
      } catch {
        /* 保存できなくても動作は継続 */
      }
      if (b && b.shownIds.length > 0) void ackBookmarksShownAction(b.shownIds);
      if (b) setBm({ fresh, unresolved: b.unresolved, syncIssue: b.syncIssue });
      setNotice(r.notice);
      setFresh(r.newCandidates ?? []);
    });
    return () => {
      live = false;
    };
  }, [profile.id]);

  const close = () => {
    setNotice(null);
    setBm(null);
  };
  /** 抽選候補を確認: ポップアップをすぐ閉じて、抽選候補ページへ移る */
  const confirm = () => {
    close();
    router.push("/lotteries/candidates");
  };
  if (!notice && !bm) return null;
  const s = notice;
  return (
    <Dialog open onOpenChange={(v) => !v && close()}>
      <DialogContent className="max-h-[85dvh] max-w-sm space-y-3 overflow-y-auto" data-testid="run-notice">
        {/* 最上部: Xブックマーク（収集結果より先に表示する） */}
        {bm && <BookmarkArea fresh={bm.fresh} unresolved={bm.unresolved} syncIssue={bm.syncIssue} />}
        <DialogTitle className="flex items-center gap-2">
          {s ? runTitle(s) : "Xブックマーク"}
          {s && <RunStateLabel s={s} />}
        </DialogTitle>
        <DialogDescription className="sr-only">自動収集の結果の要約</DialogDescription>
        {s && <RunBrief s={s} fresh={fresh} />}
        <div className="flex justify-end gap-2 pt-1">
          <button type="button" onClick={close} className="min-h-10 rounded-md px-4 text-sm text-muted-foreground hover:bg-muted" data-testid="run-notice-close">
            閉じる
          </button>
          <button type="button" onClick={confirm} className="min-h-10 rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground" data-testid="run-notice-confirm">
            抽選候補を確認
          </button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
