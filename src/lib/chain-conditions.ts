import { jstDateString } from "@/lib/datetime";
import { isCardPurchase } from "@/lib/expense-category";
import type { RequirementTag } from "@/lib/lottery-taxonomy";
import type { AppData, FlexibleDate, Lottery } from "@/types/domain";

/**
 * 系列別の抽選条件（Stage 5R）の純関数。画面・サーバー・テストで共用する。
 * 条件は応募資格の「目安」であり、応募の可否を制御しない（注意喚起のみ）。AI解析は系列共通条件を変更しない。
 */

// ------------------------------------------------------------------ 標準カテゴリ
export const COND_KINDS = [
  { code: "purchase", label: "購入履歴", short: "購入" },
  { code: "member_card", label: "会員証・ポイントカード", short: "会員" },
  { code: "partner_card", label: "提携クレジットカード", short: "提携カード" },
  { code: "newsletter", label: "メルマガ", short: "メルマガ" },
  { code: "app_account", label: "公式アプリ・会員アカウント", short: "アプリ" },
  { code: "line", label: "LINE友だち登録", short: "LINE" },
  { code: "identity", label: "本人確認", short: "認証" },
  { code: "area", label: "地域・店舗制限", short: "地域" },
  { code: "payment", label: "指定決済方法", short: "決済" },
  { code: "event", label: "イベント参加", short: "イベント" },
  { code: "tournament", label: "公式大会参加", short: "大会" },
  { code: "gym_battle", label: "ジムバトル参加", short: "ジム" },
  { code: "other", label: "その他", short: "その他" },
] as const;
export type CondKind = (typeof COND_KINDS)[number]["code"];
export const COND_KIND_CODES: readonly string[] = COND_KINDS.map((k) => k.code);
export const isCondKind = (v: unknown): v is CondKind => typeof v === "string" && COND_KIND_CODES.includes(v);
export const kindLabel = (k: CondKind) => COND_KINDS.find((x) => x.code === k)?.label ?? "その他";
export const kindShort = (k: CondKind) => COND_KINDS.find((x) => x.code === k)?.short ?? "その他";

/** 既存の抽選ごとの応募条件タグ（AI解析・手動）を、系列条件の標準カテゴリへ対応づける。対応なしは null（比較しない） */
const TAG_TO_KIND: Partial<Record<RequirementTag, CondKind>> = {
  member_registration: "app_account",
  member_card: "member_card",
  app_member: "app_account",
  purchase_history: "purchase",
  purchase_amount: "purchase",
  purchase_period: "purchase",
  id_check: "identity",
  photo_id: "identity",
  other_verification: "identity",
  line_register: "line",
  resident_area: "area",
  designated_store: "area",
  in_store_apply: "area",
  in_store_receive: "area",
  x_account: "other",
  x_follow: "other",
  x_repost: "other",
  livepocket_account: "other",
  other_account: "other",
};
export const kindOfRequirementTag = (t: RequirementTag): CondKind | null => TAG_TO_KIND[t] ?? null;

export type CondState = "met" | "unmet" | "unknown";
export const STATE_LABEL: Record<CondState, string> = { met: "達成済み", unmet: "未達成", unknown: "未確認" };
export const isCondState = (v: unknown): v is CondState => v === "met" || v === "unmet" || v === "unknown";

// ------------------------------------------------------------------ 日付（YYYY-MM-DD の暦日。JST基準の日付文字列をそのまま扱う）
const DAY_MS = 86_400_000;
const dayNum = (ymd: string) => {
  const [y, m, d] = ymd.split("-").map(Number);
  return Math.round(Date.UTC(y, m - 1, d) / DAY_MS);
};
const fromDayNum = (n: number) => new Date(n * DAY_MS).toISOString().slice(0, 10);
export const addDays = (ymd: string, n: number) => fromDayNum(dayNum(ymd) + n);
export const daysBetween = (from: string, to: string) => dayNum(to) - dayNum(from);

// ------------------------------------------------------------------ 購入履歴条件
export interface PurchaseParams {
  /** 抽選開始日の何日前を基準日とするか（0=開始日当日） */
  baseDaysBefore: number;
  /** 基準日から過去何日間を対象とするか */
  windowDays?: number;
  minAmountYen?: number;
  minCount?: number;
  /** 対象店舗（空=その系列のすべての店舗） */
  storeIds?: string[];
}

const int = (v: unknown, min: number, max: number): number | undefined => (typeof v === "number" && Number.isInteger(v) && v >= min && v <= max ? v : undefined);

/** 保存・表示の前に必ず通す。不正な値は捨てる（推測で埋めない） */
export function sanitizePurchaseParams(raw: unknown): PurchaseParams {
  const o = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const out: PurchaseParams = { baseDaysBefore: int(o.baseDaysBefore, 0, 365) ?? 0 };
  const w = int(o.windowDays, 1, 3650);
  if (w !== undefined) out.windowDays = w;
  const a = int(o.minAmountYen, 1, 10_000_000);
  if (a !== undefined) out.minAmountYen = a;
  const c = int(o.minCount, 1, 9999);
  if (c !== undefined) out.minCount = c;
  if (Array.isArray(o.storeIds)) {
    const ids = [...new Set(o.storeIds.filter((x): x is string => typeof x === "string" && /^[0-9a-f-]{36}$/i.test(x)))].slice(0, 100);
    if (ids.length > 0) out.storeIds = ids;
  }
  return out;
}

/**
 * 購入期間の日付境界（共通関数）。抽選開始日 start の baseDaysBefore 日前が基準日（to）、そこから過去 windowDays 日前が from。両端を含む。
 * 例: 開始 2026-11-10・3日前・365日 → 2025-11-07〜2026-11-07
 */
export function purchaseWindow(start: string, p: Pick<PurchaseParams, "baseDaysBefore" | "windowDays">): { from: string; to: string } | null {
  if (p.windowDays === undefined) return null;
  const to = addDays(start, -p.baseDaysBefore);
  return { from: addDays(to, -p.windowDays), to };
}

/** 既存の購入記録を、資格判定に使う事実へ正規化する（購入実績を別に複製せず、purchases を正とする） */
export interface PurchaseFact {
  id: string;
  /** 購入日（JST）。不明は null */
  date: string | null;
  /** 金額の合計（既知の分のみ）。amountKnown=false のときは一部または全部が不明 */
  amount: number;
  amountKnown: boolean;
  chainId: string | null;
  storeId: string | null;
  buyerProfileId: string | null;
}

const flexDate = (d: FlexibleDate): string | null => (d.precision === "date_only" ? d.date : d.precision === "date_time" ? jstDateString(new Date(d.at)) : null);

export function purchaseFacts(data: AppData): PurchaseFact[] {
  // 購入条件（過去の購入実績）の対象はポケモンカードの購入だけ。周辺グッズ・経費は含めない
  return data.purchases.filter(isCardPurchase).map((p) => {
    const app = p.applicationId ? data.applications.find((a) => a.id === p.applicationId) : undefined;
    const lottery = app ? data.lotteries.find((l) => l.id === app.lotteryId) : undefined;
    const store = p.storeId ? data.stores.find((s) => s.id === p.storeId) : undefined;
    const buyer = app ? (data.accounts.find((a) => a.id === app.accountId)?.profileId ?? null) : (p.buyerProfileId ?? null);
    const known = p.items.filter((i) => i.amountPaid !== null);
    return {
      id: p.id,
      date: flexDate(p.purchasedOn),
      amount: known.reduce((s, i) => s + (i.amountPaid ?? 0), 0),
      amountKnown: p.items.length > 0 && known.length === p.items.length,
      chainId: store?.chainId ?? lottery?.chainId ?? null,
      storeId: p.storeId,
      buyerProfileId: buyer,
    };
  });
}

export type Remaining = { kind: "months"; months: number } | { kind: "soon" } | { kind: "check" } | { kind: "none" };

/** 残り日数 → 月単位の簡潔な表現。約1ヶ月以内は「まもなく資格切れ」 */
export function remainingFromDays(days: number): Remaining {
  if (days <= 31) return { kind: "soon" };
  return { kind: "months", months: Math.floor(days / 30.44) };
}
export function remainingLabel(r: Remaining): string {
  switch (r.kind) {
    case "months":
      return `あと${r.months}ヶ月`;
    case "soon":
      return "まもなく資格切れ";
    case "check":
      return "資格要確認";
    case "none":
      return "";
  }
}

export interface PurchaseEval {
  state: CondState;
  count: number;
  amount: number;
  /** 日付・店舗・金額が不明で、判定に含められなかった（含まれる可能性のある）記録の数 */
  unknownRecords: number;
  window: { from: string; to: string } | null;
  remaining: Remaining;
  /** 判定できない・不確かな理由（表示用） */
  reason?: string;
}

export interface PurchaseOverride {
  /** 今回の抽選固有の最低金額（円） */
  minAmountYen?: number;
  /** 今回の抽選固有の対象期間（明示的な日付。あれば系列の相対期間より優先し、残り期間は算出しない） */
  from?: string;
  to?: string;
}

/**
 * プロフィール1人の購入履歴条件を判定する。
 *  - 当選しただけでは購入として扱わない（purchases に記録された購入だけを数える）。購入記録の訂正・取消・削除は、次の表示で自動的に反映される。
 *  - 金額・回数は、設定されているものすべてを評価する（どちらも未設定なら「1回以上」）。
 *  - 金額不明・日付不明の記録だけで達成と判断しない。それらがあり未達成なら「未確認」。
 *  - startDate: 抽選開始日（仮に今日開始なら today）。残り期間は「今日開始した場合」の目安（today を startDate にして呼ぶ）。
 */
export function evaluatePurchase(
  facts: readonly PurchaseFact[],
  params: PurchaseParams,
  ctx: { chainId: string; profileId: string; startDate: string; override?: PurchaseOverride },
): PurchaseEval {
  const explicit = ctx.override?.from && ctx.override?.to ? { from: ctx.override.from, to: ctx.override.to } : null;
  const win = explicit ?? purchaseWindow(ctx.startDate, params);
  if (!win) return { state: "unknown", count: 0, amount: 0, unknownRecords: 0, window: null, remaining: { kind: "check" }, reason: "対象期間が未設定です" };

  const minAmount = ctx.override?.minAmountYen ?? params.minAmountYen;
  const minCount = params.minCount ?? (minAmount === undefined ? 1 : undefined);
  const stores = params.storeIds && params.storeIds.length > 0 ? new Set(params.storeIds) : null;

  const mine = facts.filter((f) => f.buyerProfileId === ctx.profileId && f.chainId === ctx.chainId);
  const relevant = mine.filter((f) => !stores || (f.storeId !== null && stores.has(f.storeId)));
  let unknownRecords = mine.filter((f) => stores && f.storeId === null).length + relevant.filter((f) => f.date === null).length;
  const inWindow = relevant.filter((f) => f.date !== null && f.date >= win.from && f.date <= win.to);
  const amountUnknownInWindow = minAmount !== undefined ? inWindow.filter((f) => !f.amountKnown).length : 0;
  unknownRecords += amountUnknownInWindow;

  const ok = (set: readonly PurchaseFact[]) => (minCount === undefined || set.length >= minCount) && (minAmount === undefined || set.reduce((s, f) => s + f.amount, 0) >= minAmount);
  const count = inWindow.length;
  const amount = inWindow.reduce((s, f) => s + f.amount, 0);
  if (!ok(inWindow)) {
    return { state: unknownRecords > 0 ? "unknown" : "unmet", count, amount, unknownRecords, window: win, remaining: { kind: unknownRecords > 0 ? "check" : "none" }, reason: unknownRecords > 0 ? "日付・店舗・金額が不明な購入記録があります" : undefined };
  }

  // 達成中: 古い購入から順に対象期間を外れていくとして、条件を維持できなくなる時期を求める（古い1件が外れただけでは切れとしない）
  if (explicit) return { state: "met", count, amount, unknownRecords, window: win, remaining: { kind: "none" } };
  const dates = [...new Set(inWindow.map((f) => f.date as string))].sort();
  let rest = [...inWindow];
  for (const d of dates) {
    rest = rest.filter((f) => (f.date as string) > d);
    if (!ok(rest)) {
      // 購入日 d の記録は、基準日が（d − to + windowDays + 1）日先に進んだとき対象期間から外れる
      const daysLeft = daysBetween(win.to, d) + (params.windowDays as number) + 1;
      return { state: "met", count, amount, unknownRecords, window: win, remaining: remainingFromDays(Math.max(0, daysLeft)) };
    }
  }
  return { state: "met", count, amount, unknownRecords, window: win, remaining: { kind: "check" } };
}

// ------------------------------------------------------------------ 系列条件の評価（AND / OR）
export interface ChainCondition {
  id: string;
  chainId: string;
  kind: CondKind;
  label: string;
  params: PurchaseParams | Record<string, never>;
  note: string;
  joinPrev: "and" | "or";
  sortOrder: number;
}
export interface ConditionState {
  id: string;
  conditionId: string;
  profileId: string;
  state: CondState;
  confirmedOn: string | null;
  note: string;
}

export interface CondResult {
  cond: ChainCondition;
  state: CondState;
  /** true=手動の達成状況 / false=購入履歴から算出 */
  derived: boolean;
  confirmedOn: string | null;
  purchase?: PurchaseEval;
}
export interface ChainEval {
  results: CondResult[];
  /** 条件なしは none。グループ間は AND（すべて必要）、グループ内は OR（どれかで可） */
  overall: CondState | "none";
  /** 購入履歴条件が達成中のときの、資格の残り期間の目安（複数あれば最も短いもの） */
  remaining: Remaining | null;
}

export const conditionsOf = (data: AppData, chainId: string): ChainCondition[] =>
  (data.chainConditions ?? []).filter((c) => c.chainId === chainId).sort((a, b) => a.sortOrder - b.sortOrder);

export function evaluateChain(
  data: AppData,
  chainId: string,
  profileId: string,
  opts: { today: string; startDate?: string; override?: PurchaseOverride; facts?: readonly PurchaseFact[] },
): ChainEval {
  const conds = conditionsOf(data, chainId);
  if (conds.length === 0) return { results: [], overall: "none", remaining: null };
  const facts = opts.facts ?? purchaseFacts(data);
  const results: CondResult[] = conds.map((cond) => {
    if (cond.kind === "purchase") {
      const params = sanitizePurchaseParams(cond.params);
      const start = opts.startDate ?? opts.today;
      const purchase = evaluatePurchase(facts, params, { chainId, profileId, startDate: start, override: opts.override });
      return { cond, state: purchase.state, derived: true, confirmedOn: null, purchase };
    }
    const st = (data.chainConditionStates ?? []).find((s) => s.conditionId === cond.id && s.profileId === profileId);
    return { cond, state: st?.state ?? "unknown", derived: false, confirmedOn: st?.confirmedOn ?? null };
  });

  // グループ化: joinPrev が "or" なら前の条件と同じグループ
  const groups: CondResult[][] = [];
  results.forEach((r, i) => {
    if (i > 0 && r.cond.joinPrev === "or") groups[groups.length - 1].push(r);
    else groups.push([r]);
  });
  const groupState = (g: CondResult[]): CondState => (g.some((r) => r.state === "met") ? "met" : g.every((r) => r.state === "unmet") ? "unmet" : "unknown");
  const states = groups.map(groupState);
  const overall: CondState = states.includes("unmet") ? "unmet" : states.every((s) => s === "met") ? "met" : "unknown";

  // 残り期間（目安）: グループごとに「そのグループが達成でなくなる時期」を求め、全グループのうち最も早いものを返す。
  //  - グループ内に、期限の無い達成済みの条件（手動の会員など）が1つでもあれば、そのグループは購入履歴が切れても維持されるので対象外
  //  - それ以外は、達成中の購入条件のうち最も遅く切れるもの（OR: 最後の1つが切れたとき）
  let remaining: Remaining | null = null;
  const rank = (r: Remaining) => (r.kind === "soon" ? 0 : r.kind === "months" ? r.months : r.kind === "check" ? 1e6 : 1e7);
  groups.forEach((g, gi) => {
    if (states[gi] !== "met") return;
    const metMembers = g.filter((r) => r.state === "met");
    if (metMembers.some((r) => !r.purchase || r.purchase.remaining.kind === "none")) return;
    const longest = metMembers.map((r) => (r.purchase as PurchaseEval).remaining).reduce((a, b) => (rank(b) > rank(a) ? b : a));
    if (remaining === null || rank(longest) < rank(remaining)) remaining = longest;
  });
  return { results, overall, remaining };
}

/** 手動で確認した日から日数が経っているか（再確認の目安。自動では無効にしない） */
export const needsReconfirm = (confirmedOn: string | null, today: string, days = 180): boolean => confirmedOn !== null && daysBetween(confirmedOn, today) > days;

// ------------------------------------------------------------------ 抽選カード・AI解析との比較
export interface LotteryEligibility {
  overall: CondState;
  /** 登録条件と今回の応募条件が異なる点（表示は相違マークと展開のみ。登録条件は変更しない） */
  mismatches: string[];
  remaining: Remaining | null;
}

const ymdOf = (d: FlexibleDate | undefined): string | null => (d ? flexDate(d) : null);

/**
 * 抽選1件の資格の参考判定。系列に条件が登録されていなければ null。
 * 今回の抽選固有の条件（AIまたは手動で登録された最低金額・購入期間）を優先して判定し、系列登録との差を mismatches に返す。
 * AIが読み取れなかった項目は「条件なし」と扱わない（比較せず、系列登録のまま判定する）。
 */
export function evaluateLottery(data: AppData, lottery: Lottery, profileId: string, today: string): LotteryEligibility | null {
  const conds = conditionsOf(data, lottery.chainId);
  if (conds.length === 0) return null;
  const details = lottery.requirementDetails ?? {};
  const purchaseConds = conds.filter((c) => c.kind === "purchase");
  const override: PurchaseOverride = {};
  const mismatches: string[] = [];

  if (details.minAmountYen !== undefined) override.minAmountYen = details.minAmountYen;
  if (details.purchasePeriodFrom && details.purchasePeriodTo) {
    override.from = details.purchasePeriodFrom;
    override.to = details.purchasePeriodTo;
  }
  const first = purchaseConds[0] ? sanitizePurchaseParams(purchaseConds[0].params) : null;
  if (first) {
    if (details.minAmountYen !== undefined && first.minAmountYen !== undefined && details.minAmountYen !== first.minAmountYen) {
      mismatches.push(`購入金額: 系列登録 ${first.minAmountYen.toLocaleString("ja-JP")}円以上／今回 ${details.minAmountYen.toLocaleString("ja-JP")}円以上`);
    }
    if (details.minAmountYen !== undefined && first.minAmountYen === undefined) mismatches.push(`購入金額: 系列登録なし／今回 ${details.minAmountYen.toLocaleString("ja-JP")}円以上`);
    if (details.purchasePeriodFrom && details.purchasePeriodTo && first.windowDays !== undefined) {
      const len = daysBetween(details.purchasePeriodFrom, details.purchasePeriodTo);
      if (Math.abs(len - first.windowDays) > 1) mismatches.push(`購入期間: 系列登録 過去${first.windowDays}日／今回 ${details.purchasePeriodFrom}〜${details.purchasePeriodTo}（${len}日間）`);
    }
  }
  // 今回の告知にあって、系列に登録されていない種類の条件（告知で読み取れなかった条件は「なし」と見なさず比較しない）
  const registered = new Set(conds.map((c) => c.kind));
  const seen = new Set<CondKind>();
  for (const t of lottery.requirementTags ?? []) {
    const k = kindOfRequirementTag(t);
    if (!k || seen.has(k) || registered.has(k)) continue;
    seen.add(k);
    mismatches.push(`今回の応募条件に「${kindLabel(k)}」があります（系列には未登録）`);
  }

  const startRaw = ymdOf(lottery.applyStart);
  const startDate = startRaw && startRaw > today ? startRaw : today;
  const ev = evaluateChain(data, lottery.chainId, profileId, { today, startDate, override });
  return { overall: ev.overall === "none" ? "unknown" : ev.overall, mismatches, remaining: ev.remaining };
}
