"use client";

import { useState } from "react";
import { ChevronDown, ExternalLink, Star } from "lucide-react";
import { useApp } from "@/components/app-provider";
import { ProfileAvatar } from "@/components/profile-avatar";
import { Button } from "@/components/ui/button";
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { formatFlexible, remainingBadge } from "@/lib/datetime";
import { accountsForLottery, effectiveEventState, isSkippedBy, judgeAccount } from "@/lib/eligibility";
import { formatItem, isManaged, isResultOverdue, type Tab } from "@/lib/lottery-view";
import { cn } from "@/lib/utils";
import type { AccountStatus, EventState, Lottery, ReceiveMethod, ResultStatus } from "@/types/domain";

export const STATUS_META: Record<AccountStatus, { symbol: string; label: string }> = {
  applied: { symbol: "●", label: "応募済み" },
  eligible_unapplied: { symbol: "○", label: "未応募" },
  covered_by_limit: { symbol: "◎", label: "枠充足" },
  skipped: { symbol: "⤼", label: "スルー" },
  ineligible: { symbol: "－", label: "対象外" },
  needs_review: { symbol: "？", label: "要確認" },
};

const EVENT_LABEL: Record<EventState, string | null> = {
  before: "受付前",
  open: null,
  closed: "受付終了",
  cancelled: "中止",
  postponed: "発表延期",
};

const RECEIVE_LABEL: Record<ReceiveMethod, string> = {
  store: "店頭受取",
  shipping: "発送",
  either: "店頭/発送",
  unknown: "受取方法未確認",
};

const RESULT_LABEL: Record<ResultStatus, string> = {
  pending: "未確認",
  won: "当選",
  lost: "落選",
  unknown: "不明",
};

const LEVEL_CLASS = {
  urgent: "border-danger text-danger",
  soon: "border-warn text-warn",
  today: "border-info text-info",
  normal: "text-muted-foreground",
  expired: "text-muted-foreground",
} as const;

function Chip({ children, className }: { children: React.ReactNode; className?: string }) {
  return (
    <span className={cn("inline-flex items-center rounded border px-1.5 py-0.5 text-xs", className)}>
      {children}
    </span>
  );
}

export function LotteryCard({
  lottery,
  tab,
  detailMode,
}: {
  lottery: Lottery;
  tab: Tab;
  detailMode: boolean;
}) {
  const { data, now, profile, actions } = useApp();
  const [expanded, setExpanded] = useState(false);
  const [confirmOff, setConfirmOff] = useState(false);
  const open = detailMode || expanded;

  const chain = data.chains.find((c) => c.id === lottery.chainId);
  const store = data.stores.find((s) => s.id === lottery.storeId);
  const managed = isManaged(data, lottery.id);
  const event = effectiveEventState(lottery, now);
  const remaining = remainingBadge(lottery.applyDeadline, now);
  const overdue = isResultOverdue(data, lottery, now);
  const accounts = accountsForLottery(data, lottery);
  const apps = data.applications.filter((a) => a.lotteryId === lottery.id && a.state === "applied");
  const mySkipped = isSkippedBy(data, profile.id, lottery);
  const hasMyScopeSkip = data.skipRules.some(
    (r) => r.profileId === profile.id && r.scope === "lottery" && r.scopeId === lottery.id,
  );

  const toggleStar = () => {
    if (managed) setConfirmOff(true); // ★OFFは確認ダイアログ
    else actions.setManaged(lottery.id, true);
  };

  return (
    <article
      data-testid="lottery-card"
      data-lottery-id={lottery.id}
      className={cn(
        "rounded-lg border bg-card p-3 text-card-foreground",
        overdue && "border-danger border-2",
      )}
    >
      {/* 1行目: ★ / 店舗 / バッジ / 残り時間 */}
      <div className="flex items-start gap-1">
        <button
          type="button"
          onClick={toggleStar}
          aria-pressed={managed}
          aria-label={managed ? "管理対象（★）をOFFにする" : "管理対象（★）にする"}
          className="-ml-1 -mt-1 flex size-11 shrink-0 items-center justify-center rounded-md hover:bg-muted"
        >
          <Star
            className={cn("size-5", managed ? "fill-primary stroke-primary" : "stroke-muted-foreground")}
            aria-hidden="true"
          />
        </button>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <h3 className="text-sm font-bold">
              {chain?.name} {store?.name}
            </h3>
            {lottery.isNew && <Chip className="border-info text-info">NEW</Chip>}
            {EVENT_LABEL[event] && <Chip className="text-muted-foreground">{EVENT_LABEL[event]}</Chip>}
            {overdue && <Chip className="border-danger font-bold text-danger">結果未登録（発表日超過）</Chip>}
            {!managed && <Chip className="text-muted-foreground">管理対象外</Chip>}
            {mySkipped && <Chip className="text-muted-foreground">スルー中</Chip>}
          </div>
          <ul className="mt-0.5 text-sm">
            {lottery.items.map((it, i) => (
              <li key={i}>{formatItem(it, data.products.find((p) => p.id === it.productId))}</li>
            ))}
          </ul>
        </div>
        {remaining && event !== "closed" && (
          <Chip className={cn("shrink-0 font-bold", LEVEL_CLASS[remaining.level])}>{remaining.label}</Chip>
        )}
      </div>

      {/* 2行目: 日付・受取 / 応募アカウント */}
      <div className="mt-1 flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
        <p className="text-xs text-muted-foreground">
          締切 {formatFlexible(lottery.applyDeadline)} ・ 発表 {formatFlexible(lottery.resultDate)} ・{" "}
          {RECEIVE_LABEL[lottery.receiveMethod]}
        </p>
        <ul className="flex flex-wrap items-center gap-1" aria-label="応募アカウントの状態">
          {accounts.map((acc) => {
            const owner = data.profiles.find((p) => p.id === acc.profileId)!;
            const j = judgeAccount(data, lottery, acc, now);
            const meta = STATUS_META[j.status];
            const toggleable =
              j.status === "applied" || j.status === "eligible_unapplied" || j.status === "needs_review";
            return (
              <li key={acc.id}>
                <button
                  type="button"
                  disabled={!toggleable}
                  onClick={() => actions.setApplied(lottery.id, acc.id, j.status !== "applied")}
                  aria-label={`${owner.label}: ${meta.label}（${j.reason}）`}
                  title={`${owner.label}: ${meta.label}（${j.reason}）`}
                  data-status={j.status}
                  data-account={acc.id}
                  className="flex min-h-9 items-center gap-0.5 rounded-full border px-1 disabled:opacity-70"
                >
                  <ProfileAvatar profile={owner} size="sm" />
                  <span aria-hidden="true" className="w-4 text-center text-sm">
                    {meta.symbol}
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      </div>

      {tab === "won" && (
        <WonActions lottery={lottery} />
      )}

      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        aria-expanded={open}
        disabled={detailMode}
        className="mt-1 flex min-h-9 items-center gap-1 text-xs text-muted-foreground disabled:opacity-0"
      >
        <ChevronDown className={cn("size-4 transition-transform", open && "rotate-180")} aria-hidden="true" />
        詳細
      </button>

      {open && (
        <div className="space-y-3 border-t pt-2 text-sm" data-testid="lottery-detail">
          <dl className="grid grid-cols-[7rem_1fr] gap-x-2 gap-y-1 text-xs">
            <dt className="text-muted-foreground">応募条件</dt>
            <dd>{lottery.conditionsText || "未入力"}</dd>
            <dt className="text-muted-foreground">応募制限</dt>
            <dd>
              {lottery.limit.basis === "unknown"
                ? "未確認（要確認）"
                : `${{ account: "1アカウント", person: "1人", family: "1家族", address: "1住所" }[lottery.limit.basis]}${lottery.limit.maxCount}回`}
            </dd>
            <dt className="text-muted-foreground">本人確認・書類</dt>
            <dd>{lottery.verificationText || "未入力"}</dd>
            <dt className="text-muted-foreground">発表方法</dt>
            <dd>
              {lottery.announcementMethod}
              {lottery.announcementUrl && (
                <a
                  href={lottery.announcementUrl}
                  target="_blank"
                  rel="noreferrer noopener"
                  className="ml-2 inline-flex items-center gap-0.5 underline"
                >
                  発表ページ <ExternalLink className="size-3" aria-hidden="true" />
                </a>
              )}
            </dd>
            <dt className="text-muted-foreground">購入・受取期限</dt>
            <dd>{formatFlexible(lottery.procedureDeadline)}</dd>
            <dt className="text-muted-foreground">登録元</dt>
            <dd>{{ manual: "手動", x_parse: "X解析（未確認）", auto: "自動取得", import: "インポート" }[lottery.sourceKind]}</dd>
            {lottery.memo && (
              <>
                <dt className="text-muted-foreground">メモ</dt>
                <dd>{lottery.memo}</dd>
              </>
            )}
          </dl>

          {apps.length > 0 && (
            <div>
              <p className="mb-1 text-xs font-bold">応募アカウント別の結果</p>
              <ul className="space-y-1">
                {apps.map((a) => {
                  const acc = data.accounts.find((x) => x.id === a.accountId)!;
                  const owner = data.profiles.find((p) => p.id === acc.profileId)!;
                  return (
                    <li key={a.id} className="flex flex-wrap items-center gap-2">
                      <ProfileAvatar profile={owner} size="sm" />
                      <span className="text-xs">{RESULT_LABEL[a.result]}</span>
                      <span className="flex gap-1" role="group" aria-label={`${owner.label}の結果を登録`}>
                        {(["pending", "won", "lost"] as const).map((r) => (
                          <Button
                            key={r}
                            size="sm"
                            variant={a.result === r ? "default" : "outline"}
                            aria-pressed={a.result === r}
                            onClick={() => actions.setResult(a.id, r)}
                          >
                            {RESULT_LABEL[r]}
                          </Button>
                        ))}
                      </span>
                    </li>
                  );
                })}
              </ul>
            </div>
          )}

          <div className="flex flex-wrap gap-2">
            <Button
              size="sm"
              variant="outline"
              aria-pressed={hasMyScopeSkip}
              onClick={() => actions.setLotterySkip(lottery.id, !hasMyScopeSkip)}
            >
              {hasMyScopeSkip ? `${profile.label}のスルーを解除` : `${profile.label}は今回スルー`}
            </Button>
          </div>
        </div>
      )}

      <Dialog open={confirmOff} onOpenChange={setConfirmOff}>
        <DialogContent>
          <DialogTitle>管理対象（★）をOFFにしますか？</DialogTitle>
          <DialogDescription>
            ★をOFFにすると「★管理対象」一覧から外れます。応募・当選・購入の履歴は消えません。「全情報」からいつでも戻せます。
          </DialogDescription>
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
    </article>
  );
}

/** 当選タブ: 購入手続き／購入済みをワンアクションで。購入記録は応募ごとに1件のみ作成される。 */
function WonActions({ lottery }: { lottery: Lottery }) {
  const { data, actions } = useApp();
  const wonApps = data.applications.filter(
    (a) => a.lotteryId === lottery.id && a.state === "applied" && a.result === "won",
  );
  return (
    <ul className="mt-2 space-y-1 border-t pt-2">
      {wonApps.map((a) => {
        const acc = data.accounts.find((x) => x.id === a.accountId)!;
        const owner = data.profiles.find((p) => p.id === acc.profileId)!;
        return (
          <li key={a.id} className="flex flex-wrap items-center gap-2 text-xs">
            <ProfileAvatar profile={owner} size="sm" />
            <span className="font-bold text-success">当選</span>
            <span>期限 {formatFlexible(lottery.procedureDeadline)}</span>
            {a.fulfillment === "purchased" ? (
              <Chip className="border-success text-success">購入・受取済み</Chip>
            ) : (
              <>
                <Button
                  size="sm"
                  variant="outline"
                  aria-pressed={a.fulfillment === "procedure_done"}
                  disabled={a.fulfillment === "procedure_done"}
                  onClick={() => actions.setFulfillment(a.id, "procedure_done")}
                >
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
