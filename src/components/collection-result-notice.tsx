"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { ackRunNoticesAction, getRunNoticesAction } from "@/app/(app)/collection-notice-actions";
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

export function RunStateLabel({ s }: { s: RunSummary }) {
  if (s.legacy) return <span className="text-[11px] text-muted-foreground">旧形式（内訳なし）</span>;
  if (s.state === "processing") return <span className="rounded bg-info/15 px-1.5 text-[11px] font-medium text-info" data-testid="run-processing">処理中</span>;
  if (s.state === "failed") return <span className="rounded bg-danger/15 px-1.5 text-[11px] font-medium text-danger">失敗</span>;
  return <span className="text-[11px] text-muted-foreground">完了</span>;
}

/**
 * 起動時の収集結果ポップアップ。新しい結果（新規登録・確認が必要な候補・取得エラー）があるときだけ、1回表示する。
 * 確認（閉じる・移動）した結果は繰り返し表示しない。処理中の結果は「処理中」と表示し、確認済みにはしない。
 * 履歴は通知（ベル）と、設定の自動収集から確認できる。
 */
export function CollectionResultNotice() {
  const [notice, setNotice] = useState<{ s: RunSummary; ackIds: string[] } | null>(null);

  useEffect(() => {
    let live = true;
    void getRunNoticesAction().then((r) => {
      if (!live || !r.notice) return;
      let seen = "";
      try {
        seen = window.sessionStorage.getItem(SEEN_KEY) ?? "";
      } catch {
        /* 保存できなくても動作は継続 */
      }
      const stamp = `${r.notice.runId}:${r.notice.state}`;
      if (seen === stamp) return; // この起動中に表示済み（処理中のまま繰り返さない）
      try {
        window.sessionStorage.setItem(SEEN_KEY, stamp);
      } catch {
        /* noop */
      }
      setNotice({ s: r.notice, ackIds: r.ackIds });
    });
    return () => {
      live = false;
    };
  }, []);

  const close = () => {
    if (notice && notice.ackIds.length > 0) void ackRunNoticesAction(notice.ackIds);
    setNotice(null);
  };
  if (!notice) return null;
  const s = notice.s;
  const processing = s.state === "processing";
  return (
    <Dialog open onOpenChange={(v) => !v && close()}>
      <DialogContent className="max-w-sm space-y-3" data-testid="run-notice">
        <DialogTitle className="flex items-center gap-2">
          {runTitle(s)}
          <RunStateLabel s={s} />
        </DialogTitle>
        <DialogDescription className="sr-only">自動収集の結果の要約</DialogDescription>
        {processing && <p className="text-xs text-muted-foreground">解析の途中です。数字は途中経過で、最終結果ではありません。</p>}
        <RunCounts s={s} />
        {(s.excluded > 0 || s.duplicates > 0 || s.costJpy > 0) && (
          <p className="text-[11px] text-muted-foreground">
            対象外 {s.excluded}件・重複 {s.duplicates}件・AI費用 約{s.costJpy}円
          </p>
        )}
        <div className="flex flex-wrap justify-end gap-1.5 pt-1">
          <button type="button" onClick={close} className="min-h-9 rounded-md px-3 text-sm text-muted-foreground hover:bg-muted" data-testid="run-notice-close">
            閉じる
          </button>
          <Link href="/settings/collection#history" onClick={close} className="flex min-h-9 items-center rounded-md border px-3 text-sm hover:bg-muted" data-testid="run-notice-detail">
            詳細
          </Link>
          {s.autoRegistered > 0 && (
            <Link href="/lotteries" onClick={close} className="flex min-h-9 items-center rounded-md border px-3 text-sm hover:bg-muted" data-testid="run-notice-lotteries">
              登録された抽選
            </Link>
          )}
          {s.review > 0 && (
            <Link href="/settings/collection#candidates" onClick={close} className="flex min-h-9 items-center rounded-md bg-primary px-3 text-sm text-primary-foreground" data-testid="run-notice-review">
              確認待ちへ
            </Link>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
