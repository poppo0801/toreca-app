/**
 * 収集実行単位の集計（Stage 5S-B）。
 * 1回の収集（定期・手動）= collection_runs の phase='collect' の1行。その実行で「初めて発見した候補」（discovered_run_id）だけを数える。
 * 解析が複数のワーカー実行にまたがっても同じ実行に紐づく。過去の候補の再評価・再解析の結果は、今回の成果に含めない。
 */
export interface RunLite {
  id: string;
  trigger: "manual" | "cron";
  status: "running" | "done" | "failed";
  started_at: string;
  finished_at: string | null;
  new_count?: number;
  registered_count?: number;
  ai_calls?: number;
}
export interface RunCandidateLite {
  status: string;
  job_state: string;
  fail_kind: string | null;
  ai_calls?: number | null;
  cost_jpy?: number | string | null;
}

export interface RunSummary {
  runId: string;
  trigger: "manual" | "cron";
  startedAt: string;
  /** 収集（発見）が終わり、発見した候補の解析もすべて終わった */
  state: "processing" | "complete" | "failed";
  /** 旧形式の実行（候補との紐づけが無い）。件数は実行の記録から出し、内訳は不明 */
  legacy: boolean;
  discovered: number;
  /** 解析が完了した件数（登録・確認待ち・対象外・重複・失敗のいずれかに確定したもの。解析待ちは含めない） */
  analyzed: number;
  autoRegistered: number;
  review: number;
  failed: number;
  excluded: number;
  duplicates: number;
  waiting: number;
  costJpy: number;
}

const WAITING = ["pending", "retry", "processing"];

export function summarizeRun(run: RunLite, cands: RunCandidateLite[]): RunSummary {
  const legacy = cands.length === 0 && ((run.new_count ?? 0) > 0 || (run.registered_count ?? 0) > 0);
  const waiting = cands.filter((c) => WAITING.includes(c.job_state)).length;
  const count = (f: (c: RunCandidateLite) => boolean) => cands.filter(f).length;
  const discovered = legacy ? (run.new_count ?? 0) : cands.length;
  const state: RunSummary["state"] = run.status === "failed" ? "failed" : run.status === "running" || waiting > 0 ? "processing" : "complete";
  return {
    runId: run.id,
    trigger: run.trigger,
    startedAt: run.started_at,
    state,
    legacy,
    discovered,
    analyzed: legacy ? 0 : cands.length - waiting,
    autoRegistered: legacy ? (run.registered_count ?? 0) : count((c) => c.status === "auto_registered"),
    review: count((c) => c.job_state === "review"),
    // 受付終了による取得失敗（fail_kind=expired）は失敗に数えない（対象外として除外される）
    failed: count((c) => c.job_state === "failed"),
    excluded: count((c) => c.job_state === "skipped"),
    duplicates: count((c) => c.status === "duplicate"),
    waiting,
    costJpy: Math.round(cands.reduce((a, c) => a + (Number(c.cost_jpy) || 0), 0) * 100) / 100,
  };
}

/** 起動時に表示する価値のある結果か（新規登録・確認が必要な候補・取得エラーのいずれか）。何も無い実行は表示しない */
export function isNoteworthy(s: RunSummary): boolean {
  return s.autoRegistered > 0 || s.review > 0 || s.failed > 0;
}

/** 処理中のまま、この時間を過ぎた実行は最終結果として扱う（解析が止まっていても通知が永久に出ないことを防ぐ） */
const PROCESSING_GIVE_UP_MS = 3 * 3600_000;

/**
 * 起動時のポップアップの対象を選ぶ。定期収集（6時・18時など）の「最新の1回」だけを対象にし、以前の結果は出さない。
 *  - 最新の定期収集が確認済みなら何も出さない（アプリを開くたびには出ない。各回の収集後、最初に開いたときの1回だけ）
 *  - 解析の途中（処理中）は途中経過を最終結果として出さず、完了を待つ（確認済みにもしない）
 *  - 表示した・または表示する価値が無いと判断した実行と、それ以前の未確認の実行はまとめて確認済みにする
 */
export function pickNotice(summaries: RunSummary[], acked: ReadonlySet<string>, nowMs: number = Date.now()): { show: RunSummary | null; ackIds: string[] } {
  const cron = summaries.filter((s) => s.trigger === "cron" && !s.legacy).sort((a, b) => b.startedAt.localeCompare(a.startedAt));
  const latest = cron[0];
  if (!latest || acked.has(latest.runId)) return { show: null, ackIds: [] };
  if (latest.state === "processing" && nowMs - new Date(latest.startedAt).getTime() < PROCESSING_GIVE_UP_MS) return { show: null, ackIds: [] };
  const ackIds = cron.filter((s) => !acked.has(s.runId) && s.startedAt <= latest.startedAt).map((s) => s.runId);
  return { show: isNoteworthy(latest) ? latest : null, ackIds };
}

export const triggerLabel = (t: "manual" | "cron") => (t === "cron" ? "定期" : "手動");
export function runTitle(s: Pick<RunSummary, "trigger" | "startedAt">): string {
  const d = new Date(s.startedAt);
  const f = new Intl.DateTimeFormat("ja-JP", { timeZone: "Asia/Tokyo", month: "numeric", day: "numeric", hour: "numeric", minute: "2-digit", hour12: false }).format(d);
  return `${f}の${triggerLabel(s.trigger)}収集`;
}
