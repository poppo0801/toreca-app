/**
 * 定期収集の実行判定（Stage 6A・純関数）。
 * 手動収集の履歴とは独立に、「今日の定期収集の枠（スロット）で、各収集元を取得できたか」だけで判断する。
 *  - スロット日付は日本時間で、指定時刻（既定6:00）に切り替わる。指定時刻より前は前日のスロットのまま（失敗した収集元の再試行を続けられる）
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

/** いまの定期収集のスロット日付（日本時間。hourJst 時に切り替わる） */
export function slotDateOf(now: Date, hourJst: number): string {
  return jstYmd(new Date(now.getTime() - hourJst * 3600_000));
}

export interface DueResult {
  slotDate: string;
  /** 今回取得する収集元 */
  due: string[];
  /** そのスロットで完了している収集元 */
  done: string[];
  /** 失敗して再試行を待っている収集元 */
  waiting: string[];
  /** 再試行の上限に達した収集元 */
  exhausted: string[];
}

export function dueSources(now: Date, hourJst: number, sourceIds: string[], attempts: AttemptLite[], opts: { retryAfterMs?: number; maxTries?: number } = {}): DueResult {
  const slotDate = slotDateOf(now, hourJst);
  const retryAfter = opts.retryAfterMs ?? RETRY_AFTER_MS;
  const maxTries = opts.maxTries ?? MAX_TRIES_PER_SLOT;
  const out: DueResult = { slotDate, due: [], done: [], waiting: [], exhausted: [] };
  for (const id of sourceIds) {
    const mine = attempts.filter((a) => a.sourceId === id && a.trigger === "cron" && a.slotDate === slotDate);
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
