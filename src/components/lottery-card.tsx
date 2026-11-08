"use client";

import { useEffect, useRef, useState } from "react";
import { AtSign, CalendarCheck, Clock, Globe, Mail, MapPin, Megaphone, MessageSquare, Phone, ShoppingBag, Smartphone, Star, Store as StoreIcon, Truck, type LucideIcon } from "lucide-react";
import { useApp } from "@/components/app-provider";
import { EXIT_STAR_WAIT_MS, useApplyExit } from "@/components/apply-exit";
import { useViewScope } from "@/components/user-scope";
import { FitLine } from "@/components/fit-line";
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
import { deadlineBadge, formatFlexible, formatFlexMdWTime, formatShort } from "@/lib/datetime";
import { effectiveEventState, hasSkipException, skipSourceFor } from "@/lib/eligibility";
import { DEADLINE_BAR_CLASS, EVENT_LABEL, RECEIVE_SHORT, APPLY_LABEL } from "@/lib/lottery-labels";
import { announceShort, placeInfo } from "@/lib/lottery-taxonomy";
import { extraKindsLabel, resultNotice, summarizeItems } from "@/lib/lottery-summary";
import { formatItem, isManaged, type Tab } from "@/lib/lottery-view";
import { ChainLogo } from "@/components/chain-logo";
import { CautionMark } from "@/components/caution-mark";
import { selectStoreDisplay } from "@/lib/applied-store";
import { EligibilityMark } from "@/components/eligibility-mark";
import { ResultButtons, ResultCountdownBadge } from "@/components/result-actions";
import { WonRow } from "@/components/won-actions";
import { displayPeriod, wonPeriodRows, myApplication, resultDayText, resultStage, wonProgress } from "@/lib/lottery-flow";
import { scopedApplications } from "@/lib/profile-link";
import { scrollToTop, scrollTopOf } from "@/lib/app-scroll";
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

/** 丸の中に￥（購入）。Lucide に該当が無いので共通のSVG。線幅・サイズは Lucide のアイコンに合わせる（24x24・線幅2・丸め端） */
export function YenCircleIcon({ className, ...rest }: React.SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={className} {...rest}>
      <circle cx="12" cy="12" r="10" />
      <path d="M8.5 7.5 12 12l3.5-4.5" />
      <path d="M12 12v5" />
      <path d="M9 12.5h6" />
      <path d="M9 15h6" />
    </svg>
  );
}

/** 期間のアイコン: 購入=丸に￥／受取=買い物袋。簡易・詳細・各タブで共通 */
function PeriodIcon({ label }: { label: "購入" | "受取" }) {
  const cls = "size-[1.15em] shrink-0 text-muted-foreground";
  return label === "受取" ? <ShoppingBag className={cls} aria-hidden="true" data-icon="receive" /> : <YenCircleIcon className={cls} aria-hidden="true" data-icon="purchase" />;
}

/** 期間1行。日付の途中で折り返さない */
function PeriodLine({ label, text }: { label: "購入" | "受取"; text: string | null }) {
  return (
    <FitLine innerProps={{ "data-testid": "period", "data-kind": label, title: `${label}期間`, "aria-label": `${label}期間 ${text ?? "未定"}` }}>
      <PeriodIcon label={label} />
      <span className={text ? "" : "text-muted-foreground"}>{text ?? "未定"}</span>
    </FitLine>
  );
}

/** 期間の1項目（アイコン＋日付）。2種類の日時を同じ1行に並べるときに使う（折り返さない） */
/** 一覧では年・曜日を省く（例: 11/7(土)〜11/9(月) → 11/7〜11/9）。詳細画面は正確な日付をそのまま出す */
export function compactPeriodText(t: string | null): string | null {
  return t ? t.replace(/[(（][日月火水木金土][)）]/g, "") : t;
}

function PeriodItem({ label, text }: { label: "購入" | "受取"; text: string | null }) {
  return (
    <span className="inline-flex items-center gap-1 whitespace-nowrap" data-testid="period" data-kind={label} title={`${label}期間`} aria-label={`${label}期間 ${text ?? "未定"}`}>
      <PeriodIcon label={label} />
      <span className={text ? "" : "text-muted-foreground"}>{text ?? "未定"}</span>
    </span>
  );
}

/** 当落発表方法のアイコンは、方法によらず拡声器に統一する（方法の違いは短い名称で示す） */
function AnnounceGlyph() {
  return <Megaphone className="size-3.5 shrink-0" aria-hidden="true" />;
}

/**
 * 日付表示Bタイプ（2行）。左の列=日付（左寄せ・長いものは省略）、右の列=受取方法・距離など（同じ列の文字は左端をそろえる）。
 * 同じ行の左右を1つのグリッドに置き、行がずれないようにする。右が無いときは左が全幅を使う。
 */
function DateBlockB({ left, right }: { left: React.ReactNode[]; right: React.ReactNode[] }) {
  const rows = Math.max(left.length, right.length);
  if (rows === 0) return null;
  return (
    <div className={cn("grid items-center gap-x-3 gap-y-0.5 text-[11px]", right.length > 0 ? "grid-cols-[minmax(0,1fr)_auto]" : "grid-cols-[minmax(0,1fr)]")} data-testid="card-dates-b">
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} className="contents" data-testid="date-b-row">
          <div className="min-w-0 whitespace-nowrap text-left" data-testid="date-b-left">{left[i]}</div>
          {right.length > 0 && <div className="min-w-0 whitespace-nowrap text-left text-muted-foreground" data-testid="date-b-right">{right[i]}</div>}
        </div>
      ))}
    </div>
  );
}

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
  const exit = useApplyExit();
  const viewScope = useViewScope();
  const detailMode = view === "detail";
  const display = settings.cardDisplay ?? data.settings?.cardDisplay ?? DEFAULT_CARD_DISPLAY;
  const [open, setOpen] = useState(false);
  // 詳細パネルを開いている間は、結果の記録などでカードが今のタブから外れても一覧に残す（パネルが閉じないように）。閉じたら外れていれば見送る
  const wasOpen = useRef(false);
  useEffect(() => {
    if (open === wasOpen.current) return;
    wasOpen.current = open;
    exit?.pin(lottery.id, open);
  }, [open, exit, lottery.id]);
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
  // 店舗選択式の抽選は、応募前は「店舗選択式」、応募後は現在のプロフィールが応募した店舗を出す（カードは1枚のまま）
  const selectStore = selectStoreDisplay(data, lottery, profile.id, viewScope);
  const storeLine = `${chain?.name ?? ""} ${selectStore ? selectStore.text : (store?.name ?? "")}`.trim();
  const dist = storeDistance(data, store);
  const placeI = placeInfo({ receiveMethod: lottery.receiveMethod, prefecture: store?.prefecture, storeKind: store?.salesKind });
  const place = placeI.label;
  // 往復交通費は、店頭で受け取る場合だけ意味がある（通販では出さない）
  const showFare = display.travelCost && store?.roundTripFare != null && lottery.receiveMethod !== "shipping";
  const barClass = event === "before" ? "border-l-info" : DEADLINE_BAR_CLASS[badge?.tone ?? "ended"];

  const openDetail = () => {
    scrollY.current = scrollTopOf();
    setOpen(true);
  };
  // 詳細を閉じたら、一覧のスクロール位置を元に戻す
  const onOpenChange = (v: boolean) => {
    setOpen(v);
    if (!v) requestAnimationFrame(() => scrollToTop(scrollY.current));
  };
  /** ★の切り替え。今のタブから外れる場合は、短い反応のあと横へスライドして消え、下のカードが詰まる（共通の退出アニメーション） */
  const setStar = async (v: boolean) => {
    const handle = exit?.begin(lottery.id, { waitMs: EXIT_STAR_WAIT_MS });
    try {
      const r = await actions.setManaged(lottery.id, v);
      if (r.ok) handle?.ok();
      else handle?.fail();
    } catch (e) {
      handle?.fail();
      throw e;
    }
  };
  const toggleStar = () => {
    if (managed) setConfirmOff(true); // ★OFFは確認ダイアログ
    else void setStar(true);
  };

  const appliedTab = tab === "applied";
  const wonTab = tab === "won";
  // 応募済みタブは発表日基準、当選タブは次の手続き（購入/受取）の期限を主役にする
  const mineApp = myApplication(data, lottery.id, profile.id);
  // 当選タブの期間表示は、現在のユーザー＋紐づくサブの当選から（自分が当選していれば自分を優先。購入・受取が済んでいない当選を先に）
  const wonScoped = wonTab ? scopedApplications(data, lottery.id, viewScope).filter((a) => a.result === "won") : [];
  const wonApp = wonTab ? (mineApp?.result === "won" ? mineApp : wonScoped.find((a) => a.fulfillment !== "purchased") ?? wonScoped[0]) : undefined;
  const won = wonApp ? wonProgress(lottery, wonApp, now) : null;
  const stage = appliedTab ? resultStage(lottery, now) : null;
  const deadlineText = lottery.applyDeadline.precision === "unknown" ? null : formatShort(lottery.applyDeadline);
  // 詳細カードの日付: 左=抽選締切（曜日つき・時刻あり） / 右=購入期間（購入と受取が分かれていれば受取期間。曜日つき・時刻なし。未設定は「未定」で、応募締切を代用しない）
  const deadlineW = formatFlexMdWTime(lottery.applyDeadline, now);
  const periodInfo = displayPeriod(lottery, now);
  const wonRows = wonTab ? wonPeriodRows(lottery, now) : [];
  const finished = event === "closed" || event === "cancelled";

  // Bタイプ（2行）の日付表示（Stage 7B）: 左=日付（左寄せ）、右=受取方法・距離など（左端をそろえる）。表示する項目はAタイプと同じ条件
  const dateB = detailMode && (settings.dateLayout ?? "a") === "b";
  const leftB: React.ReactNode[] = [];
  const rightB: React.ReactNode[] = [];
  if (dateB) {
    if (appliedTab) {
      leftB.push(
        <span key="r" className={cn("inline-flex min-w-0 items-center gap-1", stage === "unknown" && "text-muted-foreground")} data-testid="result-day" aria-label={`当選発表 ${formatFlexible(lottery.resultDate)}`}>
          <CalendarCheck className="size-[1.15em] shrink-0" aria-hidden="true" />
          <span className="truncate">{resultDayText(lottery, now)}</span>
        </span>,
        <PeriodItem key="p" label={periodInfo.label} text={compactPeriodText(periodInfo.text)} />,
      );
    } else if (wonTab && won) {
      for (const r of wonRows) leftB.push(<PeriodItem key={r.label} label={r.label} text={compactPeriodText(r.text)} />);
    } else {
      if (display.deadline) {
        leftB.push(
          <span key="d" className="inline-flex min-w-0 items-center gap-1" data-testid="deadline-day" aria-label={`応募締切 ${formatFlexible(lottery.applyDeadline)}`}>
            <Clock className="size-[1.15em] shrink-0 text-primary-ink" aria-hidden="true" />
            <span className="truncate">{deadlineW ?? "—"}</span>
          </span>,
        );
      }
      leftB.push(<PeriodItem key="p" label={periodInfo.label} text={periodInfo.text} />);
    }
    if (display.receive) {
      rightB.push(
        <span key="rc" className="inline-flex items-center gap-1" aria-label={`受取方法 ${RECEIVE_SHORT[lottery.receiveMethod]}`}>
          {lottery.receiveMethod === "store" ? <StoreIcon className="size-3.5 shrink-0" aria-hidden="true" /> : <Truck className="size-3.5 shrink-0" aria-hidden="true" />}
          {RECEIVE_SHORT[lottery.receiveMethod]}
        </span>,
      );
    }
    if (dist && placeI.showLocation) {
      rightB.push(
        <span key="ds" data-testid="distance" title="自宅からの直線距離（道路距離ではありません）" className={cn("inline-flex items-center gap-0.5 font-bold", BAND_CLASS[dist.band].split(" ").filter((c) => c.startsWith("text-")).join(" "))}>
          <MapPin className="size-3.5" aria-hidden="true" />
          {formatKm(dist.km)}
        </span>,
      );
    }
    if (display.applyMethod) rightB.push(<span key="am">応募:{lottery.applyMethod === "unknown" ? "—" : APPLY_LABEL[lottery.applyMethod]}</span>);
    if (appliedTab && announceShort(lottery.announcementMethods)) {
      rightB.push(
        <span key="an" className="inline-flex items-center gap-1" data-testid="announce-method" title="当落の発表方法（補足は詳細で確認できます）" aria-label={`当落発表方法 ${announceShort(lottery.announcementMethods)}`}>
          <AnnounceGlyph />
          {announceShort(lottery.announcementMethods)}
        </span>,
      );
    }
  }

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
        <div className="relative flex items-center gap-1.5 py-1.5 pl-1.5 pr-1.5" data-testid="card-simple">
          {/* ★ は詳細表示と同じカード左上端（画像の列を占有しない）。少し小さくして、店舗名の表示幅を広げる */}
          <button
            type="button"
            onClick={toggleStar}
            aria-pressed={managed}
            aria-label={managed ? "要チェック（★）をOFFにする" : "要チェック（★）にする"}
            data-testid="card-star"
            className="absolute left-0 top-0 z-10 flex size-8 items-center justify-center rounded-full"
          >
            <span className="flex size-5 items-center justify-center rounded-full bg-card/80">
              <Star className={cn("size-3.5", managed ? "fill-primary stroke-primary" : "stroke-muted-foreground")} aria-hidden="true" />
            </span>
          </button>
          <button
            type="button"
            onClick={openDetail}
            aria-label={`${storeLine} ${sum.name}の詳細を開く`}
            className="flex min-w-0 flex-1 items-center gap-2 rounded-lg py-0.5 text-left active:bg-muted/60"
          >
            <span className="ml-2 flex h-14 w-12 shrink-0 items-center justify-center" data-testid="card-image">
              <ProductThumb product={firstProduct} heightClass="h-14" />
            </span>
            <span className="min-w-0 flex-1 space-y-0.5">
              <span className="flex items-center gap-1 text-[11px] text-muted-foreground">
                <ChainLogo src={chain?.logoSrc} name={chain?.name ?? ""} className="size-4 my-0 rounded-[4px]" />
                <span className="min-w-0 truncate">{storeLine}</span>
                <CautionMark cautions={lottery.cautions} />
                {display.prefecture && place && <span className="ml-0.5 shrink-0 rounded-full border px-1.5 py-px text-[10px]">{place}</span>}
              </span>
              <ProductLine name={sum.name} extra={sum.extraKinds} />
              {/* 応募漏れ防止: 締切と残り時間は一覧でも必ず出す */}
              <span className="flex flex-wrap items-center gap-x-1.5 gap-y-0.5 text-[11px]" data-testid="card-deadline">
                {appliedTab ? (
                  <>
                    <FitLine className="inline-block w-auto" innerProps={{ className: cn("gap-0.5", stage === "unknown" && "text-muted-foreground"), "data-testid": "result-day" }}>
                      <CalendarCheck className="size-[1.1em] shrink-0" aria-hidden="true" />
                      {resultDayText(lottery, now)}
                    </FitLine>
                    <ResultCountdownBadge lottery={lottery} className="px-1 py-0.5 text-[11px]" />
                  </>
                ) : wonTab && won ? (
                  /* 当選: 購入・受取の期間（状態「期限超過」などは下段の操作エリアに1回だけ表示する） */
                  <span className="flex flex-col gap-y-0.5" data-testid="won-periods">
                    {wonRows.map((r) => (
                      <PeriodLine key={r.label} label={r.label} text={compactPeriodText(r.text)} />
                    ))}
                  </span>
                ) : finished ? (
                  <span className="text-muted-foreground">{EVENT_LABEL[event]}</span>
                ) : (
                  <>
                    {deadlineText ? (
                      <FitLine className="inline-block w-auto" innerProps={{ className: "gap-0.5 font-medium", "data-testid": "simple-deadline", "aria-label": `応募締切 ${formatFlexible(lottery.applyDeadline)}` }}>
                        <Clock className="size-[1.1em] text-primary-ink" aria-hidden="true" />
                        {deadlineText}
                      </FitLine>
                    ) : (
                      <span className="text-muted-foreground">締切未確認</span>
                    )}
                    {event === "before" ? <Chip className="text-info">受付前</Chip> : <DeadlineBadgeView badge={badge} className="px-1 py-0.5 text-[11px]" />}
                  </>
                )}
                {notice === "unconfirmed" && !appliedTab && <Chip className="border-danger font-bold text-danger">結果未確認</Chip>}
                {!appliedTab && !wonTab && <EligibilityMark lottery={lottery} />}
              </span>
            </span>
          </button>
          {appliedTab ? <ResultButtons lottery={lottery} compact onOpenDetail={openDetail} /> : wonTab ? null : <MyApplyButton lottery={lottery} compact />}
        </div>
      )}
      {detailMode && (
        <div data-testid="card-detail">
          {/* 上段: 画像｜（店舗・都道府県・距離／商品名／日時・受取方法／残り時間）。画像の列は固定幅、本文は残りの幅で折り返す */}
          <div className="relative grid grid-cols-[5rem_minmax(0,1fr)] items-start gap-2.5 px-3 pb-2 pt-3.5" data-testid="card-top">
            <span className="flex h-24 w-20 items-center justify-center" data-testid="card-image">
              <ProductThumb product={firstProduct} heightClass="h-24" />
            </span>
            <div role="button" tabIndex={0} aria-label={`${storeLine} ${sum.name}の詳細を開く`} onClick={openDetail} onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); openDetail(); } }} className="min-w-0 cursor-pointer space-y-1 text-left">
              {/* 店舗名（最大2行）→ 都道府県 → 距離。狭い幅では都道府県・距離が次の行へ折り返す */}
              <div className="flex min-w-0 flex-nowrap items-center gap-x-1.5 text-xs text-muted-foreground" data-testid="card-place">
                <ChainLogo src={chain?.logoSrc} name={chain?.name ?? ""} />
                <span className="min-w-0 flex-1 truncate" data-testid="store-name" title={selectStore ? `${storeLine}（${selectStore.title}）` : storeLine}>{storeLine}</span>
                {display.prefecture && place && <span data-testid="place-chip" className="shrink-0 whitespace-nowrap rounded-full border bg-input px-1.5 py-px text-[10px] leading-none text-foreground">{place}</span>}
                {display.prefecture && placeI.canShip && <span data-testid="ship-chip" className="shrink-0 whitespace-nowrap rounded-full border border-info px-1.5 py-px text-[10px] leading-none text-info">発送可</span>}
                {showFare && <span className="shrink-0 text-[11px]">¥{store!.roundTripFare!.toLocaleString("ja-JP")}</span>}
                <CautionMark cautions={lottery.cautions} />
              </div>
              <ProductLine name={sum.name} quantity={display.quantity ? sum.quantity : undefined} extra={sum.extraKinds} className="text-sm" />
              {dateB ? (
                <DateBlockB left={leftB} right={rightB} />
              ) : (
                <>
                {/* 日時は2種類あっても同じ1行に並べる（FitLineが実測し、余白→字間→行全体の文字サイズの順に詰める） */}
                <span className="block w-full min-w-0 text-[11px]" data-testid="card-dates">
                  <FitLine wrap={appliedTab || wonTab} innerProps={{ className: "gap-x-3 gap-y-0.5", "data-testid": "date-row" }}>
                    {appliedTab ? (
                      <>
                        {/* 応募済み: 当落発表日（発表期間）＋購入期間（分離していれば受取期間）。応募締切はカードに出さない（詳細で確認できる） */}
                        <span className={cn("inline-flex items-center gap-1 whitespace-nowrap", stage === "unknown" && "text-muted-foreground")} data-testid="result-day" aria-label={`当選発表 ${formatFlexible(lottery.resultDate)}`}>
                          <CalendarCheck className="size-[1.15em] shrink-0" aria-hidden="true" />
                          {resultDayText(lottery, now)}
                        </span>
                        <PeriodItem label={periodInfo.label} text={compactPeriodText(periodInfo.text)} />
                      </>
                    ) : wonTab && won ? (
                      wonRows.map((r) => <PeriodItem key={r.label} label={r.label} text={compactPeriodText(r.text)} />)
                    ) : (
                      <>
                        {display.deadline && (
                          <span className="inline-flex items-center gap-1 whitespace-nowrap" data-testid="deadline-day" aria-label={`応募締切 ${formatFlexible(lottery.applyDeadline)}`}>
                            <Clock className="size-[1.15em] shrink-0 text-primary-ink" aria-hidden="true" />
                            <span>{deadlineW ?? "—"}</span>
                          </span>
                        )}
                        <PeriodItem label={periodInfo.label} text={periodInfo.text} />
                      </>
                    )}
                  </FitLine>
                </span>
                {/* 受取方法と、店頭受取のときの自宅からの直線距離（通販・位置が未設定のときは出さない。推測しない）。残り時間は下段の操作ボタンの隣 */}
                <div className="flex flex-wrap items-center gap-x-3 gap-y-1" data-testid="card-meta">
                  <span className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-muted-foreground">
                    {display.receive && (
                      <span className="inline-flex items-center gap-1" aria-label={`受取方法 ${RECEIVE_SHORT[lottery.receiveMethod]}`}>
                        {lottery.receiveMethod === "store" ? <StoreIcon className="size-3.5 shrink-0" aria-hidden="true" /> : <Truck className="size-3.5 shrink-0" aria-hidden="true" />}
                        {RECEIVE_SHORT[lottery.receiveMethod]}
                      </span>
                    )}
                    {display.applyMethod && <span>応募:{lottery.applyMethod === "unknown" ? "—" : APPLY_LABEL[lottery.applyMethod]}</span>}
                    {/* 発表方法が未確認のときは、アイコン・文字とも項目ごと出さない */}
                    {appliedTab && announceShort(lottery.announcementMethods) && (
                      <span className="inline-flex items-center gap-1 whitespace-nowrap" data-testid="announce-method" title="当落の発表方法（補足は詳細で確認できます）" aria-label={`当落発表方法 ${announceShort(lottery.announcementMethods)}`}>
                        <AnnounceGlyph />
                        {announceShort(lottery.announcementMethods)}
                      </span>
                    )}
                  </span>
                  {dist && placeI.showLocation && (
                    <span data-testid="distance" title="自宅からの直線距離（道路距離ではありません）" className={cn("inline-flex shrink-0 items-center gap-0.5 whitespace-nowrap text-xs font-bold", BAND_CLASS[dist.band].split(" ").filter((c) => c.startsWith("text-")).join(" "))}>
                      <MapPin className="size-3.5" aria-hidden="true" />
                      {formatKm(dist.km)}
                    </span>
                  )}
                </div>
                </>
              )}
              {(event === "postponed" || notice || lottery.isNew || skipSource || skipException) && (
                <span className="flex flex-wrap gap-1">
                  {lottery.isNew && <Chip className="border-info text-info">NEW</Chip>}
                  {event === "postponed" && <Chip className="text-muted-foreground">{EVENT_LABEL[event]}</Chip>}
                  {notice === "unconfirmed" && !appliedTab && <Chip className="border-danger font-bold text-danger">結果未確認</Chip>}
                  {notice === "in_period" && !appliedTab && <Chip className="text-info">発表期間中</Chip>}
                  {skipSource && <Chip className="text-muted-foreground">{{ lottery: "今回スルー", store: "店舗スルー中", chain: "系列スルー中" }[skipSource]}</Chip>}
                  {!skipSource && skipException && <Chip className="text-muted-foreground">スルー例外</Chip>}
                </span>
              )}
              {!appliedTab && !wonTab && <EligibilityMark lottery={lottery} className="mt-1" />}
            </div>
            {/* ★ は画像の左上（本文とは別の列なので重ならない） */}
            <button
              type="button"
              onClick={toggleStar}
              aria-pressed={managed}
              aria-label={managed ? "要チェック（★）をOFFにする" : "要チェック（★）にする"}
              data-testid="card-star"
              className="absolute left-0 top-0 flex size-9 items-center justify-center rounded-full"
            >
              <span className="flex size-5 items-center justify-center rounded-full bg-card/80">
                <Star className={cn("size-4", managed ? "fill-primary stroke-primary" : "stroke-muted-foreground")} aria-hidden="true" />
              </span>
            </button>
          </div>

          {/* 下段: プロフィール別の応募状況（表示専用）｜現在のプロフィールの応募操作。同じ行に並べ、重ならない */}
          {!wonTab && (
            <div className="flex items-center justify-between gap-2 border-t px-3 py-1.5" data-testid="card-bottom">
              {display.accounts ? (
                <div onClick={openDetail} className="min-w-0 flex-1 cursor-pointer">
                  <ApplyStatusRow lottery={lottery} />
                </div>
              ) : (
                <span className="flex-1" />
              )}
              {/* 残り時間（締切まで／発表まで）は、操作ボタンのすぐ隣。ボタンの押しやすさは変えない */}
              <span className="flex shrink-0 items-center gap-1.5">
                {appliedTab ? (
                  <ResultCountdownBadge lottery={lottery} />
                ) : event === "before" ? (
                  <Chip className="shrink-0 text-info">受付前</Chip>
                ) : finished ? (
                  <Chip className="shrink-0 text-muted-foreground">{EVENT_LABEL[event]}</Chip>
                ) : (
                  <DeadlineBadgeView badge={badge} />
                )}
                {appliedTab ? <ResultButtons lottery={lottery} onOpenDetail={openDetail} /> : <MyApplyButton lottery={lottery} />}
              </span>
            </div>
          )}
        </div>
      )}
      {wonTab && <WonRow lottery={lottery} />}

      <LotteryDetailSheet lottery={lottery} open={open} onOpenChange={onOpenChange} />
      <Dialog open={confirmOff} onOpenChange={setConfirmOff}>
        <DialogContent>
          <DialogTitle>要チェック（★）をOFFにしますか？</DialogTitle>
          <DialogDescription>★をOFFにすると「要チェック」一覧から外れます。応募・当選・購入の履歴は消えません。「全情報」からいつでも戻せます。</DialogDescription>
          <div className="mt-4 flex justify-end gap-2">
            <Button variant="outline" onClick={() => setConfirmOff(false)}>
              キャンセル
            </Button>
            <Button
              variant="danger"
              onClick={() => {
                void setStar(false);
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
