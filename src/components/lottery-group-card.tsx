"use client";

import { useState } from "react";
import { ChevronDown, Layers } from "lucide-react";
import { useApp } from "@/components/app-provider";
import { ChainLogo } from "@/components/chain-logo";
import { DeadlineBadgeView, MyApplyButton } from "@/components/apply-status";
import { LotteryDetailSheet } from "@/components/lottery-detail-sheet";
import { ProductThumb } from "@/components/product-image";
import { deadlineBadge, formatShort } from "@/lib/datetime";
import { childDiff, cityOfAddress, flexRange, summarizeGroup, summarizeGroupDetail, type GroupDetail, type GroupRow } from "@/lib/lottery-group";
import { cn } from "@/lib/utils";
import type { Lottery } from "@/types/domain";

/**
 * 子カード（店舗別の抽選）。コンパクト表示: 店舗名・地域・応募状況・応募操作。
 * 親と共通する商品・日程・条件は繰り返さず、**異なる項目だけ**を示す。タップで従来の抽選詳細（編集・スルー・応募状況の詳細など）を開く。
 */
function GroupChildRow({ lottery, detail }: { lottery: Lottery; detail: GroupDetail }) {
  const { data } = useApp();
  const [open, setOpen] = useState(false);
  const store = data.stores.find((s) => s.id === lottery.storeId);
  const select = lottery.storeMode === "select_on_apply";
  const name = select ? "応募時に店舗を選択" : (store?.name ?? "店舗未設定");
  const pref = store?.salesKind === "online_only" ? "通販" : (store?.prefecture ?? "");
  const city = cityOfAddress(store?.address, store?.prefecture ?? "");
  const diff = childDiff(lottery, detail, data);
  const diffs: string[] = [];
  if (diff.start) diffs.push(`応募開始 ${formatShort(diff.start)}`);
  if (diff.deadline) diffs.push(`締切 ${formatShort(diff.deadline)}`);
  if (diff.result) diffs.push(`発表 ${formatShort(diff.result)}`);
  return (
    <li className="flex items-center gap-1.5 rounded-lg border bg-background/40 py-1 pl-2 pr-1.5" data-testid="group-child" data-lottery-id={lottery.id}>
      <button type="button" onClick={() => setOpen(true)} aria-label={`${name}の詳細を開く`} className="min-w-0 flex-1 rounded-md py-1 text-left active:bg-muted/60" data-testid="group-child-open">
        <span className="flex items-center gap-1.5">
          <span className="min-w-0 truncate text-sm font-bold" data-testid="group-child-store">
            {name}
          </span>
          {lottery.isNew && (
            <span data-testid="new-dot" className="inline-block size-2 shrink-0 rounded-full bg-info">
              <span className="sr-only">NEW</span>
            </span>
          )}
          {(pref || city) && (
            <span className="shrink-0 rounded-full border px-1.5 py-px text-[10px] text-muted-foreground" data-testid="group-child-region">
              {[pref, city].filter(Boolean).join(" ")}
            </span>
          )}
        </span>
        {(diffs.length > 0 || diff.products || diff.conditions) && (
          <span className="mt-0.5 block space-y-0.5 text-[11px] text-warn" data-testid="group-child-diff">
            {diffs.length > 0 && <span className="block truncate">{diffs.join(" ・ ")}（この店舗）</span>}
            {diff.products && <span className="block truncate">商品: {diff.products.join("・")}</span>}
            {diff.conditions && <span className="block truncate">条件: {diff.conditions}</span>}
          </span>
        )}
      </button>
      <MyApplyButton lottery={lottery} compact />
      {open && <LotteryDetailSheet lottery={lottery} open onOpenChange={setOpen} />}
    </li>
  );
}

/**
 * 複数店舗抽選の親カード（Stage 8U-2 → UI-1で表示を整理）。表示・展開専用: 店舗別の操作ボタン（スルー・除外など）とスワイプ操作は持たない。
 *  - 親カード: 商品画像（大きめ）・系列（小さめ）・商品の正式名称・**グループ内で共通している**応募期間・発表日・締切までの残り時間・現在のユーザーの応募状況（応募済み N / M店舗）。
 *    日程・商品が店舗ごとに異なるときは、特定の店舗の値で代表させず「店舗により異なる」と示す。
 *  - 右側の「応募済み N / M ＋ 矢印」の領域が展開ボタン。
 *  - 展開すると子（店舗別の抽選）を表示する。compactChildren のとき（全情報・要チェック）はコンパクトな子、それ以外（応募済み・当選など）は従来のカード（renderChild）。
 *  - 展開状態は画面を開くたびに閉じた状態（端末・サーバーには保存しない）。子の操作結果は、親の応募状況にそのまま反映される（親は状態を持たない）。
 */
export function LotteryGroupCard({ row, renderChild, forceOpen = false, onManage, compactChildren = false }: { row: GroupRow; renderChild: (l: Lottery) => React.ReactNode; /** 通知から開いた抽選がこのグループにあるとき、展開した状態で開く */ forceOpen?: boolean; onManage: (l: Lottery) => void; /** 子をコンパクト表示にする（全情報・要チェックのタブ） */ compactChildren?: boolean }) {
  const { data, profile, persistent, now } = useApp();
  const [open, setOpen] = useState(false);
  const s = summarizeGroup(row, data, profile.id);
  const d = summarizeGroupDetail(row, data, profile.id);
  const chain = data.chains.find((c) => c.id === s.chainId);
  const expanded = open || forceOpen;
  const hiddenCount = s.storeCount - row.members.length;
  const done = d.total > 0 && d.applied === d.total;
  const head = d.headProductId ? data.products.find((p) => p.id === d.headProductId) : undefined;
  const all = row.all.length > 0 ? row.all : row.members;
  const earliest = flexRange(all.map((l) => l.applyDeadline));
  const badge = earliest ? deadlineBadge(earliest.from, now) : null;
  const title = row.group.title || (d.productsCommon ? d.productNames.slice(0, 2).join("・") + (d.productNames.length > 2 ? ` ほか${d.productNames.length - 2}` : "") : "商品は店舗により異なる");
  const startText = d.applyStart.same ? (d.applyStart.value ? formatShort(d.applyStart.value) : "—") : null;
  const deadText = d.applyDeadline.same ? (d.applyDeadline.value ? formatShort(d.applyDeadline.value) : "—") : null;
  const resultText = d.resultDate.same ? (d.resultDate.value ? formatShort(d.resultDate.value) : "—") : null;
  const periodCommon = startText !== null && deadText !== null;

  return (
    <div className="rounded-xl border bg-card shadow-card" data-testid="group-card" data-group-id={row.group.id}>
      <button
        type="button"
        aria-expanded={expanded}
        aria-label={`${s.chainName} ${title}。応募済み${d.applied}／${d.total}${d.unit}。${expanded ? "閉じる" : "店舗を表示"}`}
        onClick={() => setOpen((v) => !v)}
        className="flex min-h-16 w-full items-center gap-2.5 px-3 py-2 text-left"
        data-testid="group-toggle"
      >
        <span className="flex h-16 w-14 shrink-0 items-center justify-center" data-testid="group-image">
          {head ? <ProductThumb product={head} heightClass="h-16" /> : <Layers className="size-7 text-muted-foreground" aria-hidden="true" />}
        </span>
        <span className="min-w-0 flex-1 text-xs">
          <span className="flex items-center gap-1 text-[11px] text-muted-foreground">
            <ChainLogo src={chain?.logoSrc} name={s.chainName} className="!m-0 size-4 shrink-0 rounded-[4px]" />
            <span className="min-w-0 truncate" data-testid="group-chain">
              {s.chainName}
            </span>
            <span className="inline-flex shrink-0 items-center gap-0.5 rounded border px-1 text-[10px] font-medium">
              <Layers className="size-3" aria-hidden="true" />
              複数店舗
            </span>
          </span>
          <span className="line-clamp-2 text-sm font-bold leading-snug" data-testid="group-products">
            {title}
          </span>
          <span className="block truncate text-muted-foreground" data-testid="group-period">
            {periodCommon ? `応募 ${startText}〜${deadText}` : "応募期間は店舗により異なる"} ・ {resultText !== null ? `発表 ${resultText}` : "発表日は店舗により異なる"}
          </span>
          {badge && (
            <span className="mt-0.5 flex items-center gap-1" data-testid="group-deadline">
              {!d.applyDeadline.same && <span className="text-[10px] text-muted-foreground">最短</span>}
              <DeadlineBadgeView badge={badge} className="px-1 py-0.5 text-[11px]" />
            </span>
          )}
        </span>
        {/* 展開ボタン領域: 現在のユーザーの応募済み数／対象数（分母の単位は、店舗数と一致しないときは「件」） */}
        <span className="flex shrink-0 items-center gap-1" data-testid="group-count">
          <span className="text-right leading-tight">
            <span className={cn("block text-sm font-bold tabular-nums", done && "text-success")}>
              {d.applied}/{d.total}
              <span className="text-[10px] font-medium">{d.unit}</span>
            </span>
            <span className="block text-[10px] text-muted-foreground">応募済み</span>
          </span>
          <ChevronDown className={cn("size-5 text-muted-foreground transition-transform motion-reduce:transition-none", expanded && "rotate-180")} aria-hidden="true" />
        </span>
      </button>
      {expanded && (
        <div className="border-t px-2 pb-2 pt-2" data-testid="group-children">
          {compactChildren ? (
            <ul className="space-y-1.5">
              {row.members.map((l) => (
                <GroupChildRow key={l.id} lottery={l} detail={d} />
              ))}
            </ul>
          ) : (
            <ul className="space-y-2.5">{row.members.map((l) => renderChild(l))}</ul>
          )}
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
