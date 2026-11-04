"use client";

import Link from "next/link";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { AlertTriangle, ChevronDown, ExternalLink } from "lucide-react";
import { manualDismissAction, manualDoneAction, manualRecheckAction } from "@/app/(app)/settings/collection/manual-actions";
import { Button } from "@/components/ui/button";
import { manualHeadline, type ManualItem } from "@/lib/collector/manual-items";
import { EXCLUSION_REASONS, type ExclusionReasonCode } from "@/lib/collector/triage";
import { cn } from "@/lib/utils";

const fmtDue = (iso: string | null) => (iso ? new Intl.DateTimeFormat("ja-JP", { timeZone: "Asia/Tokyo", month: "numeric", day: "numeric", hour: "numeric", minute: "2-digit", hour12: false }).format(new Date(iso)) : "締切不明");
const isUrgent = (it: ManualItem) => it.urgency === "today" || it.urgency === "tomorrow";

export interface ManualGroups {
  /** 未対応の要手動確認（今すぐ確認＋余裕あり・不明） */
  open: ManualItem[];
  /** 自動再調査中（ユーザーの対応は不要） */
  retrying: ManualItem[];
  retryingCount: number;
  /** 終了・対象外・対応済み（直近） */
  closed: ManualItem[];
}

/** 最上部の警告（ポップアップ・通知・設定で共通）。赤色は締切が迫る案件があるときだけ */
export function ManualBanner({ count, urgent = true }: { count: number; urgent?: boolean }) {
  if (count <= 0) return null;
  return (
    <p className={cn("flex items-center gap-1.5 rounded-md border px-2.5 py-1.5 text-sm font-semibold", urgent ? "border-danger bg-danger/10 text-danger" : "bg-muted/40")} role="alert" data-testid="manual-banner">
      <AlertTriangle className="size-4 shrink-0" aria-hidden="true" />
      {manualHeadline(count)}
    </p>
  );
}

/** 要手動確認1件のコンパクト表示（系列・店舗／商品／短い理由／締切／元情報）。赤字は締切が迫るときの締切のみ */
export function ManualItemSummary({ it }: { it: ManualItem }) {
  return (
    <div className="min-w-0 space-y-0.5 text-xs" data-testid="manual-item" data-urgency={it.urgency}>
      <p className="truncate font-medium" title={it.where ?? it.title}>
        {it.where ?? it.title}
      </p>
      {it.products.length > 0 && <p className="truncate text-muted-foreground">{it.products.join("・")}</p>}
      <p className="flex min-w-0 flex-wrap items-center gap-x-2 text-muted-foreground">
        <span data-testid="manual-short-reason">{it.shortReason}</span>
        <span className={cn("tabular-nums", isUrgent(it) && "font-semibold text-danger")} data-testid="manual-due">
          {it.urgencyLabel}（{fmtDue(it.dueAt)}）
        </span>
        {it.sourceUrl && (
          <a href={it.sourceUrl} target="_blank" rel="noreferrer noopener" className="inline-flex items-center gap-0.5 text-info underline" data-testid="manual-source">
            元情報 <ExternalLink className="size-3" aria-hidden="true" />
          </a>
        )}
      </p>
    </div>
  );
}

function Fold({ title, count, children, testid }: { title: string; count: number; children: React.ReactNode; testid: string }) {
  if (count <= 0) return null;
  return (
    <details className="group rounded-md border" data-testid={testid}>
      <summary className="flex min-h-9 cursor-pointer list-none items-center justify-between gap-2 px-2.5 text-xs font-medium">
        <span>
          {title}：{count}件
        </span>
        <ChevronDown className="size-4 transition-transform group-open:rotate-180" aria-hidden="true" />
      </summary>
      <div className="space-y-1.5 border-t p-2">{children}</div>
    </details>
  );
}

/** 要手動確認の一覧（設定 > 自動収集）。今すぐ確認を優先し、自動再調査中・終了済みは折りたたむ。操作は「詳細・対応」を開いたときだけ表示 */
export function ManualReviewList({ groups }: { groups: ManualGroups }) {
  const router = useRouter();
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);
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

  const now = groups.open.filter((i) => i.group === "now");
  const later = groups.open.filter((i) => i.group === "later");
  if (groups.open.length === 0 && groups.retryingCount === 0 && groups.closed.length === 0) return null;

  const row = (it: ManualItem, actions: boolean) => {
    const opened = openId === it.id;
    return (
      <li key={it.id} className="space-y-1.5 rounded-md bg-muted/40 p-2" data-testid="manual-row">
        <div className="flex items-start gap-2">
          <div className="min-w-0 flex-1">
            <ManualItemSummary it={it} />
          </div>
          {actions && (
            <Button size="sm" variant="outline" className="shrink-0" aria-expanded={opened} onClick={() => setOpenId(opened ? null : it.id)} data-testid="manual-detail">
              詳細・対応
            </Button>
          )}
        </div>
        {actions && opened && (
          <div className="space-y-1.5 border-t pt-1.5" data-testid="manual-detail-panel">
            <dl className="space-y-0.5 text-xs text-muted-foreground">
              {it.failLabel && (
                <div>
                  <dt className="inline font-medium">取得できなかった原因：</dt>
                  <dd className="inline">{it.failLabel}</dd>
                </div>
              )}
              <div>
                <dt className="inline font-medium">経緯：</dt>
                <dd className="inline">{it.reason}</dd>
              </div>
              <div className="break-all">
                <dt className="inline font-medium">候補の表示：</dt>
                <dd className="inline">{it.title}</dd>
              </div>
            </dl>
            <div className="flex flex-wrap gap-1.5">
              {it.sourceUrl && (
                <a href={it.sourceUrl} target="_blank" rel="noreferrer noopener" className="flex min-h-8 items-center gap-1 rounded-md border px-2.5 text-xs" data-testid="manual-open-source">
                  元情報を確認 <ExternalLink className="size-3" aria-hidden="true" />
                </a>
              )}
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
          </div>
        )}
      </li>
    );
  };

  return (
    <section id="manual" className={cn("scroll-mt-24 space-y-2 rounded-lg border p-3 text-sm", now.some(isUrgent) && "border-danger/60")} data-testid="manual-review">
      {now.length > 0 ? (
        <ManualBanner count={now.length} urgent={now.some(isUrgent)} />
      ) : (
        <p className="text-sm font-medium" data-testid="manual-none">
          要手動確認：0件
        </p>
      )}
      {msg && (
        <p className="text-xs text-muted-foreground" role="status">
          {msg}
        </p>
      )}
      {now.length > 0 && (
        <div className="space-y-1" data-testid="manual-now">
          <p className="text-xs font-medium text-muted-foreground">今すぐ確認</p>
          <ul className="space-y-2">{now.map((it) => row(it, true))}</ul>
        </div>
      )}
      <Fold title="締切に余裕あり・締切不明（急ぎません）" count={later.length} testid="manual-later">
        <ul className="space-y-2">{later.map((it) => row(it, true))}</ul>
      </Fold>
      <Fold title="自動再調査中（対応不要）" count={groups.retryingCount} testid="manual-retrying">
        <ul className="space-y-2">{groups.retrying.map((it) => row(it, false))}</ul>
        {groups.retryingCount > groups.retrying.length && <p className="text-xs text-muted-foreground">ほか{groups.retryingCount - groups.retrying.length}件</p>}
      </Fold>
      <Fold title="終了・対象外・対応済み（直近）" count={groups.closed.length} testid="manual-closed">
        <ul className="space-y-2">{groups.closed.map((it) => row(it, false))}</ul>
      </Fold>
    </section>
  );
}
