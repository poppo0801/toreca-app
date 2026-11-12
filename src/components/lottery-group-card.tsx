"use client";

import { useState } from "react";
import { ChevronDown, Layers } from "lucide-react";
import { useApp } from "@/components/app-provider";
import { ChainLogo } from "@/components/chain-logo";
import { summarizeGroup, type GroupRow } from "@/lib/lottery-group";
import { cn } from "@/lib/utils";
import type { Lottery } from "@/types/domain";

/**
 * 複数店舗抽選の親カード（Stage 8U-2）。表示・展開専用: 店舗別の操作ボタン（応募済み・スルー・除外など）とスワイプ操作は持たない。
 *  - 通常のカード以下の高さ。右側の「応募済み N/M ＋ 矢印」の領域が展開ボタン（従来の応募済みボタンの位置）。
 *  - 展開すると、店舗別の子カード（renderChild）を表示する。子は従来どおり独立した抽選（応募済み・スルー・除外・スワイプ・詳細・編集・ユーザー別の応募・当落）。
 *  - 展開状態は画面を開くたびに閉じた状態（端末・サーバーには保存しない）。子の操作結果は、親の応募済み件数にそのまま反映される（親は状態を持たず、子から導出する）。
 */
export function LotteryGroupCard({ row, renderChild, forceOpen = false, onManage }: { row: GroupRow; renderChild: (l: Lottery) => React.ReactNode; /** 通知から開いた抽選がこのグループにあるとき、展開して見せる */ forceOpen?: boolean; /** グループの管理を開く（管理画面は一覧側が持つ。グループの子が減って親カードが通常のカードに戻っても、開いたまま操作を続けられる） */ onManage: (anchor: Lottery) => void }) {
  const { data, profile, persistent } = useApp();
  const [open, setOpen] = useState(false);
  const s = summarizeGroup(row, data, profile.id);
  const chain = data.chains.find((c) => c.id === s.chainId);
  const expanded = open || forceOpen;
  const hiddenCount = s.storeCount - row.members.length;
  const done = s.storeCount > 0 && s.appliedCount === s.storeCount;

  return (
    <div className="rounded-xl border bg-card shadow-card" data-testid="group-card" data-group-id={row.group.id}>
      <button
        type="button"
        aria-expanded={expanded}
        aria-label={`${s.chainName} ${s.productsText}。${s.storeCount}店舗、応募済み${s.appliedCount}店舗。${expanded ? "閉じる" : "店舗を表示"}`}
        onClick={() => setOpen((v) => !v)}
        className="flex min-h-14 w-full items-center gap-2.5 px-3 py-2 text-left"
        data-testid="group-toggle"
      >
        <ChainLogo src={chain?.logoSrc} name={s.chainName} className="!m-0 size-9 shrink-0 rounded-md p-0.5" />
        <span className="min-w-0 flex-1 text-xs">
          <span className="flex items-center gap-1.5">
            <span className="min-w-0 truncate text-sm font-bold" data-testid="group-chain">
              {s.chainName}
            </span>
            <span className="inline-flex shrink-0 items-center gap-0.5 rounded border px-1 text-[10px] font-medium text-muted-foreground">
              <Layers className="size-3" aria-hidden="true" />
              複数店舗
            </span>
          </span>
          <span className="block truncate" data-testid="group-products">
            {row.group.title || s.productsText}
          </span>
          <span className="block truncate text-muted-foreground" data-testid="group-period">
            応募 {s.periodText}
            {s.periodVaries ? "（店舗により異なる）" : ""} ・ 発表 {s.announceText}
            {s.announceVaries ? "ほか" : ""}
          </span>
        </span>
        {/* 展開ボタン領域: 対象店舗数・応募済み店舗数（従来の応募済みボタンの位置） */}
        <span className="flex shrink-0 items-center gap-1" data-testid="group-count">
          <span className="text-right leading-tight">
            <span className={cn("block text-sm font-bold tabular-nums", done && "text-success")}>
              {s.appliedCount}/{s.storeCount}
            </span>
            <span className="block text-[10px] text-muted-foreground">応募済み</span>
          </span>
          <ChevronDown className={cn("size-5 text-muted-foreground transition-transform motion-reduce:transition-none", expanded && "rotate-180")} aria-hidden="true" />
        </span>
      </button>
      {expanded && (
        <div className="border-t px-2 pb-2 pt-2" data-testid="group-children">
          <ul className="space-y-2.5">{row.members.map((l) => renderChild(l))}</ul>
          <div className="mt-1.5 flex items-center justify-between gap-2 px-1 text-[11px] text-muted-foreground">
            <span>{hiddenCount > 0 ? `ほか${hiddenCount}店舗は、今の絞り込み・タブでは表示されていません` : ""}</span>
            {persistent && (
              <button type="button" className="min-h-9 shrink-0 underline" onClick={() => onManage(row.members[0])} data-testid="group-manage">
                グループを管理
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
