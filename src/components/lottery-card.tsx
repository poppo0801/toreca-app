"use client";

import { useRef, useState } from "react";
import { CalendarCheck, Clock, Star, Store as StoreIcon, Truck } from "lucide-react";
import { useApp } from "@/components/app-provider";
import { LotteryDetailSheet, ItemResultTags } from "@/components/lottery-detail-sheet";
import { ProductThumb } from "@/components/product-image";
import { ProfileAvatar } from "@/components/profile-avatar";
import { STATUS_META, StatusIcon } from "@/components/status-icon";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { DEFAULT_CARD_DISPLAY } from "@/lib/card-display";
import { formatFlexible, formatShort, remainingBadge } from "@/lib/datetime";
import { accountsForLottery, effectiveEventState, hasSkipException, judgeAccount, skipSourceFor } from "@/lib/eligibility";
import { BAND_CLASS, formatKm } from "@/lib/geo";
import { EVENT_LABEL, LEVEL_CLASS, RECEIVE_SHORT, APPLY_LABEL } from "@/lib/lottery-labels";
import { formatItem, formatQuantity, isManaged, isResultOverdue, type Tab } from "@/lib/lottery-view";
import { storeDistance } from "@/lib/store-distance";
import { cn } from "@/lib/utils";
import type { Lottery } from "@/types/domain";

export { STATUS_META };

function Chip({ children, className }: { children: React.ReactNode; className?: string }) {
  return <span className={cn("inline-flex items-center rounded border px-1.5 py-0.5 text-[11px] leading-none", className)}>{children}</span>;
}

const LEFT_BAR = {
  urgent: "border-l-danger",
  soon: "border-l-warn",
  today: "border-l-info",
  normal: "border-l-primary/70",
  expired: "border-l-border",
} as const;

/**
 * 抽選カード（一覧）。商品画像を左に大きく、正式な商品名・店舗・締切を流し見できる密度にまとめる。
 * カードをタップすると詳細（ボトムシート）が開く。★・ユーザー別の応募状況は一覧上で直接操作できる。
 * 不明な項目は「—」。重要な期限警告・結果未登録の警告は表示設定とは無関係に常に出す。
 */
export function LotteryCard({
  lottery,
  tab,
  detailMode,
  highlighted = false,
}: {
  lottery: Lottery;
  tab: Tab;
  /** true: 全商品を並べる（詳細表示）。false: 代表商品＋他N商品（コンパクト） */
  detailMode: boolean;
  highlighted?: boolean;
}) {
  const { data, now, profile, actions } = useApp();
  const display = data.settings?.cardDisplay ?? DEFAULT_CARD_DISPLAY;
  const [open, setOpen] = useState(false);
  const [confirmOff, setConfirmOff] = useState(false);
  const [choosing, setChoosing] = useState<string | null>(null);
  const scrollY = useRef(0);

  const chain = data.chains.find((c) => c.id === lottery.chainId);
  const store = data.stores.find((s) => s.id === lottery.storeId);
  const managed = isManaged(data, lottery.id);
  const event = effectiveEventState(lottery, now);
  const remaining = remainingBadge(lottery.applyDeadline, now);
  const overdue = isResultOverdue(data, lottery, now);
  const accounts = accountsForLottery(data, lottery);
  const apps = data.applications.filter((a) => a.lotteryId === lottery.id && a.state === "applied");
  const skipSource = skipSourceFor(data, profile.id, lottery);
  const skipException = hasSkipException(data, profile.id, lottery);
  const dist = display.distance ? storeDistance(data, store) : null;

  const first = lottery.items[0];
  const firstProduct = first ? data.products.find((p) => p.id === first.productId) : undefined;
  const shown = detailMode ? lottery.items : lottery.items.slice(0, 1);
  const hidden = lottery.items.length - shown.length;
  const storeLine = `${chain?.name ?? ""} ${store?.name ?? ""}`.trim();
  const level = remaining && event !== "closed" ? remaining.level : "normal";

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

  return (
    <article
      data-testid="lottery-card"
      data-lottery-id={lottery.id}
      className={cn(
        "relative rounded-xl border border-l-[3px] bg-card text-card-foreground shadow-card",
        LEFT_BAR[level],
        overdue && "border-2 border-danger",
        highlighted && "ring-2 ring-primary",
      )}
    >
      <button
        type="button"
        onClick={openDetail}
        aria-label={`${storeLine} ${firstProduct?.officialName ?? ""}の詳細を開く`}
        className="flex w-full items-start gap-2.5 rounded-xl p-2.5 text-left active:bg-muted/60"
      >
        <span className="flex h-24 w-20 shrink-0 items-center justify-center" data-testid="card-image">
          <ProductThumb product={firstProduct} heightClass="h-24" />
        </span>
        <span className="min-w-0 flex-1 space-y-1">
          <span className="block" data-testid="lottery-items">
            {shown.map((it, i) => {
              const p = data.products.find((x) => x.id === it.productId);
              return (
                <span key={it.id ?? i} className="block text-[13px] font-bold leading-snug">
                  <span className="line-clamp-2">
                    {p?.officialName ?? "商品未登録"}
                    {display.quantity && <span className="ml-1 text-xs font-normal text-muted-foreground">{formatQuantity(it, p)}</span>}
                  </span>
                  {detailMode && it.id && <ItemResultTags lottery={lottery} itemId={it.id} apps={apps} />}
                </span>
              );
            })}
            {hidden > 0 && <span className="block text-xs text-muted-foreground">＋他{hidden}商品</span>}
          </span>
          <span className="block truncate text-xs text-muted-foreground">{storeLine}</span>
          <span className="flex flex-wrap items-center gap-x-2.5 gap-y-1 text-xs">
            {display.deadline && (
              <span className="inline-flex items-center gap-1" aria-label={`応募締切 ${formatFlexible(lottery.applyDeadline)}`}>
                <Clock className="size-3.5 text-primary" aria-hidden="true" />
                <span className="font-medium">{formatShort(lottery.applyDeadline)}</span>
              </span>
            )}
            {remaining && event !== "closed" && <Chip className={cn("font-bold", LEVEL_CLASS[remaining.level])}>{remaining.label}</Chip>}
            {display.announce && (
              <span className="inline-flex items-center gap-1 text-muted-foreground" aria-label={`当選発表 ${formatFlexible(lottery.resultDate)}`}>
                <CalendarCheck className="size-3.5" aria-hidden="true" />
                {formatShort(lottery.resultDate)}
              </span>
            )}
            {display.receive && (
              <span className="inline-flex items-center gap-1 text-muted-foreground" aria-label={`受取方法 ${RECEIVE_SHORT[lottery.receiveMethod]}`}>
                {lottery.receiveMethod === "store" ? <StoreIcon className="size-3.5" aria-hidden="true" /> : <Truck className="size-3.5" aria-hidden="true" />}
                {RECEIVE_SHORT[lottery.receiveMethod]}
              </span>
            )}
            {display.applyMethod && <span className="text-muted-foreground">応募:{lottery.applyMethod === "unknown" ? "—" : APPLY_LABEL[lottery.applyMethod]}</span>}
          </span>
          {(EVENT_LABEL[event] || overdue || lottery.isNew || !managed || skipSource || skipException) && (
            <span className="flex flex-wrap gap-1">
              {lottery.isNew && <Chip className="border-info text-info">NEW</Chip>}
              {EVENT_LABEL[event] && <Chip className="text-muted-foreground">{EVENT_LABEL[event]}</Chip>}
              {overdue && <Chip className="border-danger font-bold text-danger">結果未登録（発表日超過）</Chip>}
              {!managed && <Chip className="text-muted-foreground">管理対象外</Chip>}
              {skipSource && <Chip className="text-muted-foreground">{{ lottery: "今回スルー", store: "店舗スルー中", chain: "系列スルー中" }[skipSource]}</Chip>}
              {!skipSource && skipException && <Chip className="text-muted-foreground">スルー例外</Chip>}
            </span>
          )}
        </span>
        {/* 右上: 都道府県ラベルと自宅からの直線距離（道路距離ではない）。位置情報がなければ出さない */}
        {((display.prefecture && store?.prefecture) || dist || (display.travelCost && store?.roundTripFare != null)) && (
          <span className="flex shrink-0 flex-col items-end gap-0.5 pl-1" data-testid="card-place">
            {display.prefecture && store?.prefecture && <span className="rounded-full border bg-input px-2 py-0.5 text-[11px] leading-none">{store.prefecture}</span>}
            {dist && (
              <span className={cn("text-[11px] font-semibold leading-none", BAND_CLASS[dist.band].split(" ")[1])} title="自宅からの直線距離" data-testid="card-distance">
                {formatKm(dist.km)}
              </span>
            )}
            {display.travelCost && store?.roundTripFare != null && <span className="text-[11px] leading-none text-muted-foreground">¥{store.roundTripFare.toLocaleString("ja-JP")}</span>}
          </span>
        )}
      </button>

      {/* ★ は画像の左上に重ねる（カードの他の部分はタップで詳細を開く） */}
      <button
        type="button"
        onClick={toggleStar}
        aria-pressed={managed}
        aria-label={managed ? "管理対象（★）をOFFにする" : "管理対象（★）にする"}
        className="absolute left-0.5 top-0.5 flex size-9 items-center justify-center rounded-full"
      >
        <span className="flex size-6 items-center justify-center rounded-full bg-card/90 shadow-sm">
          <Star className={cn("size-4", managed ? "fill-primary stroke-primary" : "stroke-muted-foreground")} aria-hidden="true" />
        </span>
      </button>

      {display.accounts && (
        <ul className="flex flex-wrap items-center gap-1.5 border-t px-2.5 py-1.5" aria-label="応募アカウントの状態">
          {accounts.map((acc) => {
            const owner = data.profiles.find((p) => p.id === acc.profileId)!;
            const j = judgeAccount(data, lottery, acc, now);
            const meta = STATUS_META[j.status];
            const toggleable = j.status === "applied" || j.status === "eligible_unapplied" || j.status === "needs_review";
            return (
              <li key={acc.id}>
                <button
                  type="button"
                  disabled={!toggleable}
                  onClick={() => {
                    if (j.status !== "applied" && lottery.multiMode === "choose_one") setChoosing(acc.id);
                    else actions.setApplied(lottery.id, acc.id, j.status !== "applied");
                  }}
                  aria-label={`${owner.label}: ${meta.label}（${j.reason}）`}
                  title={`${owner.label}: ${meta.label}（${j.reason}）`}
                  data-status={j.status}
                  data-account={acc.id}
                  className={cn("flex min-h-9 items-center gap-1 rounded-full border bg-input px-1.5 disabled:opacity-80", j.status === "eligible_unapplied" && "border-primary")}
                >
                  <ProfileAvatar profile={owner} size="xs" />
                  <StatusIcon status={j.status} />
                </button>
              </li>
            );
          })}
        </ul>
      )}

      {tab === "won" && <WonActions lottery={lottery} />}

      <LotteryDetailSheet lottery={lottery} open={open} onOpenChange={onOpenChange} />
      <Dialog open={choosing !== null} onOpenChange={(v) => !v && setChoosing(null)}>
        <DialogContent>
          <DialogTitle>応募する商品を選択</DialogTitle>
          <DialogDescription>この抽選は、複数商品から希望の1つを選んで応募します。選んだ商品はユーザーごとに記録されます。</DialogDescription>
          <ul className="mt-3 space-y-1.5">
            {lottery.items.map((it) => (
              <li key={it.id}>
                <Button
                  variant="outline"
                  className="w-full justify-start"
                  onClick={async () => {
                    const accId = choosing;
                    setChoosing(null);
                    if (accId && it.id) await actions.setApplied(lottery.id, accId, true, it.id);
                  }}
                >
                  {formatItem(it, data.products.find((p) => p.id === it.productId))}
                </Button>
              </li>
            ))}
          </ul>
        </DialogContent>
      </Dialog>
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
  const wonApps = data.applications.filter((a) => a.lotteryId === lottery.id && a.state === "applied" && a.result === "won");
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
                <Button size="sm" variant="outline" aria-pressed={a.fulfillment === "procedure_done"} disabled={a.fulfillment === "procedure_done"} onClick={() => actions.setFulfillment(a.id, "procedure_done")}>
                  {a.fulfillment === "procedure_done" ? "手続き済み" : "購入手続き済み"}
                </Button>
                <Button size="sm" onClick={() => actions.setFulfillment(a.id, "purchased")}>
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
