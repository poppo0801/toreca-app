"use client";

import { useRef, useState } from "react";
import { CalendarCheck, Clock, MapPin, Star, Store as StoreIcon, Truck } from "lucide-react";
import { useApp } from "@/components/app-provider";
import { ApplyStatusRow, DeadlineBadgeView, MyApplyButton } from "@/components/apply-status";
import { LotteryDetailSheet } from "@/components/lottery-detail-sheet";
import { ProductThumb } from "@/components/product-image";
import { ProfileAvatar } from "@/components/profile-avatar";
import { STATUS_META } from "@/components/status-icon";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { BAND_CLASS, formatKm } from "@/lib/geo";
import { storeDistance } from "@/lib/store-distance";
import { DEFAULT_CARD_DISPLAY } from "@/lib/card-display";
import { deadlineBadge, formatFlexible, formatResultShort, formatShort, hasResultPeriod } from "@/lib/datetime";
import { effectiveEventState, hasSkipException, skipSourceFor } from "@/lib/eligibility";
import { DEADLINE_BAR_CLASS, EVENT_LABEL, RECEIVE_SHORT, APPLY_LABEL, placeLabel } from "@/lib/lottery-labels";
import { extraKindsLabel, resultNotice, summarizeItems } from "@/lib/lottery-summary";
import { formatItem, isManaged, type Tab } from "@/lib/lottery-view";
import { useBusy } from "@/lib/use-busy";
import { cn } from "@/lib/utils";
import type { Lottery } from "@/types/domain";

export { STATUS_META };

function Chip({ children, className }: { children: React.ReactNode; className?: string }) {
  return <span className={cn("inline-flex items-center rounded border px-1.5 py-0.5 text-[11px] leading-none", className)}>{children}</span>;
}

/** 商品名（最大2行）と「＋他N種」。省略しても、全商品は詳細で確認できる */
function ProductLine({ name, quantity, extra, className }: { name: string; quantity?: string; extra: number; className?: string }) {
  const more = extraKindsLabel(extra);
  return (
    <span className={cn("flex items-baseline gap-1 text-[13px] font-bold leading-snug", className)} data-testid="lottery-items">
      <span className="line-clamp-2 min-w-0 break-words" data-testid="product-name">
        {name}
        {quantity && <span className="ml-1 text-xs font-normal text-muted-foreground">{quantity}</span>}
      </span>
      {more && (
        <span className="shrink-0 whitespace-nowrap text-xs font-normal text-muted-foreground" data-testid="extra-kinds">
          {more}
        </span>
      )}
    </span>
  );
}

/**
 * 抽選カード（一覧）。商品画像を左に、店舗・商品名（最大2行）・締切・発表・応募状況を流し見できる密度にまとめる。
 * 複数商品は先頭の1種類だけ出して「＋他N種」に集約する（全商品は詳細）。応募締切までの残り時間は右上に目立たせる。
 * プロフィール別の応募状況は表示専用。応募の操作は現在のプロフィール専用のボタンだけで行う。
 */
export function LotteryCard({
  lottery,
  tab,
  view,
  highlighted = false,
}: {
  lottery: Lottery;
  tab: Tab;
  /** simple: 1行のコンパクトなカード / detail: 日時・受取方法・全員の応募状況まで出す */
  view: "simple" | "detail";
  highlighted?: boolean;
}) {
  const { data, now, profile, actions, settings } = useApp();
  const detailMode = view === "detail";
  const display = settings.cardDisplay ?? data.settings?.cardDisplay ?? DEFAULT_CARD_DISPLAY;
  const [open, setOpen] = useState(false);
  const [confirmOff, setConfirmOff] = useState(false);
  const scrollY = useRef(0);

  const chain = data.chains.find((c) => c.id === lottery.chainId);
  const store = data.stores.find((s) => s.id === lottery.storeId);
  const managed = isManaged(data, lottery.id);
  const event = effectiveEventState(lottery, now);
  const badge = event === "closed" || event === "cancelled" ? null : deadlineBadge(lottery.applyDeadline, now);
  const notice = resultNotice(data, lottery, now);
  const skipSource = skipSourceFor(data, profile.id, lottery);
  const skipException = hasSkipException(data, profile.id, lottery);

  const sum = summarizeItems(lottery, data);
  const firstProduct = data.products.find((p) => p.id === sum.firstProductId);
  const storeLine = `${chain?.name ?? ""} ${store?.name ?? ""}`.trim();
  const dist = storeDistance(data, store);
  const place = placeLabel(lottery.receiveMethod, store?.prefecture);
  // 往復交通費は、店頭で受け取る場合だけ意味がある（通販では出さない）
  const showFare = display.travelCost && store?.roundTripFare != null && lottery.receiveMethod !== "shipping";
  const barClass = event === "before" ? "border-l-info" : DEADLINE_BAR_CLASS[badge?.tone ?? "ended"];

  const openDetail = () => {
    scrollY.current = window.scrollY;
    setOpen(true);
  };
  // 詳細を閉じたら、一覧のスクロール位置を元に戻す
  const onOpenChange = (v: boolean) => {
    setOpen(v);
    if (!v) requestAnimationFrame(() => window.scrollTo({ top: scrollY.current }));
  };
  const toggleStar = () => {
    if (managed) setConfirmOff(true); // ★OFFは確認ダイアログ
    else actions.setManaged(lottery.id, true);
  };

  const deadlineText = lottery.applyDeadline.precision === "unknown" ? null : formatShort(lottery.applyDeadline);
  const period = hasResultPeriod(lottery);
  const finished = event === "closed" || event === "cancelled";

  return (
    <article
      data-testid="lottery-card"
      data-lottery-id={lottery.id}
      className={cn(
        "relative rounded-xl border border-l-[3px] bg-card text-card-foreground shadow-card",
        barClass,
        notice === "unconfirmed" && "border-2 border-danger",
        highlighted && "ring-2 ring-primary",
      )}
    >
      {!detailMode && (
        <div className="flex items-center gap-1 p-1.5" data-testid="card-simple">
          <button
            type="button"
            onClick={toggleStar}
            aria-pressed={managed}
            aria-label={managed ? "管理対象（★）をOFFにする" : "管理対象（★）にする"}
            className="flex size-9 shrink-0 items-center justify-center rounded-full"
          >
            <Star className={cn("size-[18px]", managed ? "fill-primary stroke-primary-ink" : "stroke-muted-foreground")} aria-hidden="true" />
          </button>
          <button
            type="button"
            onClick={openDetail}
            aria-label={`${storeLine} ${sum.name}の詳細を開く`}
            className="flex min-w-0 flex-1 items-center gap-2 rounded-lg py-0.5 text-left active:bg-muted/60"
          >
            <span className="flex h-14 w-12 shrink-0 items-center justify-center" data-testid="card-image">
              <ProductThumb product={firstProduct} heightClass="h-14" />
            </span>
            <span className="min-w-0 flex-1 space-y-0.5">
              <span className="block truncate text-[11px] text-muted-foreground">
                {storeLine}
                {display.prefecture && place && <span className="ml-1.5 rounded-full border px-1.5 py-px text-[10px]">{place}</span>}
              </span>
              <ProductLine name={sum.name} extra={sum.extraKinds} />
              {/* 応募漏れ防止: 締切と残り時間は一覧でも必ず出す */}
              <span className="flex flex-wrap items-center gap-x-1.5 gap-y-0.5 text-[11px]" data-testid="card-deadline">
                {finished ? (
                  <span className="text-muted-foreground">{EVENT_LABEL[event]}</span>
                ) : (
                  <>
                    {deadlineText ? (
                      <span className="inline-flex items-center gap-0.5 font-medium" aria-label={`応募締切 ${formatFlexible(lottery.applyDeadline)}`}>
                        <Clock className="size-3 text-primary-ink" aria-hidden="true" />
                        {deadlineText}
                      </span>
                    ) : (
                      <span className="text-muted-foreground">締切未確認</span>
                    )}
                    {event === "before" ? <Chip className="text-info">受付前</Chip> : <DeadlineBadgeView badge={badge} className="px-1 py-0.5 text-[11px]" />}
                  </>
                )}
                {notice === "unconfirmed" && <Chip className="border-danger font-bold text-danger">結果未確認</Chip>}
              </span>
            </span>
          </button>
          <MyApplyButton lottery={lottery} compact />
        </div>
      )}
      {detailMode && (
        <div data-testid="card-detail">
          {/* 上段: 画像｜（店舗・都道府県・距離／商品名／日時・受取方法／残り時間）。画像の列は固定幅、本文は残りの幅で折り返す */}
          <div className="relative grid grid-cols-[5rem_minmax(0,1fr)] items-start gap-2.5 px-2.5 pb-1.5 pt-2" data-testid="card-top">
            <span className="flex h-24 w-20 items-center justify-center" data-testid="card-image">
              <ProductThumb product={firstProduct} heightClass="h-24" />
            </span>
            <div role="button" tabIndex={0} aria-label={`${storeLine} ${sum.name}の詳細を開く`} onClick={openDetail} onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); openDetail(); } }} className="min-w-0 cursor-pointer space-y-1 text-left">
              {/* 店舗名（最大2行）→ 都道府県 → 距離。狭い幅では都道府県・距離が次の行へ折り返す */}
              <div className="flex flex-wrap items-center gap-x-1.5 gap-y-0.5 text-xs text-muted-foreground" data-testid="card-place">
                <span className="line-clamp-2 min-w-0 max-w-full break-words" data-testid="store-name">{storeLine}</span>
                {display.prefecture && place && <span data-testid="place-chip" className="shrink-0 rounded-full border bg-input px-1.5 py-px text-[11px] leading-none text-foreground">{place}</span>}
                {dist && lottery.receiveMethod !== "shipping" && (
                  <span data-testid="distance" title="自宅からの直線距離（道路距離ではありません）" className={cn("inline-flex shrink-0 items-center gap-0.5 whitespace-nowrap text-[11px] font-bold", BAND_CLASS[dist.band].split(" ").filter((c) => c.startsWith("text-")).join(" "))}>
                    <MapPin className="size-3.5" aria-hidden="true" />
                    {formatKm(dist.km)}
                  </span>
                )}
                {showFare && <span className="shrink-0 text-[11px]">¥{store!.roundTripFare!.toLocaleString("ja-JP")}</span>}
              </div>
              <ProductLine name={sum.name} quantity={display.quantity ? sum.quantity : undefined} extra={sum.extraKinds} className="text-sm" />
              <span className="grid gap-x-3 gap-y-1 text-xs [grid-template-columns:repeat(auto-fit,minmax(6.5rem,max-content))]">
                {display.deadline && (
                  <span className="inline-flex items-center gap-1" aria-label={`応募締切 ${formatFlexible(lottery.applyDeadline)}`}>
                    <Clock className="size-3.5 shrink-0 text-primary-ink" aria-hidden="true" />
                    <span className="font-medium">{deadlineText ?? "—"}</span>
                  </span>
                )}
                {display.announce && (
                  <span className="inline-flex items-center gap-1 text-muted-foreground" aria-label={`当選発表 ${formatFlexible(lottery.resultDate)}${period ? `〜${lottery.resultEndDate}` : ""}`}>
                    <CalendarCheck className="size-3.5 shrink-0" aria-hidden="true" />
                    {formatResultShort(lottery, now)}
                  </span>
                )}
              </span>
              {/* 受取方法（左）｜残り時間（右）。残り時間は応募ボタンの列の真上に出し、ボタンとは別の行なので重ならない */}
              <div className="flex flex-wrap items-center justify-between gap-x-2 gap-y-1" data-testid="card-meta">
                <span className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
                  {display.receive && (
                    <span className="inline-flex items-center gap-1" aria-label={`受取方法 ${RECEIVE_SHORT[lottery.receiveMethod]}`}>
                      {lottery.receiveMethod === "store" ? <StoreIcon className="size-3.5 shrink-0" aria-hidden="true" /> : <Truck className="size-3.5 shrink-0" aria-hidden="true" />}
                      {RECEIVE_SHORT[lottery.receiveMethod]}
                    </span>
                  )}
                  {display.applyMethod && <span>応募:{lottery.applyMethod === "unknown" ? "—" : APPLY_LABEL[lottery.applyMethod]}</span>}
                </span>
                <span className="ml-auto">
                  {event === "before" ? (
                    <Chip className="shrink-0 text-info">受付前</Chip>
                  ) : finished ? (
                    <Chip className="shrink-0 text-muted-foreground">{EVENT_LABEL[event]}</Chip>
                  ) : (
                    <DeadlineBadgeView badge={badge} />
                  )}
                </span>
              </div>
              {(event === "postponed" || notice || lottery.isNew || !managed || skipSource || skipException) && (
                <span className="flex flex-wrap gap-1">
                  {lottery.isNew && <Chip className="border-info text-info">NEW</Chip>}
                  {event === "postponed" && <Chip className="text-muted-foreground">{EVENT_LABEL[event]}</Chip>}
                  {notice === "unconfirmed" && <Chip className="border-danger font-bold text-danger">結果未確認</Chip>}
                  {notice === "in_period" && <Chip className="text-info">発表期間中</Chip>}
                  {!managed && <Chip className="text-muted-foreground">管理対象外</Chip>}
                  {skipSource && <Chip className="text-muted-foreground">{{ lottery: "今回スルー", store: "店舗スルー中", chain: "系列スルー中" }[skipSource]}</Chip>}
                  {!skipSource && skipException && <Chip className="text-muted-foreground">スルー例外</Chip>}
                </span>
              )}
            </div>
            {/* ★ は画像の左上（本文とは別の列なので重ならない） */}
            <button
              type="button"
              onClick={toggleStar}
              aria-pressed={managed}
              aria-label={managed ? "管理対象（★）をOFFにする" : "管理対象（★）にする"}
              className="absolute left-1.5 top-1.5 flex size-9 items-center justify-center rounded-full"
            >
              <span className="flex size-6 items-center justify-center rounded-full bg-card/90 shadow-sm">
                <Star className={cn("size-4", managed ? "fill-primary stroke-primary-ink" : "stroke-muted-foreground")} aria-hidden="true" />
              </span>
            </button>
          </div>

          {/* 下段: プロフィール別の応募状況（表示専用）｜現在のプロフィールの応募操作。同じ行に並べ、重ならない */}
          <div className="flex items-center justify-between gap-2 border-t px-2.5 py-1.5" data-testid="card-bottom">
            {display.accounts ? (
              <div onClick={openDetail} className="min-w-0 flex-1 cursor-pointer">
                <ApplyStatusRow lottery={lottery} />
              </div>
            ) : (
              <span className="flex-1" />
            )}
            <MyApplyButton lottery={lottery} />
          </div>
        </div>
      )}
      {tab === "won" && <WonActions lottery={lottery} />}

      <LotteryDetailSheet lottery={lottery} open={open} onOpenChange={onOpenChange} />
      <Dialog open={confirmOff} onOpenChange={setConfirmOff}>
        <DialogContent>
          <DialogTitle>管理対象（★）をOFFにしますか？</DialogTitle>
          <DialogDescription>★をOFFにすると「★管理対象」一覧から外れます。応募・当選・購入の履歴は消えません。「全情報」からいつでも戻せます。</DialogDescription>
          <div className="mt-4 flex justify-end gap-2">
            <Button variant="outline" onClick={() => setConfirmOff(false)}>
              キャンセル
            </Button>
            <Button
              variant="danger"
              onClick={() => {
                actions.setManaged(lottery.id, false);
                setConfirmOff(false);
              }}
            >
              ★をOFFにする
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </article>
  );
}

/** 当選タブ: 購入手続き／購入済みをワンアクションで。購入記録は応募ごとに1件のみ作成される。 */
function WonActions({ lottery }: { lottery: Lottery }) {
  const { data, actions } = useApp();
  const [busy, run] = useBusy();
  const idx = (accountId: string) => data.profiles.findIndex((p) => p.id === data.accounts.find((x) => x.id === accountId)?.profileId);
  const wonApps = data.applications.filter((a) => a.lotteryId === lottery.id && a.state === "applied" && a.result === "won").sort((a, b) => idx(a.accountId) - idx(b.accountId));
  return (
    <ul className="space-y-1 border-t px-2.5 py-1.5">
      {wonApps.map((a) => {
        const acc = data.accounts.find((x) => x.id === a.accountId)!;
        const owner = data.profiles.find((p) => p.id === acc.profileId)!;
        return (
          <li key={a.id} className="flex flex-wrap items-center gap-2 text-xs">
            <ProfileAvatar profile={owner} size="sm" />
            <span className="font-bold text-success">当選</span>
            {lottery.multiMode !== "single" && (
              <span className="text-muted-foreground">
                {lottery.items
                  .filter((i) => i.id && a.itemResults[i.id] === "won")
                  .map((i) => formatItem(i, data.products.find((p) => p.id === i.productId)))
                  .join(" / ")}
              </span>
            )}
            <span>期限 {formatFlexible(lottery.procedureDeadline)}</span>
            {a.fulfillment === "purchased" ? (
              <Chip className="border-success text-success">購入・受取済み</Chip>
            ) : (
              <>
                <Button size="sm" variant="outline" aria-pressed={a.fulfillment === "procedure_done"} disabled={busy || a.fulfillment === "procedure_done"} onClick={() => void run(() => actions.setFulfillment(a.id, "procedure_done"))}>
                  {a.fulfillment === "procedure_done" ? "手続き済み" : "購入手続き済み"}
                </Button>
                <Button size="sm" disabled={busy} onClick={() => void run(() => actions.setFulfillment(a.id, "purchased"))}>
                  購入済み
                </Button>
              </>
            )}
          </li>
        );
      })}
    </ul>
  );
}
