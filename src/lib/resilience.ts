/**
 * 復帰時・通信エラー時の自動復旧に使う判定（Stage 7C・純関数）。
 * 方針: 一時的な通信失敗は部分的に再取得する。全画面の再読み込みは最終手段で、回数制限をかけ、入力中（ダイアログ表示中）は行わない。
 */

export type ErrorKind = "chunk" | "skew" | "network" | "timeout" | "auth" | "other";

const text = (e: unknown): string => {
  if (e instanceof Error) return `${e.name} ${e.message}`;
  if (typeof e === "string") return e;
  try {
    return JSON.stringify(e) ?? "";
  } catch {
    return "";
  }
};

/**
 * エラーの種類。chunk=古い画面のJavaScript（新しいデプロイで消えた）が読み込めない / skew=古い画面から新しいサーバーへの呼び出しが合わない /
 * network=通信失敗（オフライン・切断）/ timeout=時間切れ / auth=ログインが必要（通信エラーとは区別する）
 */
export function classifyError(e: unknown): ErrorKind {
  const t = text(e);
  if (/ChunkLoadError|Loading chunk|Loading CSS chunk|Failed to fetch dynamically imported module|error loading dynamically imported module|Importing a module script failed/i.test(t)) return "chunk";
  if (/Failed to find Server Action|older or newer deployment|Server Action .* not found|UnrecognizedActionError/i.test(t)) return "skew";
  if (/読み込みに時間がかかっています|timed? ?out|timeout|ETIMEDOUT/i.test(t)) return "timeout";
  if (/Failed to fetch|NetworkError|Load failed|network connection was lost|fetch failed|ECONNRESET|ERR_NETWORK|ERR_INTERNET_DISCONNECTED|通信に失敗|offline/i.test(t)) return "network";
  if (/ログインが必要|not authenticated|Auth session missing|JWT expired/i.test(t)) return "auth";
  return "other";
}

/** 通信の一時的な失敗か（再試行してよい）。認証の拒否や画面のバグは含めない */
export const isTransient = (k: ErrorKind): boolean => k === "network" || k === "timeout";

/** Supabase の認証確認が「通信の失敗」で終わったか（セッションが無効になったわけではない＝ログアウトさせない） */
export function isTransientAuthError(e: { name?: string; status?: number; message?: string } | null | undefined): boolean {
  if (!e) return false;
  if (e.name === "AuthRetryableFetchError") return true;
  if (typeof e.status === "number" && (e.status === 0 || e.status >= 500)) return true;
  return /fetch failed|network|timeout|ECONN|ENOTFOUND/i.test(e.message ?? "");
}

/** ログに残す文言の整理: URLのクエリ・トークン状の長い文字列・メールアドレスを除き、短くする（認証情報・個人情報を記録しない） */
export function sanitizeLogText(s: string, max = 160): string {
  return s
    .replace(/https?:\/\/[^\s)"']+/g, (u) => {
      try {
        return new URL(u).origin + new URL(u).pathname.replace(/[0-9a-f]{8}-[0-9a-f-]{27}/gi, ":id");
      } catch {
        return "(url)";
      }
    })
    .replace(/eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]*/g, "(token)")
    .replace(/[A-Za-z0-9_-]{32,}/g, "(token)")
    .replace(/[\w.+-]+@[\w-]+\.[\w.-]+/g, "(email)")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);
}

/** 画面のパスの整理（IDなどの可変部分を除く） */
export const logPath = (p: string): string => p.split("?")[0].replace(/[0-9a-f]{8}-[0-9a-f-]{27}/gi, ":id").slice(0, 80);

export interface ClientErrorEntry {
  /** ISO日時 */
  at: string;
  kind: ErrorKind;
  /** 発生画面（パス） */
  path: string;
  /** バックグラウンドから復帰した直後（約20秒以内）か */
  afterResume: boolean;
  online: boolean;
  /** アプリのビルド識別（コミットの短縮ID） */
  build: string;
  /** 発生箇所（error / unhandledrejection / boundary / load など） */
  where: string;
  /** エラーの名前と短い文言（整理済み） */
  message: string;
}

/** 同じエラーを繰り返し記録しない（kind+where+message が同じものは windowMs の間は1回） */
export function shouldRecord(history: { key: string; at: number }[], key: string, now: number, windowMs = 60_000): boolean {
  return !history.some((h) => h.key === key && now - h.at < windowMs);
}

// ---------------------------------------------------------------- 復帰時の再取得
/** 復帰したときに何をするか。短い切替では何もしない。長く離れていたら必要なデータだけ静かに再取得（全画面の再読み込みはしない） */
export type ResumeAction = "none" | "refresh" | "wait-online";
export const RESUME_MIN_HIDDEN_MS = 30_000;
export const RESUME_MIN_INTERVAL_MS = 20_000;
export function resumeAction(o: { hiddenMs: number; sinceLastLoadMs: number; online: boolean; loading: boolean }): ResumeAction {
  if (o.loading) return "none";
  if (!o.online) return "wait-online";
  if (o.hiddenMs < RESUME_MIN_HIDDEN_MS && o.sinceLastLoadMs < 10 * 60_000) return "none";
  if (o.sinceLastLoadMs < RESUME_MIN_INTERVAL_MS) return "none";
  return "refresh";
}

// ---------------------------------------------------------------- 自動の全画面再読み込み（最終手段）の回数制限
export interface ReloadRecord {
  /** 再読み込みした時刻(ms)の履歴 */
  times: number[];
}
export const RELOAD_MIN_GAP_MS = 10 * 60_000;
export const RELOAD_MAX_PER_DAY = 3;
export function canAutoReload(rec: ReloadRecord, now: number, o: { hasUnsavedInput: boolean }): boolean {
  if (o.hasUnsavedInput) return false;
  const recent = rec.times.filter((t) => now - t < 24 * 3600_000);
  if (recent.length >= RELOAD_MAX_PER_DAY) return false;
  const last = recent[recent.length - 1];
  return last === undefined || now - last >= RELOAD_MIN_GAP_MS;
}

/** 通信エラーの再試行の待ち時間(ms)。回数は呼び出し側で制限する */
export const retryDelayMs = (attempt: number): number => [800, 2500, 6000][Math.min(attempt, 2)];
