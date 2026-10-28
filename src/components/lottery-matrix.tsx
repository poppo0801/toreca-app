"use client";

import { useState } from "react";
import { useApp } from "@/components/app-provider";
import { ProfileAvatar } from "@/components/profile-avatar";
import { STATUS_META, StatusIcon, StatusLegend } from "@/components/status-icon";
import { judgeAccount } from "@/lib/eligibility";
import { cn } from "@/lib/utils";
import type { AccountStatus, Lottery } from "@/types/domain";

const NEEDS_ACTION: AccountStatus[] = ["eligible_unapplied", "needs_review"];

/**
 * 応募状況マトリクス。行=抽選、列=ユーザー（プロフィール）。系列ごとの応募アカウントはユーザーに集約するため、
 * 系列が増えても列は増えず、A/B/C が iPhone の幅で同時に見える。状態はアイコン＋色（意味は凡例・長押し/タップで確認）。
 * 店舗名は2行目の小さな補助文字で、長いものは省略し、タップで全文を表示する。
 */
export function LotteryMatrix({ lotteries, actionOnly }: { lotteries: Lottery[]; actionOnly: boolean }) {
  const { data, now } = useApp();
  const [expanded, setExpanded] = useState<string | null>(null);
  const [legend, setLegend] = useState(false);
  const profiles = data.profiles.filter((p) => p.active !== false);

  const rows = lotteries
    .map((l) => ({
      l,
      cells: profiles.map((p) => {
        const acc = data.accounts.find((a) => a.profileId === p.id && a.chainId === l.chainId && a.active);
        return acc ? judgeAccount(data, l, acc, now) : null;
      }),
    }))
    .filter((r) => !actionOnly || r.cells.some((c) => c && NEEDS_ACTION.includes(c.status)));

  if (rows.length === 0) return null;
  const missedCount = rows.filter((r) => r.cells.some((c) => c?.status === "eligible_unapplied")).length;

  return (
    <div className="space-y-2" data-testid="matrix">
      <div className="flex items-center justify-between gap-2">
        <p className="text-xs" data-testid="matrix-summary">
          応募漏れの可能性: <strong className={missedCount > 0 ? "text-primary" : ""}>{missedCount}件</strong>
        </p>
        <button type="button" onClick={() => setLegend((v) => !v)} aria-expanded={legend} className="min-h-8 rounded-md border px-2 text-xs">
          アイコンの意味
        </button>
      </div>
      {legend && (
        <div className="rounded-lg border bg-card p-2" data-testid="matrix-legend">
          <StatusLegend />
          <p className="mt-1 text-[11px] text-muted-foreground">太枠の行は、未応募のユーザーがいる抽選です。</p>
        </div>
      )}
      <div className="overflow-hidden rounded-lg border bg-card shadow-card">
        <table className="w-full table-fixed border-collapse text-sm">
          <thead>
            <tr className="bg-muted">
              <th scope="col" className="px-2 py-1.5 text-left text-[11px] font-normal text-muted-foreground">
                抽選
              </th>
              {profiles.map((p) => (
                <th key={p.id} scope="col" className="w-11 px-0 py-1.5" aria-label={p.label}>
                  <span className="flex justify-center">
                    <ProfileAvatar profile={p} size="sm" />
                  </span>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map(({ l, cells }) => {
              const chain = data.chains.find((c) => c.id === l.chainId);
              const store = data.stores.find((s) => s.id === l.storeId);
              const missed = cells.some((c) => c?.status === "eligible_unapplied");
              const isOpen = expanded === l.id;
              return (
                <tr key={l.id} className={cn("border-t", missed && "bg-muted/50 [&>th]:border-l-[3px] [&>th]:border-l-primary")} data-missed={missed}>
                  <th scope="row" className="px-2 py-1.5 text-left font-normal">
                    <button type="button" onClick={() => setExpanded(isOpen ? null : l.id)} aria-expanded={isOpen} className="block w-full text-left" aria-label={`${chain?.name ?? ""} ${store?.name ?? ""}`}>
                      <span className="block truncate text-xs font-medium">{chain?.name}</span>
                      <span className={cn("block text-[11px] text-muted-foreground", !isOpen && "truncate")}>{store?.name}</span>
                    </button>
                  </th>
                  {cells.map((c, i) => (
                    <td key={profiles[i].id} className="px-0 py-1.5 text-center">
                      {c ? (
                        <span
                          role="img"
                          title={`${STATUS_META[c.status].label}（${c.reason}）`}
                          aria-label={`${profiles[i].label}: ${STATUS_META[c.status].label}（${c.reason}）`}
                          data-status={c.status}
                          className={cn("inline-flex size-7 items-center justify-center rounded-full", NEEDS_ACTION.includes(c.status) && "border border-primary bg-input")}
                        >
                          <StatusIcon status={c.status} className="size-5" />
                        </span>
                      ) : (
                        <span className="text-muted-foreground" aria-label="該当なし">
                          ・
                        </span>
                      )}
                    </td>
                  ))}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
