"use client";

import { useState } from "react";
import { Bot, ExternalLink, ShieldCheck } from "lucide-react";
import { confirmLotteryAction, excludeLotteryAction, excludeSourceAction } from "@/app/(app)/settings/collection/manual-actions";
import { useApp } from "@/components/app-provider";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { canExcludeSource, EXCLUSION_REASONS, type ExclusionReasonCode } from "@/lib/collector/triage";
import { originOf, sourceScopeOptions } from "@/lib/provenance";
import { cn } from "@/lib/utils";
import type { Lottery } from "@/types/domain";

const fmt = (iso: string | null | undefined) => (iso ? new Intl.DateTimeFormat("ja-JP", { timeZone: "Asia/Tokyo", year: "numeric", month: "numeric", day: "numeric", hour: "numeric", minute: "2-digit", hour12: false }).format(new Date(iso)) : "－");

/** 抽選詳細の登録経路アイコン（確認済み=チェック／完全自動収集・未確認=ロボット）。タップで経路・元情報・日時、自動収集の抽選には確認・除外の操作 */
export function RegistrationOrigin({ lottery, onChanged }: { lottery: Lottery; onChanged?: () => void }) {
  const { data, profile, persistent, reload } = useApp();
  const info = originOf(lottery);
  const [open, setOpen] = useState(false);
  const [mode, setMode] = useState<"info" | "lottery" | "source">("info");
  const [code, setCode] = useState<ExclusionReasonCode>("out_of_scope_product");
  const [text, setText] = useState("");
  const [scopeIdx, setScopeIdx] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const scopes = sourceScopeOptions(lottery, data);
  const Icon = info.icon === "bot" ? Bot : ShieldCheck;

  const finish = (ok: boolean, done: string, error?: string) => {
    setBusy(false);
    setMsg(ok ? done : (error ?? "失敗しました"));
    if (ok) {
      void reload?.();
      onChanged?.();
      setMode("info");
    }
  };

  return (
    <>
      <button
        type="button"
        onClick={() => {
          setMsg(null);
          setMode("info");
          setOpen(true);
        }}
        className={cn("inline-flex min-h-8 items-center gap-1 rounded-md border px-2 text-xs", info.icon === "bot" ? "text-warn" : "text-success")}
        aria-label={`登録経路: ${info.label}`}
        data-testid="origin-icon"
        data-path={info.path}
      >
        <Icon className="size-4" aria-hidden="true" />
        {info.label}
      </button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-w-sm space-y-3" data-testid="origin-dialog">
          <DialogTitle className="flex items-center gap-1.5">
            <Icon className="size-4" aria-hidden="true" />
            {info.label}
          </DialogTitle>
          <DialogDescription className="sr-only">この抽選の登録経路と確認の履歴</DialogDescription>
          {mode === "info" && (
            <>
              <dl className="space-y-1.5 text-sm">
                <div>
                  <dt className="text-[11px] text-muted-foreground">登録日時</dt>
                  <dd data-testid="origin-created">{fmt(lottery.createdAt)}</dd>
                </div>
                <div>
                  <dt className="text-[11px] text-muted-foreground">手動確認日時</dt>
                  <dd data-testid="origin-confirmed">{lottery.confirmedAt ? fmt(lottery.confirmedAt) : "未確認"}</dd>
                </div>
                <div>
                  <dt className="text-[11px] text-muted-foreground">元情報URL</dt>
                  <dd>
                    {lottery.sourceUrls.length === 0 ? (
                      "－"
                    ) : (
                      <ul className="space-y-0.5">
                        {lottery.sourceUrls.slice(0, 4).map((u) => (
                          <li key={u} className="truncate">
                            <a href={u} target="_blank" rel="noreferrer noopener" className="inline-flex items-center gap-1 text-info underline" data-testid="origin-url">
                              {u.replace(/^https?:\/\//, "").slice(0, 48)} <ExternalLink className="size-3" aria-hidden="true" />
                            </a>
                          </li>
                        ))}
                      </ul>
                    )}
                  </dd>
                </div>
              </dl>
              <p className="text-[11px] text-muted-foreground">「確認済み」は、ユーザーが内容を確認した履歴です。内容の正確性や、ショップの安全性を保証するものではありません。</p>
              {msg && <p className="text-xs text-muted-foreground" role="status">{msg}</p>}
              {info.auto && persistent && (
                <div className="flex flex-wrap gap-1.5" data-testid="origin-actions">
                  {info.path === "auto" && (
                    <Button
                      size="sm"
                      disabled={busy}
                      onClick={() => {
                        setBusy(true);
                        void confirmLotteryAction(lottery.id, profile.id).then((r) => finish(r.ok, "確認済みにしました", r.ok ? undefined : r.error));
                      }}
                      data-testid="origin-confirm"
                    >
                      確認済みにする
                    </Button>
                  )}
                  <Button size="sm" variant="outline" onClick={() => setMode("lottery")} data-testid="origin-exclude-lottery">
                    この抽選を除外
                  </Button>
                  <Button size="sm" variant="outline" onClick={() => setMode("source")} data-testid="origin-exclude-source">
                    今後この収集元を除外
                  </Button>
                </div>
              )}
            </>
          )}
          {mode !== "info" && (
            <div className="space-y-2" data-testid={mode === "lottery" ? "exclude-lottery-form" : "exclude-source-form"}>
              {mode === "source" && (
                <fieldset className="space-y-1">
                  <legend className="text-xs font-medium">除外する範囲（1つ選択）</legend>
                  {scopes.length === 0 && <p className="text-xs text-muted-foreground">除外できる範囲を特定できません。</p>}
                  {scopes.map((o, i) => (
                    <label key={`${o.scope}-${o.key}`} className="flex items-start gap-2 rounded-md border p-2 text-xs">
                      <input type="radio" name="scope" checked={scopeIdx === i} onChange={() => setScopeIdx(i)} className="mt-0.5" data-testid={`scope-${o.scope}`} />
                      <span>
                        <span className="block font-medium">{o.label}</span>
                        <span className="block text-muted-foreground">{o.hint}</span>
                      </span>
                    </label>
                  ))}
                </fieldset>
              )}
              <label className="block space-y-1 text-xs">
                <span className="font-medium">理由</span>
                <select value={code} onChange={(e) => setCode(e.target.value as ExclusionReasonCode)} className="h-10 w-full rounded-md border bg-input px-2 text-sm" data-testid="exclude-code">
                  {EXCLUSION_REASONS.filter((r) => mode === "lottery" || canExcludeSource(r.code)).map((r) => (
                    <option key={r.code} value={r.code}>
                      {r.label}
                    </option>
                  ))}
                </select>
              </label>
              {mode === "source" && <p className="text-[11px] text-muted-foreground">応募資格・条件の不一致、地域、重複は、収集元全体の除外理由には選べません（個別の判断のため）。</p>}
              <input value={text} onChange={(e) => setText(e.target.value)} maxLength={500} placeholder="補足（任意）" className="h-10 w-full rounded-md border bg-input px-2 text-sm" aria-label="補足" />
              {msg && <p className="text-xs text-danger" role="alert">{msg}</p>}
              <div className="flex justify-end gap-1.5">
                <Button size="sm" variant="outline" onClick={() => setMode("info")}>
                  戻る
                </Button>
                <Button
                  size="sm"
                  disabled={busy || (mode === "source" && scopeIdx === null)}
                  onClick={() => {
                    setBusy(true);
                    if (mode === "lottery") void excludeLotteryAction(lottery.id, code, text, profile.id).then((r) => finish(r.ok, "この抽選を除外しました", r.ok ? undefined : r.error));
                    else if (scopeIdx !== null) {
                      const o = scopes[scopeIdx];
                      void excludeSourceAction({ scope: o.scope, key: o.key, label: o.label, code, text, actor: profile.id }).then((r) => finish(r.ok, "今後この収集元を除外します（設定 > 自動収集 > 収集元の管理で解除できます）", r.ok ? undefined : r.error));
                    }
                  }}
                  data-testid="exclude-submit"
                >
                  {mode === "lottery" ? "この抽選を除外" : "この収集元を除外"}
                </Button>
              </div>
            </div>
          )}
        </DialogContent>
      </Dialog>
    </>
  );
}
