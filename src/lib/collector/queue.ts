/**
 * 自動収集のキュー制御の純粋関数: 優先順位、再試行の待ち時間、収集の実行時刻、変更検出用の正規化、既存抽選との差分、異常の警告。
 * 優先順位は DB 関数 claim_collection_jobs と同じ計算（テストで一致を確認する）。
 */
import { createHash } from "node:crypto";
import type { LotteryInput } from "@/lib/lottery-input";
import type { Lottery } from "@/types/domain";

// ---------------------------------------------------------------- 優先順位
export interface PriorityInput {
  now: Date;
  /** 一覧に表示された応募締切。不明は null（後回しにしない） */
  dueAt: Date | null;
  createdAt: Date;
  /** 再試行の待ち時間を過ぎた時刻（あれば、待ち時間の起点にする） */
  nextRunAt: Date | null;
  /** 既存抽選の更新・直近2日以内に内容の変更を検出 */
  changed: boolean;
}

const H = 3600_000;
export function priorityScore(p: PriorityInput): number {
  const t = p.now.getTime();
  let base = 40; // 締切不明
  if (p.dueAt) {
    const left = p.dueAt.getTime() - t;
    base = left <= 6 * H ? 100 : left <= 24 * H ? 90 : left <= 72 * H ? 70 : 30;
  }
  const fresh = t - p.createdAt.getTime() < 24 * H ? 15 : 0;
  const aging = Math.min(60, Math.floor((t - (p.nextRunAt ?? p.createdAt).getTime()) / (6 * H)));
  return base + (p.changed ? 25 : 0) + fresh + aging;
}

// ---------------------------------------------------------------- 再試行（指数バックオフ）
export const MAX_ATTEMPTS = 3;
/** 失敗した回数(1から)に応じた待ち時間: 15分 → 1時間 → 4時間。上限を超えたら再試行しない */
export function backoffMs(attempts: number): number | null {
  if (attempts >= MAX_ATTEMPTS) return null;
  return [15 * 60_000, 60 * 60_000, 4 * H][Math.max(0, attempts - 1)] ?? 4 * H;
}
/** 再試行しても結果が変わらない失敗（ロボット取得の拒否など） */
export const isPermanentError = (message: string) => classifyFailure(message).permanent;

// ---------------------------------------------------------------- 取得失敗の原因分類（Stage 5S）
export type FailKind = "http" | "timeout" | "js_render" | "robots" | "not_found" | "x_api" | "image" | "external_link" | "network" | "expired" | "other";
export const FAIL_KIND_LABEL: Record<FailKind, string> = {
  http: "HTTPエラー", timeout: "タイムアウト", js_render: "JavaScript描画", robots: "取得制限（ロボット・アクセス制限）", not_found: "ページ削除・URL変更",
  x_api: "X API取得失敗", image: "画像取得失敗", external_link: "外部リンク先の取得失敗", network: "一時的な通信障害", expired: "受付終了", other: "その他",
};
/**
 * 失敗メッセージを原因別に分類する。恒常的（再試行しても変わらない）か、一時的（間隔と回数を制限して再試行）かを区別する。
 * 取得制限（robots・ログイン要・403）は回避しない。
 */
export function classifyFailure(message: string, ctx: { external?: boolean } = {}): { kind: FailKind; permanent: boolean } {
  const m = message;
  let kind: FailKind = "other";
  if (/ロボット|許可していません|robots|アクセスが制限/i.test(m)) kind = "robots";
  else if (/見つかりません|404|410|削除/.test(m)) kind = "not_found";
  else if (/JavaScript/i.test(m)) kind = "js_render";
  else if (/タイムアウト|時間切れ|timeout/i.test(m)) kind = "timeout";
  else if (/X API|Xの投稿|投稿を取得/.test(m)) kind = "x_api";
  else if (/画像/.test(m)) kind = "image";
  else if (/接続できません|通信|ネットワーク/.test(m)) kind = "network";
  else if (/HTTP|ステータス|サーバー|5dd|429/.test(m)) kind = "http";
  if (ctx.external && (kind === "other" || kind === "http")) kind = "external_link";
  return { kind, permanent: kind === "robots" || kind === "not_found" || kind === "js_render" };
}

/**
 * まとめサイトの一覧の表示が変わったとき、再解析（AI）が必要か。
 * 一覧の文言は「お気に入り」「応募する」などの表記ゆれで頻繁に変わるため、応募締切が変わった場合だけ再解析する。
 * 締切が同じなら、本文の変化は無料の本文確認（recheckPages）に任せる。
 */
export function shouldReanalyzeOnListChange(oldDueAt: string | null, newDueAt: string | null): boolean {
  if (!newDueAt) return false;
  if (!oldDueAt) return true;
  return new Date(oldDueAt).getTime() !== new Date(newDueAt).getTime();
}

// ---------------------------------------------------------------- 定期収集の実行時刻（日本時間の指定時刻を過ぎていて、今日はまだ収集していなければ実行）
export function scheduledInstant(now: Date, hourJst: number): Date {
  const ymd = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Tokyo", year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
  return new Date(`${ymd}T${String(hourJst).padStart(2, "0")}:00:00+09:00`);
}
export function collectDue(now: Date, hourJst: number, lastCollectAt: Date | null): boolean {
  const at = scheduledInstant(now, hourJst);
  return now.getTime() >= at.getTime() && (!lastCollectAt || lastCollectAt.getTime() < at.getTime());
}
export function nextCollectAt(now: Date, hourJst: number): Date {
  const at = scheduledInstant(now, hourJst);
  return at.getTime() > now.getTime() ? at : new Date(at.getTime() + 24 * H);
}

// ---------------------------------------------------------------- 変更検出
/** 広告・カウントダウン・「新しいタブで開きます」など、意味のない変化を除いて正規化する。日付・時刻・金額・店舗名・商品名は残す */
export function normalizeForHash(text: string): string {
  return text
    .normalize("NFKC")
    .replace(/\d+\s*(時間|分|日)\s*以内に?締切/g, " ")
    .replace(/あと\s*\d+\s*(日|時間|分)(\s*\d+\s*(時間|分))?/g, " ")
    .replace(/残り\s*\d+\s*(日|時間|分)/g, " ")
    .replace(/いま受付中[^\s]*/g, " ")
    .replace(/[・･]?s*新しいタブで開きます/g, " ")
    .replace(/\s*(PV|閲覧|アクセス|views?)\s*[:：]?\s*[\d,]+/gi, " ")
    .replace(/\s+/g, " ")
    .replace(/\s+([)\]」』】])/g, "$1")
    .replace(/([(\[「『【])\s+/g, "$1")
    .trim()
    .toLowerCase();
}
export const hashNormalized = (text: string) => createHash("sha256").update(normalizeForHash(text)).digest("hex");

/** 告知ページの本文から、抽選の中止を示す表現を探す（ルールベース。見つからなければ null） */
export function detectCancel(text: string): string | null {
  const t = text.normalize("NFKC");
  const m = /(抽選(販売)?|応募|受付|販売)[^。\n]{0,12}(中止(と)?(いたし|いた)?(ます|ました|となり|とさせ)|中止のお知らせ)|中止のお知らせ|抽選販売は中止/.exec(t);
  return m ? m[0].slice(0, 40) : null;
}

// ---------------------------------------------------------------- 既存抽選との差分（日時・受取方法）
export interface FieldChange {
  key: "applyStart" | "applyDeadline" | "resultDate" | "procedureStart" | "procedureDeadline" | "receiveMethod";
  label: string;
  before: string;
  after: string;
}

type Flex = LotteryInput["applyStart"];
const flexLabel = (f: { precision: string; date?: string | null; time?: string | null }) => (f.precision === "unknown" || !f.date ? "不明" : f.precision === "date_only" ? f.date : `${f.date} ${f.time ?? ""}`.trim());
const jstParts = (iso: string) => {
  const d = new Date(iso);
  const date = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Tokyo", year: "numeric", month: "2-digit", day: "2-digit" }).format(d);
  const time = new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Tokyo", hour: "2-digit", minute: "2-digit", hour12: false }).format(d);
  return { date, time };
};
/** 既存の抽選の日時を、入力と同じ形（precision/date/time）にそろえる */
export function lotteryFlex(f: Lottery["applyStart"]): { precision: string; date: string | null; time: string | null } {
  if (f.precision === "unknown") return { precision: "unknown", date: null, time: null };
  if (f.precision === "date_only") return { precision: "date_only", date: (f as { date?: string }).date ?? null, time: null };
  const at = (f as { at?: string }).at;
  if (!at) return { precision: "unknown", date: null, time: null };
  const p = jstParts(at);
  return { precision: "date_time", date: p.date, time: p.time };
}
const same = (a: { precision: string; date?: string | null; time?: string | null }, b: { precision: string; date?: string | null; time?: string | null }) =>
  a.precision === b.precision && (a.date ?? null) === (b.date ?? null) && (a.precision !== "date_time" || (a.time ?? null) === (b.time ?? null));

/**
 * 新しく読み取った内容と既存の抽選を比べる。新しい値が「不明」のときは変更とみなさない（読み取れなかっただけかもしれないため）。
 * 変更は提案として確認画面に出し、利用者が反映する（応募・当落・スルー・購入には触れない）。
 */
export function diffAgainstLottery(next: LotteryInput, cur: Lottery): FieldChange[] {
  const out: FieldChange[] = [];
  const fields: [FieldChange["key"], string, Flex | undefined, Lottery["applyStart"]][] = [
    ["applyStart", "応募開始", next.applyStart, cur.applyStart],
    ["applyDeadline", "応募締切", next.applyDeadline, cur.applyDeadline],
    ["resultDate", "当選発表", next.resultDate, cur.resultDate],
    ["procedureStart", "購入・受取開始", next.procedureStart, cur.procedureStart],
    ["procedureDeadline", "購入・受取終了", next.procedureDeadline, cur.procedureDeadline],
  ];
  for (const [key, label, n, c] of fields) {
    if (!n || n.precision === "unknown") continue;
    const cf = lotteryFlex(c);
    if (!same(n, cf)) out.push({ key, label, before: flexLabel(cf), after: flexLabel(n) });
  }
  if (next.receiveMethod !== "unknown" && next.receiveMethod !== cur.receiveMethod) {
    const L: Record<string, string> = { store: "店頭", shipping: "発送", either: "店頭・発送", unknown: "不明" };
    out.push({ key: "receiveMethod", label: "受取方法", before: L[cur.receiveMethod] ?? cur.receiveMethod, after: L[next.receiveMethod] ?? next.receiveMethod });
  }
  return out;
}

/** 同じURLでも、前回の締切の後に新しい応募期間が始まるなら、別の抽選回（新しい抽選）として扱う */
export function isNewRound(next: LotteryInput, cur: Lottery): boolean {
  const nd = next.applyDeadline;
  const od = lotteryFlex(cur.applyDeadline);
  const ns = next.applyStart;
  if (nd.precision === "unknown" || !nd.date || !od.date) return false;
  if (nd.date === od.date) return false;
  return ns.precision !== "unknown" && !!ns.date && ns.date > od.date;
}

// ---------------------------------------------------------------- 月額予算（Stage 5T: 日次の件数上限は廃止。費用は月額予算で制御する）
const jstDay = (d: Date) => new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Tokyo", year: "numeric", month: "2-digit", day: "2-digit" }).format(d);
export const jstDayString = jstDay;

/** 1回のAI読み取りの費用の見込みの上限（安全側。実測の平均は1円未満）。残額がこの金額に満たない分は始めない */
export const CALL_RESERVE_JPY = 8;
export function budgetCallsLeft(budgetJpy: number, costJpy: number, reserveJpy = CALL_RESERVE_JPY): number {
  return Math.max(0, Math.floor((budgetJpy - costJpy) / reserveJpy));
}
/** 予約する見込み額: 今月の実測の平均×3（誤差の余裕）。実測が無い間、または極端な値のときは 2〜CALL_RESERVE_JPY の範囲に収める */
export function reserveEstimateJpy(avgPerCallJpy: number | null): number {
  if (avgPerCallJpy === null || !Number.isFinite(avgPerCallJpy)) return CALL_RESERVE_JPY;
  return Math.min(CALL_RESERVE_JPY, Math.max(2, Math.round(avgPerCallJpy * 3 * 100) / 100));
}

// ---------------------------------------------------------------- 異常の警告（画面に表示）
export interface HealthInput {
  now: Date;
  workerEnabled: boolean;
  queued: number;
  oldestQueuedAt: Date | null;
  lastWorkerAt: Date | null;
  failedLast24h: number;
  pausedReason: string | null;
  sources: { name: string; enabled: boolean; lastSuccessAt: Date | null; consecutiveFailures: number }[];
  scheduleEnabled: boolean;
  lastCollectAt: Date | null;
  /** 最後に解析待ちが実際に処理された時刻（Cronの実行ではなく、キューが進んだ時刻） */
  lastProgressAt?: Date | null;
  budgetBlocked?: boolean;
  /** 本日締切で未処理の候補 */
  dueTodayQueued?: number;
}
export interface HealthWarning {
  code: "due_today" | "budget" | "paused" | "worker_stalled" | "queue_stuck" | "failures_surge" | "source_stale" | "collect_stale";
  message: string;
}
export function healthWarnings(h: HealthInput): HealthWarning[] {
  const out: HealthWarning[] = [];
  const mins = (d: Date | null) => (d ? (h.now.getTime() - d.getTime()) / 60_000 : Infinity);
  if (h.dueTodayQueued && h.dueTodayQueued > 0 && (h.budgetBlocked || h.pausedReason)) out.push({ code: "due_today", message: `本日締切の候補が${h.dueTodayQueued}件、未処理のままです。優先して確認してください` });
  if (h.budgetBlocked && h.queued > 0) out.push({ code: "budget", message: `今月のAI予算に達したため、新しい解析を停止しています。解析待ち${h.queued}件（翌月（日本時間）に自動で再開します）` });
  if (h.pausedReason) out.push({ code: "paused", message: `自動処理を停止しています: ${h.pausedReason}` });
  // Cronが動いているだけでは正常とみなさない: 解析待ちがあり、停止・上限でもないのに、実際に処理が進んでいない
  if (h.workerEnabled && h.queued > 0 && !h.pausedReason && !h.budgetBlocked && mins(h.lastProgressAt !== undefined ? h.lastProgressAt : h.lastWorkerAt) > 30) out.push({ code: "worker_stalled", message: "解析待ちがありますが、30分以上処理が進んでいません（定期実行の設定を確認してください）" });
  if (h.queued > 0 && h.oldestQueuedAt && mins(h.oldestQueuedAt) > 48 * 60) out.push({ code: "queue_stuck", message: "2日以上前から解析待ちが残っています" });
  if (h.failedLast24h >= 10) out.push({ code: "failures_surge", message: `直近24時間の失敗が${h.failedLast24h}件に増えています` });
  for (const s of h.sources) {
    if (!s.enabled) continue;
    if (s.consecutiveFailures >= 3 || (s.lastSuccessAt && mins(s.lastSuccessAt) > 3 * 24 * 60)) out.push({ code: "source_stale", message: `「${s.name}」の取得が成功していません（最新の情報ではない可能性があります）` });
  }
  if (h.scheduleEnabled && mins(h.lastCollectAt) > 36 * 60) out.push({ code: "collect_stale", message: "定期収集が36時間以上実行されていません" });
  return out;
}

/** ISO時刻 → 入力と同じ形（日本時間の日付・時刻）。日時を補完で作らない用途（一覧に表示された日時の取り込み）で使う */
export function isoToFlex(iso: string): { precision: "date_time"; date: string; time: string } {
  const p = jstParts(iso);
  return { precision: "date_time", date: p.date, time: p.time };
}
