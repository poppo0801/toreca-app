"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { releaseExclusionAction, updateExclusionAction } from "@/app/(app)/settings/collection/manual-actions";
import { useApp } from "@/components/app-provider";
import { Button } from "@/components/ui/button";
import { EXCLUSION_REASONS, EXCLUSION_LABEL, canExcludeSource, type ExclusionReasonCode } from "@/lib/collector/triage";
import { EXCLUSION_SCOPE_LABEL } from "@/lib/provenance";
import { FAIL_KIND_LABEL, type FailKind } from "@/lib/collector/queue";
import { cn } from "@/lib/utils";

export interface ExclusionView {
  id: string;
  scope: keyof typeof EXCLUSION_SCOPE_LABEL;
  key: string;
  label: string;
  reason_code: ExclusionReasonCode;
  reason_note: string;
  active: boolean;
  created_at: string;
  released_at: string | null;
}
export interface HardSourceView {
  id: string;
  scope: string;
  key: string;
  label: string;
  service_host: string | null;
  fail_kind: string | null;
  fail_count: number;
  last_checked_at: string | null;
  alt_source: string | null;
  alt_success: number;
  alt_fail: number;
  needs_manual: boolean;
}

const fmt = (iso: string | null) => (iso ? new Intl.DateTimeFormat("ja-JP", { timeZone: "Asia/Tokyo", month: "numeric", day: "numeric", hour: "numeric", minute: "2-digit", hour12: false }).format(new Date(iso)) : "－");
const ALT_LABEL: Record<string, string> = { list_text: "まとめサイトの一覧の表示", official_x: "公式X", x_expanded: "X投稿の展開先URL", cache: "既存の解析結果" };

/** 収集元の除外ルール（世帯共通）の一覧・理由の編集・解除。除外しても過去の応募・当落・購入の履歴は保持される */
export function ExclusionRules({ rules }: { rules: ExclusionView[] }) {
  const router = useRouter();
  const actor = useApp().profile.id;
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const [code, setCode] = useState<ExclusionReasonCode>("untrusted_shop");
  const [text, setText] = useState("");
  const active = rules.filter((r) => r.active);
  const released = rules.filter((r) => !r.active);

  const run = async (fn: () => Promise<{ ok: boolean; error?: string }>, done: string) => {
    setBusy(true);
    const r = await fn();
    setBusy(false);
    setMsg(r.ok ? done : (r.error ?? "失敗しました"));
    if (r.ok) {
      setEditing(null);
      router.refresh();
    }
  };

  return (
    <div className="space-y-2" data-testid="exclusion-rules">
      {msg && <p className="text-xs text-muted-foreground" role="status">{msg}</p>}
      {active.length === 0 && <p className="text-xs text-muted-foreground">除外中の収集元はありません。抽選の詳細から「今後この収集元を除外」で追加できます。</p>}
      <ul className="space-y-1.5">
        {active.map((r) => (
          <li key={r.id} className="space-y-1 rounded-md bg-muted/50 p-2 text-xs" data-testid="exclusion-row">
            <p className="font-medium">
              <span className="mr-1 rounded border px-1 text-[11px] text-muted-foreground">{EXCLUSION_SCOPE_LABEL[r.scope]}</span>
              {r.label || r.key}
            </p>
            <p className="text-muted-foreground">
              {EXCLUSION_LABEL[r.reason_code]}
              {r.reason_note ? `：${r.reason_note}` : ""}（{fmt(r.created_at)}）
            </p>
            <div className="flex gap-1.5">
              <Button
                size="sm"
                variant="outline"
                onClick={() => {
                  setEditing(editing === r.id ? null : r.id);
                  setCode(r.reason_code);
                  setText(r.reason_note);
                }}
                data-testid="exclusion-edit"
              >
                理由を編集
              </Button>
              <Button size="sm" variant="outline" disabled={busy} onClick={() => void run(() => releaseExclusionAction(r.id, actor), "除外を解除しました（過去の記録は残ります）")} data-testid="exclusion-release">
                解除
              </Button>
            </div>
            {editing === r.id && (
              <div className="space-y-1.5 rounded-md border p-2">
                <select value={code} onChange={(e) => setCode(e.target.value as ExclusionReasonCode)} className="h-9 w-full rounded-md border bg-input px-2 text-sm" aria-label="除外の理由">
                  {EXCLUSION_REASONS.filter((x) => canExcludeSource(x.code)).map((x) => (
                    <option key={x.code} value={x.code}>
                      {x.label}
                    </option>
                  ))}
                </select>
                <input value={text} onChange={(e) => setText(e.target.value)} maxLength={500} className="h-9 w-full rounded-md border bg-input px-2 text-sm" aria-label="補足" />
                <Button size="sm" disabled={busy} onClick={() => void run(() => updateExclusionAction(r.id, code, text), "保存しました")}>
                  保存
                </Button>
              </div>
            )}
          </li>
        ))}
      </ul>
      {released.length > 0 && (
        <details className="text-xs text-muted-foreground">
          <summary className="cursor-pointer">解除済み {released.length}件</summary>
          <ul className="mt-1 space-y-0.5">
            {released.map((r) => (
              <li key={r.id}>
                {EXCLUSION_SCOPE_LABEL[r.scope]} {r.label || r.key}（{EXCLUSION_LABEL[r.reason_code]}・解除 {fmt(r.released_at)}）
              </li>
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}

/** 取得困難な系列・店舗・応募サービスの記録（読み取り専用）。共通の応募サービスの失敗は、利用する店舗全体の取得不可を意味しない */
export function HardSources({ rows }: { rows: HardSourceView[] }) {
  if (rows.length === 0) return <p className="text-xs text-muted-foreground" data-testid="hard-sources-empty">取得が難しい収集元の記録はありません。</p>;
  return (
    <ul className="space-y-1" data-testid="hard-sources">
      {rows.map((r) => (
        <li key={r.id} className="rounded-md bg-muted/50 p-2 text-xs" data-testid="hard-source-row">
          <p className="font-medium">
            <span className="mr-1 rounded border px-1 text-[11px] text-muted-foreground">{{ chain: "系列", store: "店舗", service: "応募サービス", domain: "サイト", x_account: "Xアカウント" }[r.scope] ?? r.scope}</span>
            {r.label || r.key}
          </p>
          <p className="text-muted-foreground">
            {r.fail_kind ? (FAIL_KIND_LABEL[r.fail_kind as FailKind] ?? r.fail_kind) : "原因不明"}・失敗{r.fail_count}回・最終確認 {fmt(r.last_checked_at)}
          </p>
          <p className={cn("text-muted-foreground", r.alt_success > r.alt_fail && "text-info")}>
            代替取得：{r.alt_source ? `${ALT_LABEL[r.alt_source] ?? r.alt_source}（成功${r.alt_success}・失敗${r.alt_fail}）` : "未実施"}
            {r.needs_manual && <span className="ml-1 text-danger">手動確認が必要</span>}
          </p>
        </li>
      ))}
    </ul>
  );
}
