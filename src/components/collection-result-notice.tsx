"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { useApp } from "@/components/app-provider";
import { ackRunNoticesAction, getRunNoticesAction } from "@/app/(app)/collection-notice-actions";
import { ManualBanner, ManualItemSummary } from "@/components/manual-review";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { manualSignature, type ManualItem } from "@/lib/collector/manual-items";
import { runTitle, type RunSummary } from "@/lib/collector/run-summary";
import { cn } from "@/lib/utils";

const SEEN_KEY = "trm.runNotice";
const MANUAL_SEEN_KEY = "trm.manualNotice";

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
 * 表示対象は、収集設定に固定IDで指定されたプロフィール（はとむぎ）だけ。他のプロフィールでは取得も表示もしない（判定はサーバー側）。
 * ボタンは「確認する」（要手動確認の一覧へ）と「閉じる」だけ。確認済みの記録は表示と同時に非同期で行い、画面遷移を待たせない。
 */
export function CollectionResultNotice() {
  const router = useRouter();
  const { profile } = useApp();
  const [notice, setNotice] = useState<{ s: RunSummary | null; ackIds: string[]; manual: ManualItem[] } | null>(null);

  useEffect(() => {
    let live = true;
    void getRunNoticesAction(profile.id).then((r) => {
      if (!live) return;
      const store = (k: string): string => {
        try {
          return window.sessionStorage.getItem(k) ?? "";
        } catch {
          return "";
        }
      };
      const put = (k: string, v: string) => {
        try {
          window.sessionStorage.setItem(k, v);
        } catch {
          /* 保存できなくても動作は継続 */
        }
      };
      let run: RunSummary | null = null;
      if (r.notice) {
        const stamp = `${r.notice.runId}:${r.notice.state}`;
        if (store(SEEN_KEY) !== stamp) {
          // この起動中に表示済みなら繰り返さない（処理中のまま繰り返さない）
          put(SEEN_KEY, stamp);
          run = r.notice;
        }
      }
      // 要手動確認: 未対応の案件の集合が変わったときだけ、起動時に最上部の赤い警告で知らせる。閉じただけでは対応済みにならず、通知・設定の一覧に残る
      const open = r.manual ?? [];
      const sig = manualSignature(open);
      let manual: ManualItem[] = [];
      if (open.length > 0 && store(MANUAL_SEEN_KEY) !== sig) {
        put(MANUAL_SEEN_KEY, sig);
        manual = open;
      }
      if (run || manual.length > 0) {
        setNotice({ s: run, ackIds: run ? r.ackIds : [], manual });
        // 確認済みの記録は表示した時点で行う。ボタンを押した後に実行すると、サーバー処理の完了待ちで画面遷移が遅れる
        if (run && r.ackIds.length > 0) void ackRunNoticesAction(r.ackIds);
      }
    });
    return () => {
      live = false;
    };
  }, [profile.id]);

  const close = () => setNotice(null);
  /** 確認する: ポップアップをすぐ閉じて、要手動確認の一覧へ移る（移動先の読み込みは移動後に表示する） */
  const confirm = () => {
    setNotice(null);
    router.push("/settings/collection#manual");
  };
  if (!notice) return null;
  const s = notice.s;
  const processing = s?.state === "processing";
  return (
    <Dialog open onOpenChange={(v) => !v && close()}>
      <DialogContent className="max-w-sm space-y-3" data-testid="run-notice">
        {/* 取得不可（要手動確認）は、通常の解析件数・登録件数より上に置く */}
        <ManualBanner count={notice.manual.length} urgent={notice.manual.some((i) => i.urgency === "today" || i.urgency === "tomorrow")} />
        {notice.manual.length > 0 && (
          <ul className="max-h-56 space-y-1.5 overflow-y-auto" data-testid="manual-notice-list">
            {notice.manual.slice(0, 5).map((it) => (
              <li key={it.id} className="rounded-md bg-danger/5 p-1.5">
                <ManualItemSummary it={it} />
              </li>
            ))}
            {notice.manual.length > 5 && <li className="text-xs text-muted-foreground">ほか{notice.manual.length - 5}件</li>}
          </ul>
        )}
        {s ? (
          <DialogTitle className="flex items-center gap-2">
            {runTitle(s)}
            <RunStateLabel s={s} />
          </DialogTitle>
        ) : (
          <DialogTitle className="sr-only">要手動確認</DialogTitle>
        )}
        <DialogDescription className="sr-only">自動収集の結果の要約</DialogDescription>
        {processing && <p className="text-xs text-muted-foreground">解析の途中です。数字は途中経過で、最終結果ではありません。</p>}
        {s && <RunCounts s={s} />}
        {s && (s.excluded > 0 || s.duplicates > 0 || s.costJpy > 0) && (
          <p className="text-[11px] text-muted-foreground">
            対象外 {s.excluded}件・重複 {s.duplicates}件・AI費用 約{s.costJpy}円
          </p>
        )}
        <div className="flex justify-end gap-2 pt-1">
          <button type="button" onClick={close} className="min-h-10 rounded-md px-4 text-sm text-muted-foreground hover:bg-muted" data-testid="run-notice-close">
            閉じる
          </button>
          <button type="button" onClick={confirm} className="min-h-10 rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground" data-testid="run-notice-confirm">
            確認する
          </button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
