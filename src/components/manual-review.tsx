"use client";

import Link from "next/link";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { AlertTriangle, ExternalLink } from "lucide-react";
import { manualDismissAction, manualDoneAction, manualRecheckAction } from "@/app/(app)/settings/collection/manual-actions";
import { Button } from "@/components/ui/button";
import { manualHeadline, type ManualItem } from "@/lib/collector/manual-items";
import { EXCLUSION_REASONS, type ExclusionReasonCode } from "@/lib/collector/triage";
import { cn } from "@/lib/utils";

const fmtDue = (iso: string | null) => (iso ? new Intl.DateTimeFormat("ja-JP", { timeZone: "Asia/Tokyo", month: "numeric", day: "numeric", hour: "numeric", minute: "2-digit", hour12: false }).format(new Date(iso)) : "締切不明");

/** 最上部の赤い警告（ポップアップ・通知・設定で共通）。通常の件数表示より上に置く */
export function ManualBanner({ count }: { count: number }) {
  if (count <= 0) return null;
  return (
    <p className="flex items-center gap-1.5 rounded-md border border-danger bg-danger/10 px-2.5 py-1.5 text-sm font-semibold text-danger" role="alert" data-testid="manual-banner">
      <AlertTriangle className="size-4 shrink-0" aria-hidden="true" />
      {manualHeadline(count)}
    </p>
  );
}

/** 要手動確認1件の要約（系列・店舗／商品／取得できなかった理由／締切日時／元情報） */
export function ManualItemSummary({ it }: { it: ManualItem }) {
  const urgent = it.urgency === "today" || it.urgency === "tomorrow";
  return (
    <div className="min-w-0 space-y-0.5 text-xs" data-testid="manual-item" data-urgency={it.urgency}>
      <p className="truncate font-medium">{it.where ?? it.title}</p>
      {it.products.length > 0 && <p className="truncate text-muted-foreground">{it.products.join("・")}</p>}
      <p className="text-danger">
        {it.failLabel ? `${it.failLabel}：` : ""}
        {it.reason}
      </p>
      <p className="flex flex-wrap items-center gap-x-2">
        <span className={cn("tabular-nums", urgent && "font-semibold text-danger")} data-testid="manual-due">
          {it.urgencyLabel}（{fmtDue(it.dueAt)}）
        </span>
        {it.sourceUrl && (
          <a href={it.sourceUrl} target="_blank" rel="noreferrer noopener" className="inline-flex items-center gap-0.5 text-info underline" data-testid="manual-source">
            元情報を見る <ExternalLink className="size-3" aria-hidden="true" />
          </a>
        )}
      </p>
    </div>
  );
}

/** 要手動確認の一覧（設定 > 自動収集）。元URL・編集して登録・対象外として除外・再調査・対応完了。優先収集メモとは別の一覧 */
export function ManualReviewList({ items }: { items: ManualItem[] }) {
  const router = useRouter();
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [dismissing, setDismissing] = useState<string | null>(null);
  const [code, setCode] = useState<ExclusionReasonCode>("out_of_scope_product");
  const [text, setText] = useState("");

  const run = async (key: string, fn: () => Promise<{ ok: boolean; error?: string }>, done: string) => {
    setBusy(key);
    const r = await fn();
    setBusy(null);
    setMsg(r.ok ? done : (r.error ?? "失敗しました"));
    if (r.ok) router.refresh();
  };

  if (items.length === 0) return null;
  return (
    <section id="manual" className="scroll-mt-24 space-y-2 rounded-lg border border-danger/60 p-3 text-sm" data-testid="manual-review">
      <ManualBanner count={items.length} />
      {msg && <p className="text-xs text-muted-foreground" role="status">{msg}</p>}
      <ul className="space-y-2">
        {items.map((it) => (
          <li key={it.id} className="space-y-1.5 rounded-md bg-muted/40 p-2" data-testid="manual-row">
            <ManualItemSummary it={it} />
            <div className="flex flex-wrap gap-1.5">
              {it.editable && (
                <Link href="/settings/collection#candidates" className="flex min-h-8 items-center rounded-md bg-primary px-2.5 text-xs text-primary-foreground" data-testid="manual-edit">
                  編集して登録
                </Link>
              )}
              <Button size="sm" variant="outline" disabled={busy !== null} onClick={() => void run(`r${it.id}`, () => manualRecheckAction(it.id), "再調査を予約しました（次回のワーカーで確認します）")} data-testid="manual-recheck">
                再調査
              </Button>
              <Button size="sm" variant="outline" disabled={busy !== null} onClick={() => setDismissing(dismissing === it.id ? null : it.id)} data-testid="manual-dismiss">
                対象外にする
              </Button>
              <Button size="sm" variant="outline" disabled={busy !== null} onClick={() => void run(`d${it.id}`, () => manualDoneAction(it.id), "対応完了にしました")} data-testid="manual-done">
                対応完了
              </Button>
            </div>
            {dismissing === it.id && (
              <div className="space-y-1.5 rounded-md border p-2" data-testid="manual-dismiss-form">
                <select value={code} onChange={(e) => setCode(e.target.value as ExclusionReasonCode)} className="h-9 w-full rounded-md border bg-input px-2 text-sm" aria-label="除外の理由" data-testid="manual-dismiss-code">
                  {EXCLUSION_REASONS.map((r) => (
                    <option key={r.code} value={r.code}>
                      {r.label}
                    </option>
                  ))}
                </select>
                <input value={text} onChange={(e) => setText(e.target.value)} maxLength={500} placeholder="補足（任意）" className="h-9 w-full rounded-md border bg-input px-2 text-sm" aria-label="補足" />
                <Button size="sm" disabled={busy !== null} onClick={() => void run(`x${it.id}`, () => manualDismissAction(it.id, code, text), "対象外として除外しました")} data-testid="manual-dismiss-ok">
                  除外する
                </Button>
              </div>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}
