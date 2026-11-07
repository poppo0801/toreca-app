/**
 * Xブックマークの投稿ごとの処理状況（Stage 6N・純関数）。
 * 「投稿を取得できたこと」と「抽選として登録できたこと」を別の状態として持つ。
 *   未取得 → 取得済み・解析待ち → 解析中 → 抽選登録完了／既存抽選と統合済み
 *                                    └→ 情報不足・追加調査中 / 要手動確認 / 対象外 / 取得失敗 / 受付終了・未解決
 */
import { isApplicationClosed } from "@/lib/collector/closed";

export const BOOKMARK_STATES = ["unfetched", "fetched_pending", "analyzing", "insufficient", "manual_review", "registered", "merged", "excluded", "fetch_failed", "closed_unresolved"] as const;
export type BookmarkState = (typeof BOOKMARK_STATES)[number];

export const BOOKMARK_STATE_LABEL: Record<BookmarkState, string> = {
  unfetched: "未取得",
  fetched_pending: "取得済み・解析待ち",
  analyzing: "解析中",
  insufficient: "情報不足・追加調査中",
  manual_review: "要手動確認",
  registered: "抽選登録完了",
  merged: "既存抽選と統合済み",
  excluded: "対象外",
  fetch_failed: "取得失敗",
  closed_unresolved: "受付終了・未解決",
};

/** 表示の記号: ok=✓ / wait=◷ / warn=⚠ / none=－ */
export type BookmarkTone = "ok" | "wait" | "warn" | "none";
export const BOOKMARK_TONE: Record<BookmarkState, BookmarkTone> = {
  unfetched: "wait",
  fetched_pending: "wait",
  analyzing: "wait",
  insufficient: "warn",
  manual_review: "warn",
  registered: "ok",
  merged: "ok",
  excluded: "none",
  fetch_failed: "warn",
  closed_unresolved: "none",
};
export const TONE_MARK: Record<BookmarkTone, string> = { ok: "✓", wait: "◷", warn: "⚠", none: "－" };

/** 未解決（警告を出し続ける）状態。利用者が「対象外」「調査終了」を選ぶか、解決するまで一覧から消さない */
export const isUnresolved = (s: BookmarkState): boolean => s === "insufficient" || s === "manual_review" || s === "fetch_failed";
/** まだ処理の途中（結果待ち） */
export const isInProgress = (s: BookmarkState): boolean => s === "unfetched" || s === "fetched_pending" || s === "analyzing";
/** 終端（再調査しない）。受付終了・未解決は履歴として残す */
export const isTerminal = (s: BookmarkState): boolean => s === "registered" || s === "merged" || s === "excluded" || s === "closed_unresolved";

/** 候補（collection_candidates）の最小限の情報 */
export interface CandidateLite {
  status: string;
  job_state: string;
  fail_kind: string | null;
  lottery_id: string | null;
  triage: string | null;
  manual_state: string | null;
  due_at: string | null;
  draft: unknown;
  last_error?: string | null;
}

/** 恒久的な取得不能（削除・非公開・権限不足など。再試行しても変わらない）かの判定 */
export const PERMANENT_FAIL_KINDS = ["not_found", "robots", "js_render"] as const;
export const isPermanentFail = (kind: string | null | undefined): boolean => !!kind && (PERMANENT_FAIL_KINDS as readonly string[]).includes(kind);

export interface Derived {
  state: BookmarkState;
  reason: string;
  failureKind: "temporary" | "permanent" | null;
}

/**
 * 候補の現在の状態から、ブックマークの状態を決める。
 *  - 登録できたか（lottery_id）を最優先。取得できただけでは「登録完了」にしない
 *  - 受付終了後に未解決のものは「受付終了・未解決」（履歴として残す）
 */
export function deriveBookmarkState(c: CandidateLite | null, now: Date): Derived {
  if (!c) return { state: "unfetched", reason: "投稿の内容をまだ取得できていません", failureKind: null };
  if (c.status === "auto_registered" && c.lottery_id) return { state: "registered", reason: "", failureKind: null };
  if (c.status === "duplicate") return { state: "merged", reason: "既存の抽選と同じ内容のため統合しました", failureKind: null };
  if (c.status === "registered" && c.lottery_id) return { state: "registered", reason: "", failureKind: null };
  const closed = isApplicationClosed({ dueAt: c.due_at, draft: c.draft }, now);
  if (c.status === "excluded" || c.job_state === "skipped") {
    return closed ? { state: "closed_unresolved", reason: "応募受付が終了しました", failureKind: null } : { state: "excluded", reason: "抽選の対象外と判断しました", failureKind: null };
  }
  if (c.job_state === "failed") {
    const permanent = isPermanentFail(c.fail_kind);
    return closed ? { state: "closed_unresolved", reason: "取得できないまま応募受付が終了しました", failureKind: permanent ? "permanent" : "temporary" } : { state: "fetch_failed", reason: (c.last_error ?? "").slice(0, 200) || "投稿の取得・解析に失敗しました", failureKind: permanent ? "permanent" : "temporary" };
  }
  if (c.job_state === "processing") return { state: "analyzing", reason: "", failureKind: null };
  if (c.job_state === "pending" || c.job_state === "retry") {
    return { state: "fetched_pending", reason: c.job_state === "retry" ? "再試行を待っています" : "解析の順番を待っています", failureKind: null };
  }
  if (c.job_state === "review" || c.status === "pending") {
    if (closed) return { state: "closed_unresolved", reason: "情報が不足したまま応募受付が終了しました", failureKind: null };
    if (c.triage === "manual" && c.manual_state === "open") return { state: "manual_review", reason: "手動での確認が必要です", failureKind: null };
    return { state: "insufficient", reason: "情報が不足しているため、ほかの情報源で補完します", failureKind: null };
  }
  return { state: "fetched_pending", reason: "", failureKind: null };
}

export interface BookmarkRowLite {
  id: string;
  post_id: string;
  username: string;
  display_name: string;
  post_url: string;
  summary: string;
  state: BookmarkState;
  reason: string;
  failure_kind: "temporary" | "permanent" | null;
  deadline_at: string | null;
  popup_shown_at: string | null;
  user_closed_at: string | null;
  first_seen_at: string;
  supplement_note: string;
}

export interface BookmarkView {
  id: string;
  postId: string;
  /** X表示名（なければ @ユーザー名） */
  name: string;
  summary: string;
  url: string;
  state: BookmarkState;
  stateLabel: string;
  mark: string;
  tone: BookmarkTone;
  reason: string;
  /** 恒久的な取得不能（削除・非公開・権限不足）。一時的なエラーは再試行する */
  permanent: boolean;
  unresolved: boolean;
  /** 起動時ポップアップで未表示（新規） */
  isNew: boolean;
  supplementNote: string;
}

export function toBookmarkView(r: BookmarkRowLite): BookmarkView {
  const tone = BOOKMARK_TONE[r.state];
  return {
    id: r.id,
    postId: r.post_id,
    name: r.display_name || (r.username ? `@${r.username}` : "Xの投稿"),
    summary: r.summary,
    url: r.post_url,
    state: r.state,
    stateLabel: BOOKMARK_STATE_LABEL[r.state],
    mark: TONE_MARK[tone],
    tone,
    reason: r.reason,
    permanent: r.failure_kind === "permanent",
    unresolved: isUnresolved(r.state) && !r.user_closed_at,
    isNew: !r.popup_shown_at,
    supplementNote: r.supplement_note,
  };
}

/** 次の自動再調査までの間隔（試行回数に応じて延ばす。上限あり） */
export function retryDelayMs(retryCount: number): number {
  const H = 3600_000;
  return [1 * H, 3 * H, 6 * H, 12 * H, 24 * H][Math.min(retryCount, 4)];
}
export const MAX_BOOKMARK_RETRIES = 8;

/** 自動再調査を続けるか。一時的な失敗・情報不足のみ。恒久的な取得不能・受付終了・利用者が終了したものは続けない */
export function shouldRetry(r: Pick<BookmarkRowLite, "state" | "failure_kind" | "user_closed_at"> & { retry_count: number; deadline_at: string | null }, now: Date): boolean {
  if (r.user_closed_at) return false;
  if (r.state === "fetch_failed") return r.failure_kind !== "permanent" && r.retry_count < MAX_BOOKMARK_RETRIES;
  if (r.state === "insufficient" || r.state === "manual_review") {
    if (r.deadline_at && new Date(r.deadline_at).getTime() < now.getTime()) return false;
    return r.retry_count < MAX_BOOKMARK_RETRIES;
  }
  return false;
}
