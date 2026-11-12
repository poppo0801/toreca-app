"use client";

import { useEffect, useState } from "react";
import { chainStoreLine, isOnlineStore } from "@/lib/store-online";
import { markLotterySeen } from "@/app/(app)/lotteries/seen-actions";
import { ChevronDown, ExternalLink, Star, TriangleAlert } from "lucide-react";
import { useApp } from "@/components/app-provider";
import { DuplicateDialog } from "@/components/duplicate-dialog";
import { LotteryFormDialog } from "@/components/lottery-form";
import { ProductThumb } from "@/components/product-image";
import { ProfileAvatar } from "@/components/profile-avatar";
import { StatusIcon, statusLabelWithReason } from "@/components/status-icon";
import { Button } from "@/components/ui/button";
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { Sheet, SheetBody, SheetContent, SheetDescription, SheetTitle } from "@/components/ui/sheet";
import { deadlineBadge, formatMonthDay, formatPlain, hasResultPeriod, isResultFinished } from "@/lib/datetime";
import { ApplyStatusRow, DeadlineBadgeView, MyApplyButton } from "@/components/apply-status";
import { markLabel, profileMarks, receptionState, resultNotice, type ReceptionLabel } from "@/lib/lottery-summary";
import { OngoingOps } from "@/components/ongoing-ops";
import { PastApplyRecorder } from "@/components/past-apply-recorder";
import { WonRecordButtons } from "@/components/won-actions";
import { KIND_LABEL, kindOf, myApplication, wonProgress } from "@/lib/lottery-flow";
import { useViewScope } from "@/components/user-scope";
import { canOperateOwner, ownerIdOf, scopedApplications } from "@/lib/profile-link";
import { accountsForLottery, describeRule, effectiveEventState, effectiveRules, hasSkipException, judgeAccount, skipSourceFor } from "@/lib/eligibility";
import { BAND_CLASS, formatKm } from "@/lib/geo";
import { LotteryExcludeSheet } from "@/components/lottery-exclude-sheet";
import { LotteryGroupSheet } from "@/components/lottery-group-sheet";
import { APPLY_LABEL, MODE_LABEL, RECEIVE_LABEL, RESULT_LABEL, SERIAL_STEPS } from "@/lib/lottery-labels";
import { formatItem, formatQuantity, isManaged } from "@/lib/lottery-view";
import { boxHintLabel, boxHintOf } from "@/lib/product-kind";
import { AppliedStoreDialog } from "@/components/applied-store-dialog";
import { appliedStoreLabel } from "@/lib/applied-store";
import { storeDistance } from "@/lib/store-distance";
import { placeInfo } from "@/lib/lottery-taxonomy";
import { AnnounceView, NotesView, RequirementView } from "@/components/taxonomy-view";
import { RegistrationOrigin } from "@/components/registration-origin";
import { EligibilitySection } from "@/components/eligibility-mark";
import { acknowledgeCautionsAction } from "@/app/(app)/lotteries/actions";
import { addSkipRuleAction, removeSkipRuleAction, setLimitExemptionAction, setSkipExceptionAction } from "@/app/(app)/settings/rules/actions";
import { cn } from "@/lib/utils";
import { liveCautions } from "@/lib/live-cautions";
import { ItemPickerDialog } from "@/components/item-picker-dialog";
import { appliedItemsOf, isPerItemApply } from "@/lib/item-apply";
import type { Application, FlexibleDate, Lottery } from "@/types/domain";

function Chip({ children, className, title, ...rest }: { children: React.ReactNode; className?: string; title?: string; "data-testid"?: string }) {
  return (
    <span title={title} {...rest} className={cn("inline-flex items-center rounded border px-1.5 py-0.5 text-xs", className)}>
      {children}
    </span>
  );
}

const RECEPTION_TONE: Record<ReceptionLabel, string> = { 受付前: "text-info", 受付中: "text-success", 受付終了: "text-muted-foreground", 中止: "text-muted-foreground", 延期: "text-muted-foreground" };

/** 項目名と値の1組。値が空なら「—」 */
function Field({ label, children, className, valueClassName }: { label: string; children: React.ReactNode; className?: string; valueClassName?: string }) {
  return (
    <div className={cn("min-w-0", className)}>
      <dt className="text-[10px] leading-4 text-muted-foreground/70">{label}</dt>
      <dd className={cn("mt-0.5 break-words text-sm", valueClassName)}>{children}</dd>
    </div>
  );
}

const DASH = <span className="text-muted-foreground">—</span>;

/** 2列の左右の位置: 左は右側に、右は左側に同じ余白を取り、中央に薄い縦線を引く（上部の日付と下部の情報で共通） */
const SIDE_CLS = { l: "border-r border-border/70 pr-3", r: "pl-3" } as const;
/** 日時の途中で改行しない（改行は「〜」の位置だけ） */
const nb = (s: string) => <span className="whitespace-nowrap">{s}</span>;

/** 日付・期間の1項目（外枠なし。区切り線は一覧側で付ける）。項目名と日時を区別して表示する */
function DateCell({ label, children, span2, divider, side, testId }: { label: string; children: React.ReactNode; span2?: boolean; divider?: boolean; side?: "l" | "r"; testId?: string }) {
  return (
    <div className={cn("min-w-0 py-2", span2 && "col-span-2", divider && "border-b border-border/70", side && SIDE_CLS[side])} data-testid={testId ?? "date-card"} data-label={label}>
      <dt className="text-[10px] leading-4 text-muted-foreground/70">{label}</dt>
      <dd className="mt-0.5 break-words text-[13px] font-medium leading-snug">{children}</dd>
    </div>
  );
}

/**
 * 長文の項目（本人確認・書類など）。短い文章はそのまま、長い文章は3行で省略して「詳細を見る」で全文を展開する。
 * 省略は表示だけで、全文は常にDOMに保持する（情報の欠落なし）。
 */
const LONG_TEXT = 80;
function LongText({ text }: { text: string }) {
  const [open, setOpen] = useState(false);
  const long = text.length > LONG_TEXT || text.split("\n").length > 3;
  if (!long) return <span className="whitespace-pre-wrap break-words">{text}</span>;
  return (
    <span data-testid="long-text">
      <span className={cn("block whitespace-pre-wrap break-words", !open && "line-clamp-3")} data-testid="long-text-body">{text}</span>
      <button type="button" onClick={() => setOpen((v) => !v)} aria-expanded={open} className="mt-0.5 min-h-7 text-xs text-info underline" data-testid="long-text-toggle">
        {open ? "閉じる" : "詳細を見る"}
      </button>
    </span>
  );
}

/** 要確認ブロックの「確認済みにする」。表示中の注意をまとめて解除する（DBに保存。同じ内容では再表示しない） */
function AckButton({ lotteryId, codes }: { lotteryId: string; codes: string[] }) {
  const { reload } = useApp();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <div className="mt-2 flex items-center gap-2">
      <Button
        size="sm"
        variant="outline"
        className="h-8 px-3 text-xs"
        disabled={busy}
        data-testid="caution-ack"
        onClick={async () => {
          setBusy(true);
          const r = await acknowledgeCautionsAction(lotteryId, codes);
          setBusy(false);
          if (!r.ok) return setError(r.error);
          setError(null);
          await reload();
        }}
      >
        確認済みにする
      </Button>
      {error && (
        <span role="alert" className="text-danger">
          {error}
        </span>
      )}
    </div>
  );
}

/**
 * 上部のステータス行の右側: 対象となるアプリ内プロフィール全員の応募状態（アイコン＋記号だけ。長い文字は出さない）。
 * 詳細は下の「応募状況」。プロフィールの表示順は設定に従い、幅が足りないときは残りを「＋N」にする。現在のプロフィールは薄い背景で区別する。
 */
function StatusStrip({ lottery }: { lottery: Lottery }) {
  const { data, now, profile } = useApp();
  const order = (id: string) => data.profiles.findIndex((p) => p.id === id);
  const marks = profileMarks(data, lottery, now).sort((x, y) => order(x.profileId) - order(y.profileId));
  if (marks.length === 0) return null;
  const MAX = 4;
  const shown = marks.slice(0, MAX);
  const rest = marks.length - shown.length;
  return (
    <span className="inline-flex shrink-0 items-center gap-1.5" data-testid="status-strip" aria-label="プロフィール別の応募状況">
      {shown.map((m) => {
        const owner = data.profiles.find((p) => p.id === m.profileId);
        if (!owner) return null;
        const label = markLabel(m);
        const mine = owner.id === profile.id;
        return (
          <span
            key={m.accountId}
            role="img"
            aria-label={`${owner.label}: ${label}`}
            title={`${owner.label}: ${label}（${m.reason}）`}
            data-profile={owner.id}
            data-status={m.status}
            data-result={m.result}
            data-mine={mine ? "1" : undefined}
            className={cn("inline-flex items-center gap-0.5", mine && "rounded-full bg-muted/70 pr-1", m.status !== "applied" && m.status !== "needs_review" && "opacity-[0.45]")}
          >
            <ProfileAvatar profile={owner} size="xs" className={cn("size-[18px] text-[9px]", m.status !== "applied" && "grayscale")} />
            {m.status === "applied" && m.result === "won" ? <span className="text-[11px] font-bold leading-none text-success">当選</span> : m.status === "applied" && m.result === "lost" ? <span className="text-[11px] leading-none text-muted-foreground">落選</span> : <StatusIcon status={m.status} className="size-3.5" />}
          </span>
        );
      })}
      {rest > 0 && (
        <span className="text-[11px] text-muted-foreground" data-testid="status-strip-more">
          ＋{rest}
        </span>
      )}
    </span>
  );
}

/** 初期値のまま（未確認）の項目に付ける印 */
function Unconfirmed({ show }: { show: boolean }) {
  if (!show) return null;
  return <span className="ml-1 rounded border border-dashed px-1 text-[10px] text-muted-foreground">初期値・未確認</span>;
}

/** 応募店舗（店舗選択式の抽選）。応募記録＝プロフィールごとの店舗。未設定は「店舗未設定」と明示し、応募後も変更できる */
function AppliedStoreRow({ lottery, app, canEdit }: { lottery: Lottery; app: Application; canEdit: boolean }) {
  const { actions } = useApp();
  const [editing, setEditing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const label = appliedStoreLabel(app.appliedStore);
  return (
    <span className="inline-flex items-center gap-1 text-xs" data-testid="applied-store">
      <span className={label ? "" : "text-warn"}>{label ? `応募店舗: ${label}` : "店舗未設定"}</span>
      {canEdit && (
        <Button size="sm" variant="outline" className="h-7 px-2 text-xs" onClick={() => setEditing(true)} data-testid="applied-store-edit">
          {label ? "変更" : "設定"}
        </Button>
      )}
      {error && <span role="alert" className="text-danger">{error}</span>}
      {editing && (
        <AppliedStoreDialog
          lottery={lottery}
          initial={app.appliedStore ?? null}
          title="応募店舗を変更"
          allowUnset={false}
          onClose={() => setEditing(false)}
          onSubmit={async (store) => {
            const r = await actions.setAppliedStore(app.id, store);
            if (r && !r.ok) return setError(r.error);
            setError(null);
            setEditing(false);
          }}
        />
      )}
    </span>
  );
}

/**
 * 応募店舗が未設定の案内（Stage 7J）。「応募時に店舗選択」の抽選で、現在のプロフィールの応募済みの記録に店舗が無いとき、入力を求める。
 * 既存の応募履歴は変更しない（店舗だけを追加する）。他のプロフィールの店舗は変えない（他のプロフィールの分は下の「ユーザー別の結果」で確認・設定）。
 */
function StoreMissingNotice({ lottery }: { lottery: Lottery }) {
  const { data, profile } = useApp();
  const mine = lottery.storeMode === "select_on_apply" ? myApplication(data, lottery.id, profile.id) : undefined;
  if (!mine || mine.state !== "applied" || mine.appliedStore?.name) return null;
  return (
    <div className="rounded-md border border-warn px-2 py-1.5 text-xs" role="status" data-testid="applied-store-missing">
      <p className="font-medium text-warn">応募店舗が未設定です。応募した店舗を入力してください。</p>
      <div className="mt-1">
        <AppliedStoreRow lottery={lottery} app={mine} canEdit />
      </div>
    </div>
  );
}

/**
 * 抽選の詳細（下から開くパネル）。重要な順に、商品 → 日時（2カラム）→ 方法 → URL → 条件・制限 → ユーザー別 → 備考・操作。
 * 閉じると一覧に戻り、スクロール位置は呼び出し側で維持する。
 */
export function LotteryDetailSheet({ lottery, open, onOpenChange }: { lottery: Lottery; open: boolean; onOpenChange: (v: boolean) => void }) {
  const { data, now, profile, actions, persistent, reload } = useApp();
  const viewScope = useViewScope();
  // BOX販売形態の目安（個別の抽選で確定していればそれを、なければ系列の目安）。実際の受取状態とは別
  const boxHint = boxHintOf(lottery, data.chains.find((c) => c.id === lottery.chainId));
  const [editing, setEditing] = useState(false);
  const [duplicating, setDuplicating] = useState(false);
  const [grouping, setGrouping] = useState(false);
  const [confirmArchive, setConfirmArchive] = useState(false);
  const [confirmOff, setConfirmOff] = useState(false);
  const [confirmChainSkip, setConfirmChainSkip] = useState(false);
  const [confirmCancel, setConfirmCancel] = useState(false);
  const [ruleMsg, setRuleMsg] = useState<string | null>(null);

  // 詳細を開いたらNEWを解除する（確認済み）。保存先のあるモードのみ。表示中はこの回のNEWの印を残す
  const seenId = persistent && open && lottery.isNew ? lottery.id : null;
  useEffect(() => {
    if (!seenId) return;
    void markLotterySeen(seenId).then((r) => {
      if (r.ok) void reload();
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- 開いた時に1回だけ
  }, [seenId]);

  const chain = data.chains.find((c) => c.id === lottery.chainId);
  const store = data.stores.find((s) => s.id === lottery.storeId);
  const managed = isManaged(data, lottery.id);
  const event = effectiveEventState(lottery, now);
  // 抽選全体の受付状態（プロフィールの応募状況とは別に判定。日時が不明なときは断定しない）
  const reception = receptionState(lottery, now);
  const remaining = event === "closed" ? null : deadlineBadge(lottery.applyDeadline, now);
  const notice = resultNotice(data, lottery, now);
  const accounts = accountsForLottery(data, lottery);
  const profileIdx = (accountId: string) => data.profiles.findIndex((p) => p.id === data.accounts.find((x) => x.id === accountId)?.profileId);
  const apps = data.applications.filter((a) => a.lotteryId === lottery.id && a.state === "applied").sort((a, b) => profileIdx(a.accountId) - profileIdx(b.accountId));
  const skipSource = skipSourceFor(data, profile.id, lottery);
  const skipException = hasSkipException(data, profile.id, lottery);
  // 当選の購入・受取の記録は、現在のユーザーと紐づくサブの当選が対象（記録は応募の所有者に保存される）
  const scopedWon = scopedApplications(data, lottery.id, viewScope).filter((a) => a.result === "won");
  const rules = effectiveRules(data, lottery);
  const hasMyScopeSkip = data.skipRules.some((r) => r.profileId === profile.id && r.scope === "lottery" && r.scopeId === lottery.id);
  /** 現在のプロフィールの系列単位のスルー（設定 > 応募ルールのスルー一覧と同じもの） */
  const myChainSkip = data.skipRules.find((r) => r.profileId === profile.id && r.scope === "chain" && r.scopeId === lottery.chainId);
  const dist = storeDistance(data, store);
  const place = placeInfo({ receiveMethod: lottery.receiveMethod, prefecture: store?.prefecture, storeKind: store?.salesKind });
  const unconfirmed = lottery.unconfirmedFields ?? [];
  // 確認が必要な点は、保存時の解析結果ではなく現在の登録内容から再評価する（補った項目は自動で消える）
  const cautions = liveCautions(lottery, store);
  // 要確認の理由は全ユーザー分を繰り返さず、同じ内容を1つにまとめて出す
  const reviewReasons = [...new Set(accounts.map((acc) => judgeAccount(data, lottery, acc, now)).filter((j) => j.status === "needs_review").map((j) => j.reason))];

  const runRule = async (fn: () => Promise<{ ok: boolean; error?: string }>) => {
    const res = await fn();
    setRuleMsg(res.ok ? null : (res.error ?? "失敗しました"));
    if (res.ok) await reload();
  };

  return (
    <>
      <Sheet open={open} onOpenChange={onOpenChange}>
        <SheetContent data-testid="lottery-detail-sheet" aria-describedby="lottery-detail-desc">
          <div className="flex items-start gap-2 px-4 pb-2 pt-1">
            <div className="min-w-0 flex-1">
              <SheetTitle className="text-sm">
                {lottery.storeMode !== "select_on_apply" && chain && store && isOnlineStore(store, chain.name) ? chainStoreLine(chain.name, store, data.stores.filter((s) => s.chainId === chain.id)) : <>{chain?.name} {lottery.storeMode === "select_on_apply" ? "" : store?.name}</>}
                {lottery.storeMode === "select_on_apply" && (
                  <span className="ml-1 rounded border border-info px-1 py-0.5 text-[10px] font-medium text-info" data-testid="store-select-badge">
                    応募時に店舗選択
                  </span>
                )}
              </SheetTitle>
              <SheetDescription id="lottery-detail-desc">抽選の詳細</SheetDescription>
            </div>
            <button
              type="button"
              onClick={() => (managed ? setConfirmOff(true) : actions.setManaged(lottery.id, true))}
              aria-pressed={managed}
              aria-label={managed ? "要チェック（★）をOFFにする" : "要チェック（★）にする"}
              className="flex size-10 shrink-0 items-center justify-center rounded-md hover:bg-muted"
            >
              <Star className={cn("size-5", managed ? "fill-primary stroke-primary" : "stroke-muted-foreground")} aria-hidden="true" />
            </button>
          </div>

          <SheetBody data-testid="lottery-detail" className="space-y-4 border-t pt-3">
            {/* 1. 商品・数量 */}
            <section aria-label="商品" className="space-y-2">
              <ul className="space-y-2" data-testid="lottery-items">
                {lottery.items.map((it, i) => {
                  const p = data.products.find((x) => x.id === it.productId);
                  return (
                    <li key={it.id ?? i} className="flex items-center gap-3">
                      <span className="flex h-20 w-16 shrink-0 items-center justify-center">
                        <ProductThumb product={p} heightClass="h-20" />
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="block text-sm font-bold leading-snug">{p?.officialName ?? "商品未登録"}</span>
                        {it.unit === "box" && boxHint && (
                          <span className="mt-0.5 inline-block rounded border px-1 text-[10px] leading-4 text-muted-foreground" data-testid="box-hint" title="応募判断の目安です。実際の受取状態とは限りません">
                            {boxHintLabel(boxHint)}
                          </span>
                        )}
                        <span className="block text-xs text-muted-foreground">{formatQuantity(it, p)}</span>
                        {it.id && <ItemResultTags lottery={lottery} itemId={it.id} apps={apps} />}
                      </span>
                    </li>
                  );
                })}
              </ul>
              {/* ステータス行（原則1行）: 左=発送可・受付前などの抽選状態 / 右=現在のプロフィールの応募状態。詳細は下の「応募状況」 */}
              <div className="flex items-center justify-between gap-2" data-testid="status-line">
                <div className="flex min-w-0 flex-nowrap items-center gap-1 overflow-hidden" data-testid="status-left">
                  {place.canShip && <Chip className="shrink-0 rounded-full border-info text-info">発送可</Chip>}
                  {reception && <Chip className={cn("shrink-0", RECEPTION_TONE[reception])} data-testid="reception-chip">{reception}</Chip>}
                  {notice === "unconfirmed" && <Chip className="shrink-0 border-danger font-bold text-danger">結果未確認</Chip>}
                  {notice === "in_period" && <Chip className="shrink-0 text-info">発表期間中</Chip>}
                  {lottery.isNew && <Chip className="shrink-0 border-info text-info">NEW</Chip>}
                </div>
                <StatusStrip lottery={lottery} />
              </div>
              {(MODE_LABEL[lottery.multiMode] || !managed) && (
                <div className="flex flex-wrap items-center gap-1.5" data-testid="status-extra">
                  {MODE_LABEL[lottery.multiMode] && <Chip className="border-info text-info">{MODE_LABEL[lottery.multiMode]}</Chip>}
                  {!managed && <Chip className="text-muted-foreground">要チェック外</Chip>}
                </div>
              )}
            </section>

            {/* 注意付きで自動登録された抽選: 不足・相違している項目と理由（注意が無い抽選には出さない） */}
            {cautions.length > 0 && (
              <details aria-label="確認が必要な点" data-testid="caution-section" className="group rounded-lg border border-primary-ink/50 px-3 py-2 text-xs">
                <summary className="flex cursor-pointer list-none items-center gap-1 font-semibold text-primary-ink" data-testid="caution-summary">
                  <TriangleAlert className="size-3.5" aria-hidden="true" />
                  要確認（{cautions.length}件）
                  <ChevronDown className="ml-auto size-4 transition-transform group-open:rotate-180" aria-hidden="true" />
                </summary>
                <ul className="mt-1.5 list-disc space-y-1 pl-4 leading-relaxed">
                  {cautions.map((c) => (
                    <li key={c.code} className="break-words" data-testid={`caution-${c.code}`}>{c.message}</li>
                  ))}
                </ul>
                {persistent && <AckButton lotteryId={lottery.id} codes={cautions.map((c) => c.code)} />}
              </details>
            )}

            {/* 2. 日付・期間: 外枠なしの区切り線形式（2列）。奇数のときは最後を横いっぱいに */}
            {(() => {
              const cards: { key: string; label: string; body: React.ReactNode }[] = [
                { key: "start", label: "応募開始", body: lottery.applyStart.precision === "unknown" ? DASH : nb(formatPlain(lottery.applyStart)) },
                {
                  key: "deadline",
                  label: "応募締切",
                  body: (
                    <>
                      <span className={cn("whitespace-nowrap", lottery.applyDeadline.precision === "unknown" && "text-muted-foreground")}>{lottery.applyDeadline.precision === "unknown" ? "—" : formatPlain(lottery.applyDeadline)}</span>
                      <DeadlineBadgeView badge={remaining} className="ml-1 px-1 py-0.5" />
                    </>
                  ),
                },
                { key: "result", label: "当選発表", body: lottery.resultDate.precision === "unknown" ? DASH : hasResultPeriod(lottery) ? <>{nb(`${formatPlain(lottery.resultDate)}〜`)}{nb(formatMonthDay(lottery.resultEndDate!, now))}</> : nb(formatPlain(lottery.resultDate)) },
                { key: "procedure", label: lottery.procedureSplit ? "購入期間" : "購入・受取期間", body: periodText(lottery.procedureStart, lottery.procedureDeadline) },
                ...(lottery.procedureSplit ? [{ key: "receive", label: "受取期間", body: periodText(lottery.receiveStart ?? { precision: "unknown" }, lottery.receiveDeadline ?? { precision: "unknown" }) }] : []),
                ...(kindOf(lottery) !== "normal"
                  ? [{ key: "kind", label: "抽選方式", body: `${KIND_LABEL[kindOf(lottery)]}${lottery.validUntil ? `（有効期限 ${lottery.validUntil.slice(5).replace("-", "/")}）` : ""}` }]
                  : []),
              ];
              return (
                <dl className="grid grid-cols-2 px-[13px]" aria-label="日時" data-testid="date-cards">
                  {cards.map((c, i) => {
                    const rows = Math.ceil(cards.length / 2);
                    const row = Math.floor(i / 2);
                    const alone = cards.length % 2 === 1 && i === cards.length - 1;
                    return (
                      <DateCell key={c.key} label={c.label} span2={alone} divider={row < rows - 1} side={alone ? undefined : i % 2 === 0 ? "l" : "r"} testId={`date-${c.key}`}>
                        {c.body}
                      </DateCell>
                    );
                  })}
                </dl>
              );
            })()}

            {/* 3. 応募・受取情報: 関連する項目をグループ化し、細い罫線・縦の区切り線で整理する */}
            <div className="divide-y divide-border/70 rounded-lg border px-3 text-sm" data-testid="info-group" aria-label="応募・受取情報">
              <dl className="grid grid-cols-2">
                <Field label="応募方法" className={cn("py-2", SIDE_CLS.l)}>
                  {lottery.applyMethod === "unknown" ? DASH : APPLY_LABEL[lottery.applyMethod]}
                  <Unconfirmed show={unconfirmed.includes("applyMethod")} />
                  {lottery.applyMethod === "serial" && (
                    <span className="mt-0.5 block text-[11px] font-normal text-muted-foreground" data-testid="serial-steps">
                      {SERIAL_STEPS}
                    </span>
                  )}
                </Field>
                <Field label="受取方法" className={cn("py-2", SIDE_CLS.r)}>
                  {lottery.receiveMethod === "unknown" ? DASH : RECEIVE_LABEL[lottery.receiveMethod]}
                  <Unconfirmed show={unconfirmed.includes("receiveMethod")} />
                  {(place.label || (dist && place.showLocation) || store?.roundTripFare != null) && (
                    <span className="mt-0.5 flex flex-wrap items-center gap-1" data-testid="receive-meta">
                      {place.label && <Chip className="rounded-full" data-testid="detail-place">{place.label}</Chip>}
                      {dist && place.showLocation && (
                        <Chip className={cn("rounded-full", BAND_CLASS[dist.band])} title="自宅からの直線距離（道路距離ではありません）">
                          直線 {formatKm(dist.km)}
                        </Chip>
                      )}
                      {store?.roundTripFare != null && <Chip className="rounded-full">往復交通費 {store.roundTripFare.toLocaleString("ja-JP")}円</Chip>}
                    </span>
                  )}
                </Field>
              </dl>
              <dl>
                <Field label="発表方法" className="py-2">
                  <AnnounceView lottery={lottery} />
                </Field>
              </dl>
              <dl aria-label="応募条件・制限">
                <Field label="応募条件" className="py-2">
                  <RequirementView lottery={lottery} />
                </Field>
                <div className="pb-2">
                  <EligibilitySection lottery={lottery} />
                </div>
              </dl>
              {/* 応募制限: 抽選固有の制限は適用される制限に含まれるため、1項目に統合（未確認は警告扱いにしない） */}
              <dl aria-label="応募制限">
                <Field label="応募制限" className="py-2">
                  <span data-testid="rules-applied">{rules.length > 0 ? rules.map(describeRule).join(" ／ ") : <span className="text-muted-foreground">未確認</span>}</span>
                  <Unconfirmed show={unconfirmed.includes("limitBasis")} />
                </Field>
              </dl>
              <dl aria-label="本人確認・書類">
                <Field label="本人確認・書類" className="py-2">
                  {lottery.verificationText ? <LongText text={lottery.verificationText} /> : DASH}
                </Field>
              </dl>
            </div>

            {lottery.announcementUrl && (
              <p className="text-sm" aria-label="発表ページ">
                <a href={lottery.announcementUrl} target="_blank" rel="noreferrer noopener" className="inline-flex items-center gap-1 text-info underline">
                  発表ページ <ExternalLink className="size-3" aria-hidden="true" />
                </a>
              </p>
            )}

            {/* 6. 応募状況: 通常はアイコン＋状態マークの1行と、現在のユーザーの応募操作。理由の詳細は展開 */}
            <section aria-label="応募状況" className="rounded-lg border" data-testid="user-section">
              <div className="space-y-2 px-3 py-2">
                <div className="flex items-center justify-between gap-2">
                  <ApplyStatusRow lottery={lottery} />
                  <MyApplyButton lottery={lottery} />
                </div>
                <StoreMissingNotice lottery={lottery} />
                <AppliedItemsRow lottery={lottery} />
                {persistent && <PastApplyRecorder lottery={lottery} />}
                {persistent && <OngoingOps lottery={lottery} />}
                {persistent && scopedWon.map((w) => {
                  const wo = data.profiles.find((p) => p.id === ownerIdOf(data, w));
                  return (
                    <div key={w.id} className="flex flex-wrap items-center justify-between gap-2 rounded-md border px-2 py-1.5" data-testid="detail-won" data-owner={wo?.id}>
                      <span className="text-xs">
                        <span className="font-bold text-success">{wo?.label ?? ""}は当選</span>
                        <span className="ml-1.5 text-muted-foreground">{wonProgress(lottery, w, now).label}</span>
                      </span>
                      <WonRecordButtons lottery={lottery} app={w} ownerLabel={wo && wo.id !== profile.id ? wo.label : undefined} />
                    </div>
                  );
                })}
                {reviewReasons.length > 0 && (
                  <p className="flex items-start gap-1 text-xs text-warn" data-testid="review-summary">
                    <StatusIcon status="needs_review" className="mt-px size-3.5" />
                    <span>要確認: {reviewReasons.join(" ／ ")}</span>
                  </p>
                )}
                <details data-testid="user-details" className="text-xs">
                  <summary className="flex min-h-8 cursor-pointer items-center text-muted-foreground">状態の詳細</summary>
                <ul className="space-y-1.5 pt-1" data-testid="judge-list">
                  {accounts.map((acc) => {
                    const owner = data.profiles.find((p) => p.id === acc.profileId)!;
                    const j = judgeAccount(data, lottery, acc, now);
                    const exempt = data.limitExemptions.some((e) => e.lotteryId === lottery.id && e.accountId === acc.id);
                    return (
                      <li key={acc.id} className="flex flex-wrap items-center gap-x-2 gap-y-1">
                        <ProfileAvatar profile={owner} size="sm" />
                        <span className="font-medium">{acc.label}</span>
                        <span className="inline-flex items-center gap-1">
                          <StatusIcon status={j.status} className="size-4" />
                          {statusLabelWithReason(j.status, j.reason)}
                        </span>
                        {statusLabelWithReason(j.status, j.reason) !== j.reason && <span className="text-muted-foreground">{j.reason}</span>}
                        {exempt && <Chip className="text-muted-foreground">制限の例外（規約確認済み）</Chip>}
                        {persistent && (j.status === "covered_by_limit" || exempt) && (
                          <Button size="sm" variant="outline" onClick={() => runRule(() => setLimitExemptionAction(lottery.id, acc.id, !exempt, "規約を確認し、この抽選では別枠として応募可能", profile.id))}>
                            {exempt ? "例外を解除" : "規約確認済みの例外にする"}
                          </Button>
                        )}
                      </li>
                    );
                  })}
                </ul>
                </details>
                {persistent && (skipSource === "store" || skipSource === "chain" || skipException) && (
                  <Button size="sm" variant="outline" onClick={() => runRule(() => setSkipExceptionAction(profile.id, lottery.id, !skipException, profile.id))}>
                    {skipException ? "今回だけの解除を取り消す" : `${profile.label}のスルーをこの抽選だけ解除`}
                  </Button>
                )}
                {ruleMsg && (
                  <p role="alert" className="text-xs text-danger">
                    {ruleMsg}
                  </p>
                )}
                {apps.length > 0 && (
                  <div>
                    <p className="mb-1 text-xs font-bold">ユーザー別の結果</p>
                    <ul className="space-y-1.5">
                      {apps.map((a) => {
                        const acc = data.accounts.find((x) => x.id === a.accountId)!;
                        const owner = data.profiles.find((p) => p.id === acc.profileId)!;
                        return (
                          <li key={a.id} className="space-y-1">
                            <div className="flex flex-wrap items-center gap-2">
                              <ProfileAvatar profile={owner} size="sm" />
                              <span className="text-xs">{owner.label}</span>
                              {lottery.storeMode === "select_on_apply" && <AppliedStoreRow lottery={lottery} app={a} canEdit={canOperateOwner(data.profiles, profile.id, owner.id)} />}
                              {lottery.multiMode === "single" ? (
                                <>
                                  <span className="text-xs">{RESULT_LABEL[a.result]}</span>
                                  {canOperateOwner(data.profiles, profile.id, owner.id) && <span className="flex gap-1" role="group" aria-label={`${owner.label}の結果を登録`}>
                                    {(["pending", "won", "lost"] as const).map((r) => (
                                      <Button key={r} size="sm" variant={a.result === r ? "default" : "outline"} aria-pressed={a.result === r} onClick={() => actions.setResult(a.id, r)}>
                                        {RESULT_LABEL[r]}
                                      </Button>
                                    ))}
                                  </span>}
                                </>
                              ) : (
                                <span className="text-xs text-muted-foreground">全体: {RESULT_LABEL[a.result]}</span>
                              )}
                            </div>
                            {lottery.multiMode !== "single" && <ItemResultEditor lottery={lottery} app={a} ownerLabel={owner.label} />}
                          </li>
                        );
                      })}
                    </ul>
                  </div>
                )}
              </div>
            </section>

            {/* 7. 備考・操作 */}
            {lottery.memo && (
              <dl>
                <Field label="備考" valueClassName="text-[12.5px] leading-[1.45]">
                  <NotesView text={lottery.memo} />
                </Field>
              </dl>
            )}
            <div className="flex flex-wrap items-center gap-2" data-testid="main-ops">
              {persistent && (
                <Button size="sm" onClick={() => setEditing(true)}>
                  編集
                </Button>
              )}
              <Button size="sm" variant="outline" aria-pressed={hasMyScopeSkip} data-testid="skip-once" onClick={() => actions.setLotterySkip(lottery.id, !hasMyScopeSkip)}>
                {hasMyScopeSkip ? "今回のスルーを解除" : "今回のみスルー"}
              </Button>
              {persistent && chain && (
                <Button
                  size="sm"
                  variant="outline"
                  aria-pressed={!!myChainSkip}
                  data-testid="skip-chain"
                  onClick={() => (myChainSkip ? void runRule(() => removeSkipRuleAction(myChainSkip.id)) : setConfirmChainSkip(true))}
                >
                  {myChainSkip ? "この系列のスルーを解除" : "この系列はスルー"}
                </Button>
              )}
            </div>
            {/* 管理情報（重要度が低いもの）。確認が必要な注意・不足の警告はここに入れない（上部の「確認が必要な点」に出す） */}
            {/* 登録経路・情報元リンクは常時表示（折りたたまない）。情報元が無いときは登録経路だけで余白を作らない */}
            <div className="space-y-1 text-sm" data-testid="admin-info">
              <dl>
                <Field label="登録経路">
                  <RegistrationOrigin lottery={lottery} />
                </Field>
              </dl>
              {lottery.sourceUrls.length > 0 && (
                <ul className="space-y-0.5" aria-label="情報元リンク">
                  {lottery.sourceUrls.map((u) => (
                    <li key={u} className="min-w-0">
                      <a href={u} target="_blank" rel="noreferrer noopener" title={u} className="flex min-h-8 max-w-full items-center gap-1 text-xs text-info underline" data-testid="source-link">
                        <span className="min-w-0 truncate">{u.replace(/^https?:\/\//, "")}</span>
                        <ExternalLink className="size-3 shrink-0" aria-hidden="true" />
                      </a>
                    </li>
                  ))}
                </ul>
              )}
            </div>
            <details className="text-sm" data-testid="more-ops">
              <summary className="flex min-h-9 cursor-pointer items-center text-muted-foreground">その他の操作</summary>
              <div className="flex flex-wrap gap-2 pt-1">
                {persistent && (
                  <Button size="sm" variant="outline" onClick={() => setDuplicating(true)}>
                    他店舗に複製
                  </Button>
                )}
                {persistent && (
                  <Button size="sm" variant="outline" onClick={() => setGrouping(true)} data-testid="lottery-group-open">
                    {lottery.groupId ? "グループを管理" : "グループにまとめる"}
                  </Button>
                )}
                {lottery.eventState !== "postponed" ? (
                  <Button size="sm" variant="outline" onClick={() => actions.setEventState(lottery.id, "postponed")}>
                    発表延期にする
                  </Button>
                ) : (
                  <Button size="sm" variant="outline" onClick={() => actions.setEventState(lottery.id, "open")}>
                    延期を解除
                  </Button>
                )}
                {lottery.eventState !== "cancelled" ? (
                  <Button size="sm" variant="outline" onClick={() => setConfirmCancel(true)}>
                    中止にする
                  </Button>
                ) : (
                  <Button size="sm" variant="outline" onClick={() => actions.setEventState(lottery.id, "open")}>
                    中止を取り消す
                  </Button>
                )}
                {persistent && (
                  <Button size="sm" variant="danger" onClick={() => setConfirmArchive(true)} data-testid="lottery-exclude-open">
                    除外…
                  </Button>
                )}
              </div>
            </details>
          </SheetBody>
        </SheetContent>
      </Sheet>

      {editing && <LotteryFormDialog open lottery={lottery} onOpenChange={setEditing} />}
      {duplicating && <DuplicateDialog open lottery={lottery} onOpenChange={setDuplicating} />}
      {grouping && <LotteryGroupSheet anchor={lottery} onClose={() => setGrouping(false)} />}
      {/* 除外（理由つき。Stage 8U-1）: 抽選候補の除外と同じ理由の分類。削除はせず、応募・当落・購入の記録は保持される */}
      {confirmArchive && (
        <LotteryExcludeSheet
          lottery={lottery}
          onClose={() => setConfirmArchive(false)}
          onDone={() => {
            setConfirmArchive(false);
            onOpenChange(false);
          }}
        />
      )}
      <Dialog open={confirmCancel} onOpenChange={setConfirmCancel}>
        <DialogContent>
          <DialogTitle>この抽選を中止にしますか？</DialogTitle>
          <DialogDescription>応募できない状態として扱われます。あとから「中止を取り消す」で戻せます。応募・当落の記録は変わりません。</DialogDescription>
          <div className="mt-4 flex justify-end gap-2">
            <DialogClose asChild>
              <Button variant="outline">キャンセル</Button>
            </DialogClose>
            <Button
              variant="danger"
              onClick={() => {
                actions.setEventState(lottery.id, "cancelled");
                setConfirmCancel(false);
              }}
            >
              中止にする
            </Button>
          </div>
        </DialogContent>
      </Dialog>
      <Dialog open={confirmChainSkip} onOpenChange={setConfirmChainSkip}>
        <DialogContent>
          <DialogTitle>{chain?.name}をスルーしますか？</DialogTitle>
          <DialogDescription>
            {profile.label}の「{chain?.name}」の抽選がすべてスルー扱いになります（他のユーザーには影響しません）。応募・当選・購入の履歴は消えません。解除は、この画面か設定の応募ルールからいつでもできます。
          </DialogDescription>
          <div className="mt-4 flex justify-end gap-2">
            <DialogClose asChild>
              <Button variant="outline">キャンセル</Button>
            </DialogClose>
            <Button
              variant="danger"
              data-testid="skip-chain-confirm"
              onClick={() => {
                if (lottery.chainId) void runRule(() => addSkipRuleAction(profile.id, "chain", lottery.chainId as string, profile.id));
                setConfirmChainSkip(false);
              }}
            >
              この系列をスルーする
            </Button>
          </div>
        </DialogContent>
      </Dialog>
      <Dialog open={confirmOff} onOpenChange={setConfirmOff}>
        <DialogContent>
          <DialogTitle>要チェック（★）をOFFにしますか？</DialogTitle>
          <DialogDescription>★をOFFにすると「要チェック」一覧から外れます。応募・当選・購入の履歴は消えません。「全情報」からいつでも戻せます。</DialogDescription>
          <div className="mt-4 flex justify-end gap-2">
            <DialogClose asChild>
              <Button variant="outline">キャンセル</Button>
            </DialogClose>
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
    </>
  );
}

/** 期間の表示（開始〜終了。どちらか不明なら空側を省く。両方不明は「—」） */
function periodText(start: FlexibleDate, end: FlexibleDate): React.ReactNode {
  if (start.precision === "unknown" && end.precision === "unknown") return DASH;
  // 改行は「〜」の位置だけにする（日時の途中で折り返さない）
  return (
    <>
      {nb(`${start.precision === "unknown" ? "" : formatPlain(start)}〜`)}
      {end.precision === "unknown" ? null : nb(formatPlain(end))}
    </>
  );
}

/**
 * 複数商品（商品ごとに当落）の抽選で、現在のプロフィールが応募した商品（Stage 7M）。変更は現在のプロフィールの応募だけ。
 * 従来の記録で応募商品が特定できないときは、全商品として暫定表示し、実際に応募した商品を選んで確定するよう促す。
 */
function AppliedItemsRow({ lottery }: { lottery: Lottery }) {
  const { data, profile, actions } = useApp();
  const [editing, setEditing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const app = myApplication(data, lottery.id, profile.id);
  if (!isPerItemApply(lottery) || !app) return null;
  const { ids, confirmed } = appliedItemsOf(lottery, app);
  const nameOf = (id: string) => {
    const it = lottery.items.find((i) => i.id === id);
    return data.products.find((p) => p.id === it?.productId)?.officialName ?? "商品未登録";
  };
  const locked = lottery.items.flatMap((i) => (i.id && (app.itemResults[i.id] ?? "pending") !== "pending" ? [i.id] : []));
  const editable = app.fulfillment === "none";
  return (
    <div className="space-y-1 text-xs" data-testid="applied-items">
      <div className="flex items-start justify-between gap-2">
        <p className="min-w-0 flex-1">
          <span className="text-muted-foreground">応募商品: </span>
          <span className="break-words font-medium" data-testid="applied-items-names">{ids.map(nameOf).join("・") || "なし"}</span>
        </p>
        {editable && (
          <Button size="sm" variant="outline" className="h-7 shrink-0 px-2 text-xs" onClick={() => setEditing(true)} data-testid="applied-items-edit">
            {confirmed ? "変更" : "確認する"}
          </Button>
        )}
      </div>
      {!confirmed && (
        <p className="text-warn" data-testid="applied-items-unconfirmed">
          応募した商品が未確認です（全商品として表示しています）。実際に応募した商品を選んで確定してください。
        </p>
      )}
      {error && (
        <p role="alert" className="text-danger">
          {error}
        </p>
      )}
      {editing && (
        <ItemPickerDialog
          lottery={lottery}
          initial={ids}
          title="応募した商品を変更"
          confirmLabel="保存する"
          allowEmpty
          lockedIds={locked}
          onClose={() => setEditing(false)}
          onSubmit={async (picked) => {
            const r = await actions.setAppliedItems(app.id, picked);
            if (r && !r.ok) return setError(r.error);
            setError(null);
            setEditing(false);
          }}
        />
      )}
    </div>
  );
}

/** 当選した商品の購入記録（当選からの購入）があるか。商品別の購入済みの表示に使う */
function purchasedItem(data: { purchases: { applicationId: string | null; items: { lotteryItemId?: string | null }[] }[] }, applicationId: string, itemId: string): boolean {
  return data.purchases.some((p) => p.applicationId === applicationId && p.items.some((i) => i.lotteryItemId === itemId));
}

/** 商品名の下に、ユーザーごとの当落を小さく添える（複数商品） */
export function ItemResultTags({ lottery, itemId, apps }: { lottery: Lottery; itemId: string; apps: Application[] }) {
  const { data, now } = useApp();
  if (lottery.multiMode === "single") return null;
  const finished = isResultFinished(lottery, now) === true;
  return (
    <span className="mt-0.5 flex flex-wrap gap-1.5">
      {apps.map((a) => {
        if (lottery.multiMode === "choose_one" && a.selectedItemId !== itemId) return null;
        // 商品ごとに当落の抽選: そのプロフィールが応募した商品だけに当落を表示する
        if (isPerItemApply(lottery) && !appliedItemsOf(lottery, a).ids.includes(itemId)) return null;
        const owner = data.profiles.find((p) => p.id === data.accounts.find((x) => x.id === a.accountId)?.profileId);
        if (!owner) return null;
        const r = a.itemResults[itemId] ?? "pending";
        return (
          <span key={a.id} className="inline-flex items-center gap-0.5 text-xs" data-testid="item-result-tag">
            <ProfileAvatar profile={owner} size="xs" />
            <span className={cn(r === "won" && "font-bold text-success")}>{r === "pending" && finished ? "結果未確認" : RESULT_LABEL[r]}</span>
            {r === "won" && purchasedItem(data, a.id, itemId) && <span className="text-muted-foreground">・購入済み</span>}
          </span>
        );
      })}
    </span>
  );
}

/** 商品別の当落入力（B/C/D方式）。Cは当選1商品まで、Dは応募時に選んだ商品のみ。購入済みは変更不可。 */
function ItemResultEditor({ lottery, app, ownerLabel }: { lottery: Lottery; app: Application; ownerLabel: string }) {
  const { data, actions } = useApp();
  const locked = app.fulfillment === "purchased";
  const appliedIds = new Set(appliedItemsOf(lottery, app).ids);
  const items = lottery.multiMode === "choose_one" ? lottery.items.filter((i) => i.id === app.selectedItemId) : isPerItemApply(lottery) ? lottery.items.filter((i) => i.id && appliedIds.has(i.id)) : lottery.items;
  const wonId = Object.entries(app.itemResults).find(([, r]) => r === "won")?.[0];
  return (
    <ul className="ml-8 space-y-1" aria-label={`${ownerLabel}の商品別の当落`}>
      {items.map((it) => {
        const id = it.id!;
        const current = app.itemResults[id] ?? "pending";
        const name = formatItem(it, data.products.find((p) => p.id === it.productId));
        return (
          <li key={id} className="flex flex-wrap items-center gap-2 text-xs">
            <span className="min-w-0 flex-1 truncate">{name}</span>
            <span className="flex gap-1" role="group" aria-label={`${ownerLabel} ${name}の結果`}>
              {(["pending", "won", "lost"] as const).map((r) => (
                <Button
                  key={r}
                  size="sm"
                  variant={current === r ? "default" : "outline"}
                  aria-pressed={current === r}
                  disabled={locked || (r === "won" && lottery.multiMode === "one_win" && !!wonId && wonId !== id)}
                  onClick={() => actions.setItemResults(app.id, [{ itemId: id, result: r }])}
                >
                  {RESULT_LABEL[r]}
                </Button>
              ))}
            </span>
          </li>
        );
      })}
      {locked && <li className="text-xs text-muted-foreground">購入済みのため結果は変更できません</li>}
    </ul>
  );
}
