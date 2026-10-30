"use client";

import { useState } from "react";
import { ExternalLink, Star } from "lucide-react";
import { useApp } from "@/components/app-provider";
import { DuplicateDialog } from "@/components/duplicate-dialog";
import { LotteryFormDialog } from "@/components/lottery-form";
import { ProductThumb } from "@/components/product-image";
import { ProfileAvatar } from "@/components/profile-avatar";
import { STATUS_META, StatusIcon } from "@/components/status-icon";
import { Button } from "@/components/ui/button";
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { Sheet, SheetBody, SheetContent, SheetDescription, SheetTitle } from "@/components/ui/sheet";
import { deadlineBadge, formatFlexible, formatMonthDay, hasResultPeriod, isResultFinished } from "@/lib/datetime";
import { ApplyStatusRow, DeadlineBadgeView, MyApplyButton } from "@/components/apply-status";
import { resultNotice } from "@/lib/lottery-summary";
import { accountsForLottery, describeRule, effectiveEventState, effectiveRules, hasSkipException, judgeAccount, skipSourceFor } from "@/lib/eligibility";
import { BAND_CLASS, formatKm } from "@/lib/geo";
import { APPLY_LABEL, EVENT_LABEL, LIMIT_BASIS_LABEL, MODE_LABEL, RECEIVE_LABEL, RESULT_LABEL } from "@/lib/lottery-labels";
import { formatItem, formatQuantity, isManaged } from "@/lib/lottery-view";
import { storeDistance } from "@/lib/store-distance";
import { setLimitExemptionAction, setSkipExceptionAction } from "@/app/(app)/settings/rules/actions";
import { cn } from "@/lib/utils";
import type { Application, Lottery } from "@/types/domain";

function Chip({ children, className, title }: { children: React.ReactNode; className?: string; title?: string }) {
  return (
    <span title={title} className={cn("inline-flex items-center rounded border px-1.5 py-0.5 text-xs", className)}>
      {children}
    </span>
  );
}

/** 項目名と値の1組。値が空なら「—」 */
function Field({ label, children, className }: { label: string; children: React.ReactNode; className?: string }) {
  return (
    <div className={cn("min-w-0", className)}>
      <dt className="text-[11px] text-muted-foreground">{label}</dt>
      <dd className="mt-0.5 break-words text-sm">{children}</dd>
    </div>
  );
}

const DASH = <span className="text-muted-foreground">—</span>;

/** 初期値のまま（未確認）の項目に付ける印 */
function Unconfirmed({ show }: { show: boolean }) {
  if (!show) return null;
  return <span className="ml-1 rounded border border-dashed px-1 text-[10px] text-muted-foreground">初期値・未確認</span>;
}

/**
 * 抽選の詳細（下から開くパネル）。重要な順に、商品 → 日時（2カラム）→ 方法 → URL → 条件・制限 → ユーザー別 → 備考・操作。
 * 閉じると一覧に戻り、スクロール位置は呼び出し側で維持する。
 */
export function LotteryDetailSheet({ lottery, open, onOpenChange }: { lottery: Lottery; open: boolean; onOpenChange: (v: boolean) => void }) {
  const { data, now, profile, actions, persistent, reload } = useApp();
  const [editing, setEditing] = useState(false);
  const [duplicating, setDuplicating] = useState(false);
  const [confirmArchive, setConfirmArchive] = useState(false);
  const [confirmOff, setConfirmOff] = useState(false);
  const [ruleMsg, setRuleMsg] = useState<string | null>(null);

  const chain = data.chains.find((c) => c.id === lottery.chainId);
  const store = data.stores.find((s) => s.id === lottery.storeId);
  const managed = isManaged(data, lottery.id);
  const event = effectiveEventState(lottery, now);
  const remaining = event === "closed" ? null : deadlineBadge(lottery.applyDeadline, now);
  const notice = resultNotice(data, lottery, now);
  const accounts = accountsForLottery(data, lottery);
  const apps = data.applications.filter((a) => a.lotteryId === lottery.id && a.state === "applied");
  const skipSource = skipSourceFor(data, profile.id, lottery);
  const skipException = hasSkipException(data, profile.id, lottery);
  const rules = effectiveRules(data, lottery);
  const hasMyScopeSkip = data.skipRules.some((r) => r.profileId === profile.id && r.scope === "lottery" && r.scopeId === lottery.id);
  const dist = storeDistance(data, store);
  const unconfirmed = lottery.unconfirmedFields ?? [];

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
                {chain?.name} {store?.name}
              </SheetTitle>
              <SheetDescription id="lottery-detail-desc">抽選の詳細</SheetDescription>
            </div>
            <button
              type="button"
              onClick={() => (managed ? setConfirmOff(true) : actions.setManaged(lottery.id, true))}
              aria-pressed={managed}
              aria-label={managed ? "管理対象（★）をOFFにする" : "管理対象（★）にする"}
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
                        <span className="block text-xs text-muted-foreground">{formatQuantity(it, p)}</span>
                        {it.id && <ItemResultTags lottery={lottery} itemId={it.id} apps={apps} />}
                      </span>
                    </li>
                  );
                })}
              </ul>
              <div className="flex flex-wrap items-center gap-1.5">
                {store?.prefecture && <Chip className="rounded-full">{store.prefecture}</Chip>}
                {dist && (
                  <Chip className={cn("rounded-full", BAND_CLASS[dist.band])} title="自宅からの直線距離（道路距離ではありません）">
                    直線 {formatKm(dist.km)}
                  </Chip>
                )}
                {store?.roundTripFare != null && <Chip className="rounded-full">往復交通費 {store.roundTripFare.toLocaleString("ja-JP")}円</Chip>}
                {MODE_LABEL[lottery.multiMode] && <Chip className="border-info text-info">{MODE_LABEL[lottery.multiMode]}</Chip>}
                {lottery.isNew && <Chip className="border-info text-info">NEW</Chip>}
                {EVENT_LABEL[event] && <Chip className="text-muted-foreground">{EVENT_LABEL[event]}</Chip>}
                {notice === "unconfirmed" && <Chip className="border-danger font-bold text-danger">結果未確認</Chip>}
                {notice === "in_period" && <Chip className="text-info">発表期間中</Chip>}
                {!managed && <Chip className="text-muted-foreground">管理対象外</Chip>}
              </div>
            </section>

            {/* 2. 日時（2カラム） */}
            <dl className="grid grid-cols-2 gap-x-3 gap-y-2 rounded-lg border p-3" aria-label="日時">
              <Field label="応募開始">{lottery.applyStart.precision === "unknown" ? DASH : formatFlexible(lottery.applyStart)}</Field>
              <Field label="応募締切">
                <span className={cn(lottery.applyDeadline.precision === "unknown" && "text-muted-foreground")}>
                  {lottery.applyDeadline.precision === "unknown" ? "—" : formatFlexible(lottery.applyDeadline)}
                </span>
                <DeadlineBadgeView badge={remaining} className="ml-1 px-1 py-0.5" />
              </Field>
              <Field label="当選発表">{lottery.resultDate.precision === "unknown" ? DASH : hasResultPeriod(lottery) ? `${formatFlexible(lottery.resultDate)}〜${formatMonthDay(lottery.resultEndDate!, now)}` : formatFlexible(lottery.resultDate)}</Field>
              <Field label="購入・受取期間">
                {lottery.procedureStart.precision === "unknown" && lottery.procedureDeadline.precision === "unknown"
                  ? DASH
                  : `${lottery.procedureStart.precision === "unknown" ? "" : formatFlexible(lottery.procedureStart)}〜${lottery.procedureDeadline.precision === "unknown" ? "" : formatFlexible(lottery.procedureDeadline)}`}
              </Field>
            </dl>

            {/* 3. 方法 */}
            <dl className="grid grid-cols-2 gap-x-3 gap-y-2" aria-label="方法">
              <Field label="応募方法">
                {lottery.applyMethod === "unknown" ? DASH : APPLY_LABEL[lottery.applyMethod]}
                <Unconfirmed show={unconfirmed.includes("applyMethod")} />
              </Field>
              <Field label="受取方法">
                {lottery.receiveMethod === "unknown" ? DASH : RECEIVE_LABEL[lottery.receiveMethod]}
                <Unconfirmed show={unconfirmed.includes("receiveMethod")} />
              </Field>
              <Field label="発表方法">{lottery.announcementMethod || DASH}</Field>
              <Field label="登録元">{{ manual: "手動", x_parse: "X解析（未確認）", auto: "自動取得", import: "インポート" }[lottery.sourceKind]}</Field>
            </dl>

            {/* 4. URL */}
            {(lottery.announcementUrl || lottery.sourceUrls.length > 0) && (
              <ul className="space-y-1 text-sm" aria-label="URL">
                {lottery.announcementUrl && (
                  <li>
                    <a href={lottery.announcementUrl} target="_blank" rel="noreferrer noopener" className="inline-flex items-center gap-1 text-info underline">
                      発表ページ <ExternalLink className="size-3" aria-hidden="true" />
                    </a>
                  </li>
                )}
                {lottery.sourceUrls.map((u) => (
                  <li key={u} className="truncate">
                    <a href={u} target="_blank" rel="noreferrer noopener" className="inline-flex max-w-full items-center gap-1 text-info underline">
                      <span className="truncate">{u}</span> <ExternalLink className="size-3 shrink-0" aria-hidden="true" />
                    </a>
                  </li>
                ))}
              </ul>
            )}

            {/* 5. 条件・制限 */}
            <dl className="space-y-2 rounded-lg border p-3" aria-label="応募条件・制限">
              <Field label="応募条件">{lottery.conditionsText || DASH}</Field>
              <div className="grid grid-cols-2 gap-x-3">
                <Field label="応募制限">
                  {lottery.limit.basis === "unknown" ? "未確認（要確認）" : `${LIMIT_BASIS_LABEL[lottery.limit.basis]}${lottery.limit.maxCount}回`}
                  <Unconfirmed show={unconfirmed.includes("limitBasis")} />
                </Field>
                <Field label="本人確認・書類">{lottery.verificationText || DASH}</Field>
              </div>
              <p className="text-xs text-muted-foreground" data-testid="rules-applied">
                適用される応募制限: {rules.length > 0 ? rules.map(describeRule).join(" ／ ") : "未確認（要確認）"}
              </p>
            </dl>

            {/* 6. ユーザー別の応募状況・当落（折りたたみ） */}
            <details open className="rounded-lg border" data-testid="user-section">
              <summary className="flex min-h-10 cursor-pointer items-center px-3 text-sm font-bold">ユーザー別の応募状況・当落</summary>
              <div className="space-y-3 border-t px-3 py-2">
                <div className="flex items-center justify-between gap-2">
                  <ApplyStatusRow lottery={lottery} />
                  <MyApplyButton lottery={lottery} />
                </div>
                <ul className="space-y-1.5 text-xs" data-testid="judge-list">
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
                          {STATUS_META[j.status].label}
                        </span>
                        <span className="text-muted-foreground">{j.reason}</span>
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
                              {lottery.multiMode === "single" ? (
                                <>
                                  <span className="text-xs">{RESULT_LABEL[a.result]}</span>
                                  <span className="flex gap-1" role="group" aria-label={`${owner.label}の結果を登録`}>
                                    {(["pending", "won", "lost"] as const).map((r) => (
                                      <Button key={r} size="sm" variant={a.result === r ? "default" : "outline"} aria-pressed={a.result === r} onClick={() => actions.setResult(a.id, r)}>
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
              </div>
            </details>

            {/* 7. 備考・操作 */}
            {lottery.memo && (
              <dl>
                <Field label="備考">
                  <span className="whitespace-pre-wrap">{lottery.memo}</span>
                </Field>
              </dl>
            )}
            <div className="flex flex-wrap gap-2">
              <Button size="sm" variant="outline" aria-pressed={hasMyScopeSkip} onClick={() => actions.setLotterySkip(lottery.id, !hasMyScopeSkip)}>
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
                  <Button size="sm" onClick={() => setEditing(true)}>
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
          </SheetBody>
        </SheetContent>
      </Sheet>

      {editing && <LotteryFormDialog open lottery={lottery} onOpenChange={setEditing} />}
      {duplicating && <DuplicateDialog open lottery={lottery} onOpenChange={setDuplicating} />}
      <Dialog open={confirmArchive} onOpenChange={setConfirmArchive}>
        <DialogContent>
          <DialogTitle>この抽選の登録を取り下げますか？</DialogTitle>
          <DialogDescription>誤登録の整理用です。一覧から表示されなくなりますが、応募・当落・購入の記録はデータとして保持され、削除はされません。</DialogDescription>
          <div className="mt-4 flex justify-end gap-2">
            <DialogClose asChild>
              <Button variant="outline">キャンセル</Button>
            </DialogClose>
            <Button
              variant="danger"
              onClick={() => {
                actions.archiveLottery(lottery.id);
                setConfirmArchive(false);
                onOpenChange(false);
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
          <DialogDescription>★をOFFにすると「★管理対象」一覧から外れます。応募・当選・購入の履歴は消えません。「全情報」からいつでも戻せます。</DialogDescription>
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

/** 商品名の下に、ユーザーごとの当落を小さく添える（複数商品） */
export function ItemResultTags({ lottery, itemId, apps }: { lottery: Lottery; itemId: string; apps: Application[] }) {
  const { data, now } = useApp();
  if (lottery.multiMode === "single") return null;
  const finished = isResultFinished(lottery, now) === true;
  return (
    <span className="mt-0.5 flex flex-wrap gap-1.5">
      {apps.map((a) => {
        if (lottery.multiMode === "choose_one" && a.selectedItemId !== itemId) return null;
        const owner = data.profiles.find((p) => p.id === data.accounts.find((x) => x.id === a.accountId)?.profileId);
        if (!owner) return null;
        const r = a.itemResults[itemId] ?? "pending";
        return (
          <span key={a.id} className="inline-flex items-center gap-0.5 text-xs" data-testid="item-result-tag">
            <ProfileAvatar profile={owner} size="xs" />
            <span className={cn(r === "won" && "font-bold text-success")}>{r === "pending" && finished ? "結果未確認" : RESULT_LABEL[r]}</span>
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
