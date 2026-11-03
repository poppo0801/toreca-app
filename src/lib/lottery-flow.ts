import { formatShort, isPast, isResultFinished, isResultInPeriod, jstDateString, resultStartDay, formatResultShort } from "@/lib/datetime";
import type { AppData, Application, FlexibleDate, Lottery, LotteryKind } from "@/types/domain";

/**
 * 抽選の流れ（当落発表の状況・当選後の購入/受取の進み具合・継続抽選の整理）の判定。純関数。
 * 応募済みタブ・当選タブ・スワイプ操作・通知が、同じ判定を共用する。
 */

export const KIND_LABEL: Record<LotteryKind, string> = { normal: "通常抽選", ongoing: "継続抽選", invite: "招待制販売" };

export const kindOf = (l: Pick<Lottery, "kind">): LotteryKind => l.kind ?? "normal";

/** 現在のプロフィールの、有効な（取り消されていない）応募 */
export function myApplication(data: AppData, lotteryId: string, profileId: string): Application | undefined {
  const accountIds = new Set(data.accounts.filter((a) => a.profileId === profileId).map((a) => a.id));
  return data.applications.find((a) => a.lotteryId === lotteryId && a.state === "applied" && accountIds.has(a.accountId));
}

// ------------------------------------------------------------------ 継続抽選・招待制販売

/** 応募済みタブの「継続中の抽選」: 現在のプロフィールが応募中（結果待ち）の、通常でない抽選 */
export function ongoingFor(data: AppData, profileId: string): Lottery[] {
  return data.lotteries.filter((l) => kindOf(l) !== "normal" && myApplication(data, l.id, profileId)?.result === "pending");
}

export interface OngoingGroup {
  chainId: string;
  kind: LotteryKind;
  /** 招待制は商品ごと、継続抽選は複数商品を1応募にまとめて1行 */
  rows: { lottery: Lottery; label: string; state: string }[];
}

/** 系列単位に整理した、継続中の抽選の一覧（折りたたみ表示用） */
export function groupOngoing(data: AppData, profileId: string, productName: (productId: string) => string): OngoingGroup[] {
  const groups = new Map<string, OngoingGroup>();
  for (const l of ongoingFor(data, profileId)) {
    const kind = kindOf(l);
    const key = `${l.chainId}|${kind}`;
    const g = groups.get(key) ?? { chainId: l.chainId, kind, rows: [] };
    const label = l.items.length <= 1 ? productName(l.items[0]?.productId ?? "") : `対象商品${l.items.length}件`;
    g.rows.push({ lottery: l, label, state: kind === "invite" ? "招待待ち" : "抽選継続中" });
    groups.set(key, g);
  }
  return [...groups.values()].sort((a, b) => a.chainId.localeCompare(b.chainId));
}

// ------------------------------------------------------------------ 当落発表の状況

export type ResultStage = "unknown" | "before" | "in_period" | "overdue";

/** 発表の状況。unknown=発表日不明 / before=発表前 / in_period=発表日（期間中を含む） / overdue=発表日を過ぎている */
export function resultStage(l: Pick<Lottery, "resultDate" | "resultEndDate">, now: Date): ResultStage {
  if (l.resultDate.precision === "unknown") return "unknown";
  if (isResultFinished(l, now) === true) return "overdue";
  const start = resultStartDay(l);
  if (!start) return "unknown";
  const today = jstDateString(now);
  const started = l.resultDate.precision === "date_time" ? new Date(l.resultDate.at).getTime() <= now.getTime() : today >= start;
  if (started || isResultInPeriod(l, now)) return "in_period";
  return "before";
}

/** 発表基準のカウントダウン表示。発表日不明は null（無理に出さない） */
export function resultCountdown(l: Pick<Lottery, "resultDate" | "resultEndDate">, now: Date): { label: string; tone: "normal" | "warn" | "info" | "danger" } | null {
  const stage = resultStage(l, now);
  if (stage === "unknown") return null;
  if (stage === "overdue") return { label: "結果未確認", tone: "danger" };
  if (stage === "in_period") return { label: "発表期間中", tone: "info" };
  const start = resultStartDay(l)!;
  const days = Math.round((Date.parse(`${start}T00:00:00Z`) - Date.parse(`${jstDateString(now)}T00:00:00Z`)) / 86_400_000);
  if (l.resultDate.precision === "date_time") {
    const min = Math.floor((new Date(l.resultDate.at).getTime() - now.getTime()) / 60_000);
    if (min < 60) return { label: `あと${Math.max(min, 0)}分`, tone: "warn" };
    if (min < 1440) return { label: `あと${Math.floor(min / 60)}時間`, tone: "warn" };
  }
  return { label: `あと${days}日`, tone: days < 3 ? "warn" : "normal" };
}

/** 発表前の当落記録は確認ダイアログを出す（誤登録防止） */
export const needsResultConfirm = (l: Pick<Lottery, "resultDate" | "resultEndDate">, now: Date): boolean => resultStage(l, now) === "before";

// ------------------------------------------------------------------ 当選後の購入・受取

export type WonStage = "purchase" | "receive" | "done";
/** waiting_start=期間前 / open=期間中（または期限のみ） / overdue=期限超過 / unknown=期限未確認 / done=完了 */
export type WonStatus = "waiting_start" | "open" | "overdue" | "unknown" | "done";

export interface WonProgress {
  stage: WonStage;
  status: WonStatus;
  /** 次に押せる記録。なし=完了 */
  action: "purchase" | "receive" | null;
  /** 表示する期限 */
  deadline: FlexibleDate;
  /** カードに出す短い文言（例: 購入期限 11/7 / 受取可能 〜11/20 / 要確認（期限超過） / 完了） */
  label: string;
  /** スワイプでの記録を許すか（期間前は不可） */
  swipeable: boolean;
}

const UNKNOWN: FlexibleDate = { precision: "unknown" };

function startedOn(v: FlexibleDate, now: Date): boolean {
  if (v.precision === "unknown") return true;
  if (v.precision === "date_only") return jstDateString(now) >= v.date;
  return new Date(v.at).getTime() <= now.getTime();
}

/** 受取（または購入・受取共通）の期間 */
export function receivePeriod(l: Pick<Lottery, "procedureSplit" | "procedureStart" | "procedureDeadline" | "receiveStart" | "receiveDeadline">): { start: FlexibleDate; deadline: FlexibleDate } {
  return l.procedureSplit ? { start: l.receiveStart ?? UNKNOWN, deadline: l.receiveDeadline ?? UNKNOWN } : { start: l.procedureStart, deadline: l.procedureDeadline };
}

/**
 * 当選後の進み具合（プロフィール単位）。
 * 分離していない抽選は購入・受取が同じ期間で「受取を記録」だけ。分離している抽選は 購入 → 受取 の順。
 * fulfillment: none=未手続き / procedure_done=購入手続き済み（受取待ち） / purchased=受取済み（完了）。
 */
export function wonProgress(l: Lottery, app: Pick<Application, "fulfillment">, now: Date): WonProgress {
  if (app.fulfillment === "purchased") return { stage: "done", status: "done", action: null, deadline: UNKNOWN, label: "完了", swipeable: false };
  const split = l.procedureSplit === true;
  const purchaseStage = split && app.fulfillment === "none";
  const period = purchaseStage ? { start: l.procedureStart, deadline: l.procedureDeadline } : receivePeriod(l);
  const stage: WonStage = purchaseStage ? "purchase" : "receive";
  const action = purchaseStage ? "purchase" : "receive";
  const base = { stage, action, deadline: period.deadline } as const;

  if (period.deadline.precision !== "unknown" && isPast(period.deadline, now) === true) return { ...base, status: "overdue", label: "要確認（期限超過）", swipeable: true };
  if (!startedOn(period.start, now)) {
    const from = period.start.precision === "unknown" ? "" : formatShort(period.start);
    return { ...base, status: "waiting_start", label: `${from}から${stage === "purchase" ? "購入" : "受取"}`, swipeable: false };
  }
  if (period.deadline.precision === "unknown") return { ...base, status: "unknown", label: stage === "purchase" ? "購入期限未確認" : "受取期限未確認", swipeable: true };
  const until = formatShort(period.deadline);
  if (stage === "purchase") return { ...base, status: "open", label: `購入期限 ${until}`, swipeable: true };
  // 受取待ち: 購入済み（分離）または購入・受取共通の期間
  const inWindow = period.start.precision !== "unknown";
  return { ...base, status: "open", label: inWindow ? `受取可能 〜${until}` : `${split ? "受取期限" : "購入・受取期限"} ${until}`, swipeable: true };
}

/** 当選タブの並び: 要確認(期限超過) → 期限の近い順 → 期限未確認 → 完了 */
export function wonSortRank(p: WonProgress): number {
  if (p.status === "overdue") return 0;
  if (p.status === "done") return 4;
  if (p.status === "unknown" || p.status === "waiting_start") return 3;
  return 1;
}

/** 発表日の表示（太字で強調する用）。不明は「未確認」 */
export const resultDayText = (l: Pick<Lottery, "resultDate" | "resultEndDate">, now: Date): string => (l.resultDate.precision === "unknown" ? "発表日未確認" : formatResultShort(l, now));
