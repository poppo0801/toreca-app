"use client";

import { useState } from "react";
import { ChevronDown, ExternalLink, Star } from "lucide-react";
import { useApp } from "@/components/app-provider";
import { ProfileAvatar } from "@/components/profile-avatar";
import { Button } from "@/components/ui/button";
import { DuplicateDialog } from "@/components/duplicate-dialog";
import { LotteryFormDialog } from "@/components/lottery-form";
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { formatFlexible, remainingBadge } from "@/lib/datetime";
import { setLimitExemptionAction, setSkipExceptionAction } from "@/app/(app)/settings/rules/actions";
import { accountsForLottery, describeRule, effectiveEventState, effectiveRules, hasSkipException, judgeAccount, skipSourceFor } from "@/lib/eligibility";
import { formatItem, isManaged, isResultOverdue, type Tab } from "@/lib/lottery-view";
import { cn } from "@/lib/utils";
import type { AccountStatus, Application, EventState, Lottery, MultiMode, ReceiveMethod, ResultStatus } from "@/types/domain";

const MODE_LABEL: Record<MultiMode, string | null> = {
  single: null,
  all: "商品ごとに当落",
  one_win: "当選は1商品まで",
  choose_one: "1商品を選んで応募",
};

export const STATUS_META: Record<AccountStatus, { symbol: string; label: string }> = {
  applied: { symbol: "●", label: "応募済み" },
  eligible_unapplied: { symbol: "○", label: "未応募" },
  covered_by_limit: { symbol: "◎", label: "枠充足" },
  skipped: { symbol: "⤼", label: "スルー" },
  ineligible: { symbol: "－", label: "対象外" },
  unavailable: { symbol: "✕", label: "応募不可" },
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
  highlighted = false,
}: {
  lottery: Lottery;
  tab: Tab;
  detailMode: boolean;
  highlighted?: boolean;
}) {
  const { data, now, profile, actions, persistent, reload } = useApp();
  const [expanded, setExpanded] = useState(false);
  const [confirmOff, setConfirmOff] = useState(false);
  const [editing, setEditing] = useState(false);
  const [duplicating, setDuplicating] = useState(false);
  const [confirmArchive, setConfirmArchive] = useState(false);
  const [choosing, setChoosing] = useState<string | null>(null);
  const open = detailMode || expanded || highlighted;

  const chain = data.chains.find((c) => c.id === lottery.chainId);
  const store = data.stores.find((s) => s.id === lottery.storeId);
  const managed = isManaged(data, lottery.id);
  const event = effectiveEventState(lottery, now);
  const remaining = remainingBadge(lottery.applyDeadline, now);
  const overdue = isResultOverdue(data, lottery, now);
  const accounts = accountsForLottery(data, lottery);
  const apps = data.applications.filter((a) => a.lotteryId === lottery.id && a.state === "applied");
  const skipSource = skipSourceFor(data, profile.id, lottery);
  const mySkipped = skipSource !== null;
  const skipException = hasSkipException(data, profile.id, lottery);
  const rules = effectiveRules(data, lottery);
  const [ruleMsg, setRuleMsg] = useState<string | null>(null);
  const runRule = async (fn: () => Promise<{ ok: boolean; error?: string }>) => {
    const res = await fn();
    setRuleMsg(res.ok ? null : (res.error ?? "失敗しました"));
    if (res.ok) await reload();
  };
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
        highlighted && "ring-2 ring-primary",
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
            {mySkipped && <Chip className="text-muted-foreground">{{ lottery: "今回スルー", store: "店舗スルー中", chain: "系列スルー中" }[skipSource]}</Chip>}
            {!mySkipped && skipException && <Chip className="text-muted-foreground">スルー例外（今回だけ対象）</Chip>}
          </div>
          <ul className="mt-0.5 text-sm" data-testid="lottery-items">
            {(open ? lottery.items : lottery.items.slice(0, 1)).map((it, i) => (
              <li key={i}>
                {formatItem(it, data.products.find((p) => p.id === it.productId))}
                {open && it.id && <ItemResultTags lottery={lottery} itemId={it.id} apps={apps} />}
              </li>
            ))}
            {!open && lottery.items.length > 1 && (
              <li className="text-xs text-muted-foreground">＋他{lottery.items.length - 1}商品</li>
            )}
          </ul>
          {MODE_LABEL[lottery.multiMode] && (
            <Chip className="mt-0.5 border-info text-info">{MODE_LABEL[lottery.multiMode]}</Chip>
          )}
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
                  onClick={() => {
                    if (j.status !== "applied" && lottery.multiMode === "choose_one") setChoosing(acc.id);
                    else actions.setApplied(lottery.id, acc.id, j.status !== "applied");
                  }}
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

          <div>
            <p className="mb-1 text-xs font-bold">応募アカウント別の判定</p>
            <ul className="space-y-1 text-xs" data-testid="judge-list">
              {accounts.map((acc) => {
                const owner = data.profiles.find((p) => p.id === acc.profileId)!;
                const j = judgeAccount(data, lottery, acc, now);
                const exempt = data.limitExemptions.some((e) => e.lotteryId === lottery.id && e.accountId === acc.id);
                return (
                  <li key={acc.id} className="flex flex-wrap items-center gap-2">
                    <ProfileAvatar profile={owner} size="sm" />
                    <span className="font-medium">{acc.label}</span>
                    <span>
                      {STATUS_META[j.status].symbol} {STATUS_META[j.status].label}
                    </span>
                    <span className="text-muted-foreground">{j.reason}</span>
                    {exempt && <Chip className="text-muted-foreground">制限の例外（規約確認済み）</Chip>}
                    {persistent && (j.status === "covered_by_limit" || exempt) && (
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => runRule(() => setLimitExemptionAction(lottery.id, acc.id, !exempt, "規約を確認し、この抽選では別枠として応募可能", profile.id))}
                      >
                        {exempt ? "例外を解除" : "規約確認済みの例外にする"}
                      </Button>
                    )}
                  </li>
                );
              })}
            </ul>
            <p className="mt-1 text-xs text-muted-foreground" data-testid="rules-applied">
              適用される応募制限: {rules.length > 0 ? rules.map(describeRule).join(" ／ ") : "未確認（要確認）"}
            </p>
            {persistent && (skipSource === "store" || skipSource === "chain" || skipException) && (
              <div className="mt-1">
                <Button size="sm" variant="outline" onClick={() => runRule(() => setSkipExceptionAction(profile.id, lottery.id, !skipException, profile.id))}>
                  {skipException ? "今回だけの解除を取り消す" : `${profile.label}のスルーをこの抽選だけ解除`}
                </Button>
              </div>
            )}
            {ruleMsg && (
              <p role="alert" className="mt-1 text-xs text-danger">
                {ruleMsg}
              </p>
            )}
          </div>

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
                        {lottery.multiMode === "single" ? (
                          <>
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

          <div className="flex flex-wrap gap-2">
            <Button
              size="sm"
              variant="outline"
              aria-pressed={hasMyScopeSkip}
              onClick={() => actions.setLotterySkip(lottery.id, !hasMyScopeSkip)}
            >
              {hasMyScopeSkip ? `${profile.label}のスルーを解除` : `${profile.label}は今回スルー`}
            </Button>
            {lottery.eventState !== "cancelled" ? (
              <Button size="sm" variant="outline" onClick={() => actions.setEventState(lottery.id, "cancelled")}>
                中止にする
              </Button>
            ) : (
              <Button size="sm" variant="outline" onClick={() => actions.setEventState(lottery.id, "open")}>
                中止を取り消す
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
            {persistent && (
              <>
                <Button size="sm" variant="outline" onClick={() => setEditing(true)}>
                  編集
                </Button>
                <Button size="sm" variant="outline" onClick={() => setDuplicating(true)}>
                  他店舗に複製
                </Button>
                <Button size="sm" variant="outline" onClick={() => setConfirmArchive(true)}>
                  登録を取り下げる
                </Button>
              </>
            )}
          </div>
        </div>
      )}

      {editing && <LotteryFormDialog open lottery={lottery} onOpenChange={setEditing} />}
      {duplicating && <DuplicateDialog open lottery={lottery} onOpenChange={setDuplicating} />}
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
      <Dialog open={confirmArchive} onOpenChange={setConfirmArchive}>
        <DialogContent>
          <DialogTitle>この抽選の登録を取り下げますか？</DialogTitle>
          <DialogDescription>
            誤登録の整理用です。一覧から表示されなくなりますが、応募・当落・購入の記録はデータとして保持され、削除はされません。
          </DialogDescription>
          <div className="mt-4 flex justify-end gap-2">
            <DialogClose asChild>
              <Button variant="outline">キャンセル</Button>
            </DialogClose>
            <Button
              variant="danger"
              onClick={() => {
                actions.archiveLottery(lottery.id);
                setConfirmArchive(false);
              }}
            >
              取り下げる
            </Button>
          </div>
        </DialogContent>
      </Dialog>
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

/** 商品名の横に、ユーザーごとの当落を小さく添える（複数商品の詳細表示用） */
function ItemResultTags({ lottery, itemId, apps }: { lottery: Lottery; itemId: string; apps: Application[] }) {
  const { data } = useApp();
  if (lottery.multiMode === "single") return null;
  return (
    <span className="ml-2 inline-flex flex-wrap gap-1 align-middle">
      {apps.map((a) => {
        if (lottery.multiMode === "choose_one" && a.selectedItemId !== itemId) return null;
        const owner = data.profiles.find((p) => p.id === data.accounts.find((x) => x.id === a.accountId)?.profileId);
        if (!owner) return null;
        const r = a.itemResults[itemId] ?? "pending";
        return (
          <span key={a.id} className="inline-flex items-center gap-0.5 text-xs" data-testid="item-result-tag">
            <ProfileAvatar profile={owner} size="xs" />
            <span className={cn(r === "won" && "font-bold text-success")}>{RESULT_LABEL[r]}</span>
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
  const items = lottery.multiMode === "choose_one" ? lottery.items.filter((i) => i.id === app.selectedItemId) : lottery.items;
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
