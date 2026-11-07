/**
 * 定期収集の実行判定（Stage 6A・純関数）。
 * 手動収集の履歴とは独立に、「今日の定期収集の枠（スロット）で、各収集元を取得できたか」だけで判断する。
 *  - 実行時刻は1日に1〜2回（例: 6時と18時）。スロットは「直近の実行時刻（日本時間）から次の実行時刻まで」。実行時刻より前は直前のスロットのまま（失敗した収集元の再試行を続けられる）
 *  - スロット日付はそのスロットの開始時刻の日本時間の日付。同じ日の2つのスロットは、開始時刻（slotStart）以降の記録かどうかで区別する
 *  - 収集元ごとに「定期収集として成功した記録」があれば実行済み。手動収集の記録（slot_date なし）は数えない
 *  - 失敗した収集元は、一定時間おいて再試行する（1日の上限あり）。成功した収集元は再取得しない
 *  - Cron が起動しただけでは実行済みにならない。取得に成功した収集元の記録が必要
 */
export type AttemptStatus = "ok" | "error" | "blocked" | "needs_setup" | "disabled" | "not_configured" | "budget";

/** 再試行しない（そのスロットでは完了とみなす）状態。設定で停止している・予算上限など、待っても変わらないもの */
export const TERMINAL_STATUSES: readonly AttemptStatus[] = ["ok", "disabled", "not_configured", "budget"];

export const RETRY_AFTER_MS = 30 * 60_000;
export const MAX_TRIES_PER_SLOT = 6;

export interface AttemptLite {
  sourceId: string;
  trigger: "manual" | "cron";
  slotDate: string | null;
  status: AttemptStatus;
  at: Date;
}

const jstYmd = (d: Date) => new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Tokyo", year: "numeric", month: "2-digit", day: "2-digit" }).format(d);

/** 実行時刻（日本時間の時）を、重複を除いて昇順にそろえる。0〜23 の整数以外・未設定は無視する */
export function normalizeHours(hours: ReadonlyArray<number | null | undefined>): number[] {
  return [...new Set(hours.filter((h): h is number => typeof h === "number" && Number.isInteger(h) && h >= 0 && h <= 23))].sort((a, b) => a - b);
}

const hoursOf = (h: number | ReadonlyArray<number | null | undefined>): number[] => {
  const n = normalizeHours(typeof h === "number" ? [h] : h);
  return n.length > 0 ? n : [6];
};
const instantAt = (ymd: string, hour: number) => new Date(`${ymd}T${String(hour).padStart(2, "0")}:00:00+09:00`);

/** いまの定期収集のスロット（直近の実行時刻）。date は開始時刻の日本時間の日付 */
export function currentSlot(now: Date, hours: number | ReadonlyArray<number | null | undefined>): { date: string; hour: number; start: Date } {
  const hs = hoursOf(hours);
  const days = [jstYmd(now), jstYmd(new Date(now.getTime() - 24 * 3600_000))];
  let best: { date: string; hour: number; start: Date } | null = null;
  for (const d of days) {
    for (const h of hs) {
      const start = instantAt(d, h);
      if (start.getTime() <= now.getTime() && (!best || start > best.start)) best = { date: d, hour: h, start };
    }
  }
  // 日本時間の日付をまたぐ直前の時刻（前日の最後の実行時刻）は必ず見つかる
  return best ?? { date: days[1], hour: hs[hs.length - 1], start: instantAt(days[1], hs[hs.length - 1]) };
}

/** いまの定期収集のスロット日付（日本時間） */
export function slotDateOf(now: Date, hours: number | ReadonlyArray<number | null | undefined>): string {
  return currentSlot(now, hours).date;
}

/** 次の定期収集の予定時刻 */
export function nextSlotAt(now: Date, hours: number | ReadonlyArray<number | null | undefined>): Date {
  const hs = hoursOf(hours);
  const cands: Date[] = [];
  for (let i = 0; i <= 1; i++) {
    const d = jstYmd(new Date(now.getTime() + i * 24 * 3600_000));
    for (const h of hs) cands.push(instantAt(d, h));
  }
  return cands.filter((c) => c.getTime() > now.getTime()).sort((a, b) => a.getTime() - b.getTime())[0];
}

export interface DueResult {
  slotDate: string;
  /** スロットの開始時刻。これ以降の記録だけをそのスロットの実績として数える */
  slotStart: Date;
  /** 今回取得する収集元 */
  due: string[];
  /** そのスロットで完了している収集元 */
  done: string[];
  /** 失敗して再試行を待っている収集元 */
  waiting: string[];
  /** 再試行の上限に達した収集元 */
  exhausted: string[];
}

export function dueSources(now: Date, hours: number | ReadonlyArray<number | null | undefined>, sourceIds: string[], attempts: AttemptLite[], opts: { retryAfterMs?: number; maxTries?: number } = {}): DueResult {
  const { date: slotDate, start: slotStart } = currentSlot(now, hours);
  const retryAfter = opts.retryAfterMs ?? RETRY_AFTER_MS;
  const maxTries = opts.maxTries ?? MAX_TRIES_PER_SLOT;
  const out: DueResult = { slotDate, slotStart, due: [], done: [], waiting: [], exhausted: [] };
  for (const id of sourceIds) {
    const mine = attempts.filter((a) => a.sourceId === id && a.trigger === "cron" && a.slotDate === slotDate && a.at.getTime() >= slotStart.getTime());
    if (mine.some((a) => TERMINAL_STATUSES.includes(a.status))) {
      out.done.push(id);
      continue;
    }
    if (mine.length >= maxTries) {
      out.exhausted.push(id);
      continue;
    }
    const last = mine.reduce<Date | null>((m, a) => (!m || a.at > m ? a.at : m), null);
    if (last && now.getTime() - last.getTime() < retryAfter) out.waiting.push(id);
    else out.due.push(id);
  }
  return out;
}

export type RunResult = "complete" | "partial" | "failed" | "empty";
/** 1回の収集の結果。取得対象が無いときは empty、すべて成功なら complete、一部失敗なら partial、すべて失敗なら failed */
export function runResultOf(statuses: AttemptStatus[]): RunResult {
  if (statuses.length === 0) return "empty";
  const bad = statuses.filter((s) => !TERMINAL_STATUSES.includes(s)).length;
  // 停止中・予算上限などで取得した収集元が1つも無いときは、正常完了とは扱わない
  if (bad === 0) return statuses.includes("ok") ? "complete" : "empty";
  return bad === statuses.length ? "failed" : "partial";
}
