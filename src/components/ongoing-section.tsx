"use client";

import { useMemo, useState } from "react";
import { ChevronDown } from "lucide-react";
import { useApp } from "@/components/app-provider";
import { ChainLogo } from "@/components/chain-logo";
import { LotteryDetailSheet } from "@/components/lottery-detail-sheet";
import { groupOngoing } from "@/lib/lottery-flow";
import { cn } from "@/lib/utils";

/**
 * 応募済みタブの最下部に置く折りたたみ欄「継続中の抽選 N件」。初期状態は閉じる。
 * 継続抽選（ノジマ等：複数商品を1応募にまとめる）と招待制販売（Amazon等：商品ごと）を、通常カードではなくコンパクトな一覧で系列ごとに出す。
 * 通常の応募済み件数には含めない。
 */
export function OngoingSection() {
  const { data, profile } = useApp();
  const [open, setOpen] = useState(false);
  const [detailId, setDetailId] = useState<string | null>(null);
  const groups = useMemo(
    () => groupOngoing(data, profile.id, (id) => data.products.find((p) => p.id === id)?.aliases[0] ?? data.products.find((p) => p.id === id)?.officialName ?? "商品未登録"),
    [data, profile.id],
  );
  const total = groups.reduce((n, g) => n + g.rows.length, 0);
  if (total === 0) return null;
  const detail = detailId ? data.lotteries.find((l) => l.id === detailId) : undefined;

  return (
    <section className="rounded-lg border bg-card" data-testid="ongoing-section" aria-label="継続中の抽選">
      <button type="button" aria-expanded={open} onClick={() => setOpen((v) => !v)} className="flex min-h-11 w-full items-center gap-2 px-3 text-left text-sm font-medium" data-testid="ongoing-toggle">
        <span className="flex-1">継続中の抽選 {total}件</span>
        <ChevronDown className={cn("size-4 text-muted-foreground transition-transform", open && "rotate-180")} aria-hidden="true" />
      </button>
      {open && (
        <div className="space-y-1.5 border-t px-3 py-2" data-testid="ongoing-list">
          {groups.map((g) => {
            const chain = data.chains.find((c) => c.id === g.chainId);
            return (
              <div key={`${g.chainId}|${g.kind}`}>
                <ul className="divide-y">
                  {g.rows.map((r) => (
                    <li key={r.lottery.id}>
                      <button type="button" onClick={() => setDetailId(r.lottery.id)} className="flex min-h-10 w-full items-center gap-1.5 text-left text-xs" data-testid="ongoing-row">
                        <ChainLogo src={chain?.logoSrc} name={chain?.name ?? ""} className="size-4 rounded-[4px]" />
                        <span className="max-w-[28%] shrink-0 truncate font-medium">{chain?.name ?? ""}</span>
                        <span className="min-w-0 flex-1 truncate">{r.label}</span>
                        <span className="shrink-0 rounded border px-1.5 py-0.5 text-[11px] text-info">{r.state}</span>
                      </button>
                    </li>
                  ))}
                </ul>
              </div>
            );
          })}
        </div>
      )}
      {detail && <LotteryDetailSheet lottery={detail} open onOpenChange={(v) => !v && setDetailId(null)} />}
    </section>
  );
}
