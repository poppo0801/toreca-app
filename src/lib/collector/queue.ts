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
export const isPermanentError = (message: string) => /ロボット|許可していません|robots/i.test(message);

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
}
export interface HealthWarning {
  code: "paused" | "worker_stalled" | "queue_stuck" | "failures_surge" | "source_stale" | "collect_stale";
  message: string;
}
export function healthWarnings(h: HealthInput): HealthWarning[] {
  const out: HealthWarning[] = [];
  const mins = (d: Date | null) => (d ? (h.now.getTime() - d.getTime()) / 60_000 : Infinity);
  if (h.pausedReason) out.push({ code: "paused", message: `自動処理を停止しています: ${h.pausedReason}` });
  if (h.workerEnabled && h.queued > 0 && !h.pausedReason && mins(h.lastWorkerAt) > 30) out.push({ code: "worker_stalled", message: "解析待ちがありますが、ワーカーが30分以上動いていません（定期実行の設定を確認してください）" });
  if (h.queued > 0 && h.oldestQueuedAt && mins(h.oldestQueuedAt) > 48 * 60) out.push({ code: "queue_stuck", message: "2日以上前から解析待ちが残っています" });
  if (h.failedLast24h >= 10) out.push({ code: "failures_surge", message: `直近24時間の失敗が${h.failedLast24h}件に増えています` });
  for (const s of h.sources) {
    if (!s.enabled) continue;
    if (s.consecutiveFailures >= 3 || (s.lastSuccessAt && mins(s.lastSuccessAt) > 3 * 24 * 60)) out.push({ code: "source_stale", message: `「${s.name}」の取得が成功していません（最新の情報ではない可能性があります）` });
  }
  if (h.scheduleEnabled && mins(h.lastCollectAt) > 36 * 60) out.push({ code: "collect_stale", message: "定期収集が36時間以上実行されていません" });
  return out;
}
