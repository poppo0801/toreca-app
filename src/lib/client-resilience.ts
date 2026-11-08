import { judgeLaunch, parseLifeMark, type LifeMark, type LifeState } from "@/lib/lifecycle";
import { canAutoReload, classifyError, logPath, sanitizeLogText, shouldRecord, type ClientErrorEntry, type ErrorKind, type ReloadRecord } from "@/lib/resilience";

/**
 * ブラウザ側の復旧・記録の補助（Stage 7C）。端末内に小さく保存し（最大30件）、サーバーのログへは重複を除いて少量だけ送る。
 * 認証トークン・個人情報・APIキーは記録しない（sanitizeLogText）。有料の監視サービスは使わない。
 */
const LOG_KEY = "tcg.clientErrors";
const RELOAD_KEY = "tcg.autoReloads";
const MAX_LOG = 30;
/** 1回の起動（ページ読み込み）でサーバーへ送る上限 */
const MAX_SEND = 8;

export const BUILD_ID = process.env.NEXT_PUBLIC_BUILD_ID ?? "dev";

let lastResumeAt = 0;
let sent = 0;
const seen: { key: string; at: number }[] = [];
export const markResume = (): void => {
  lastResumeAt = Date.now();
};
export const isAfterResume = (): boolean => lastResumeAt > 0 && Date.now() - lastResumeAt < 20_000;

export function readClientErrorLog(): ClientErrorEntry[] {
  try {
    const v = JSON.parse(window.localStorage.getItem(LOG_KEY) ?? "[]");
    return Array.isArray(v) ? (v as ClientErrorEntry[]) : [];
  } catch {
    return [];
  }
}
export function clearClientErrorLog(): void {
  try {
    window.localStorage.removeItem(LOG_KEY);
  } catch {
    /* noop */
  }
}

/** エラーを記録する。同じエラーは60秒に1回まで。戻り値は種類 */
export function recordClientError(e: unknown, where: string): ErrorKind {
  const kind = classifyError(e);
  try {
    const name = e instanceof Error ? e.name : typeof e;
    const message = sanitizeLogText(`${name}: ${e instanceof Error ? e.message : String(e)}`);
    const entry: ClientErrorEntry = { at: new Date().toISOString(), kind, path: logPath(window.location.pathname), afterResume: isAfterResume(), online: navigator.onLine, build: BUILD_ID, where, message };
    const key = `${kind}|${where}|${message}`;
    if (!shouldRecord(seen, key, Date.now())) return kind;
    seen.push({ key, at: Date.now() });
    if (seen.length > 50) seen.shift();
    try {
      window.localStorage.setItem(LOG_KEY, JSON.stringify([...readClientErrorLog(), entry].slice(-MAX_LOG)));
    } catch {
      /* 保存できなくても続行 */
    }
    if (sent < MAX_SEND && navigator.onLine) {
      sent++;
      const body = JSON.stringify(entry);
      if (!navigator.sendBeacon?.("/api/client-log", new Blob([body], { type: "application/json" }))) {
        void fetch("/api/client-log", { method: "POST", headers: { "Content-Type": "application/json" }, body, keepalive: true }).catch(() => undefined);
      }
    }
  } catch {
    /* 記録の失敗でアプリを止めない */
  }
  return kind;
}

/** 入力中の可能性があるか（ダイアログ・ボトムシートが開いている）。自動の再読み込みで入力が消えないように、開いている間は行わない */
export function hasUnsavedInput(): boolean {
  if (typeof document === "undefined") return false;
  return !!document.querySelector("[role='dialog'],[role='alertdialog']");
}

function readReloads(): ReloadRecord {
  try {
    const v = JSON.parse(window.localStorage.getItem(RELOAD_KEY) ?? "{}") as Partial<ReloadRecord>;
    return { times: Array.isArray(v.times) ? v.times.filter((t) => typeof t === "number") : [] };
  } catch {
    return { times: [] };
  }
}
/** 最終手段の全画面再読み込み。回数制限（10分に1回・1日3回まで）と入力中の保護を通ったときだけ実行する */
export function tryAutoReload(): boolean {
  const rec = readReloads();
  if (!canAutoReload(rec, Date.now(), { hasUnsavedInput: hasUnsavedInput() })) return false;
  try {
    window.localStorage.setItem(RELOAD_KEY, JSON.stringify({ times: [...rec.times, Date.now()].slice(-10) }));
  } catch {
    return false; // 履歴を残せないときは、繰り返しの再読み込みを避けるため行わない
  }
  window.location.reload();
  return true;
}

const RETRY_KEY = "tcg.boundaryRetries";
/** エラー画面の自動再試行の回数制限（60秒に2回まで）。許可されたら履歴に残す */
export function takeAutoRetry(): boolean {
  try {
    const now = Date.now();
    const v = (JSON.parse(window.sessionStorage.getItem(RETRY_KEY) ?? "[]") as number[]).filter((t) => now - t < 60_000);
    if (v.length >= 2) return false;
    window.sessionStorage.setItem(RETRY_KEY, JSON.stringify([...v, now]));
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------- 画面の終了の検出（Stage 7D）
const LIFE_KEY = "tcg.life";
let refreshLife: (() => void) | null = null;
/** 画面を移動したとき、最後にいた画面の印を更新する */
export const touchLifecycle = (): void => refreshLife?.();

/** エラー以外の出来事（前回の終わり方など）を、同じ記録に残す */
export function recordClientEvent(kind: ErrorKind, where: string, message: string, path: string): void {
  try {
    const entry: ClientErrorEntry = { at: new Date().toISOString(), kind, path: logPath(path), afterResume: false, online: navigator.onLine, build: BUILD_ID, where, message: sanitizeLogText(message) };
    window.localStorage.setItem(LOG_KEY, JSON.stringify([...readClientErrorLog(), entry].slice(-MAX_LOG)));
    if (sent < MAX_SEND && navigator.onLine) {
      sent++;
      const body = JSON.stringify(entry);
      if (!navigator.sendBeacon?.("/api/client-log", new Blob([body], { type: "application/json" }))) void fetch("/api/client-log", { method: "POST", headers: { "Content-Type": "application/json" }, body, keepalive: true }).catch(() => undefined);
    }
  } catch {
    /* 記録の失敗でアプリを止めない */
  }
}

/**
 * 起動時に前回の終わり方を判定して記録し、以降の状態（表示中・バックグラウンド・閉じた）を端末に残す。
 * iOSのWebコンテンツプロセスの終了は JavaScript では捕まえられないため、次の起動時の判定が唯一の手がかりになる。
 * 戻り値は後始末の関数。
 */
export function startLifecycleTracking(getPath: () => string): () => void {
  const read = () => parseLifeMark(window.localStorage.getItem(LIFE_KEY));
  const write = (state: LifeState) => {
    try {
      const mark: LifeMark = { state, at: Date.now(), path: logPath(getPath()), build: BUILD_ID };
      window.localStorage.setItem(LIFE_KEY, JSON.stringify(mark));
    } catch {
      /* noop */
    }
  };
  try {
    const verdict = judgeLaunch(read(), Date.now());
    if (verdict.kind === "terminated_while_visible") recordClientEvent("terminated", "lifecycle", `前回の画面は表示中に終了した可能性（${verdict.path}・表示中になってから${Math.round(verdict.sinceMs / 60000)}分）`, getPath());
    else if (verdict.kind === "discarded_in_background") recordClientEvent("discarded", "lifecycle", `バックグラウンドの間にページが破棄された（${verdict.path}・${Math.round(verdict.awayMs / 60000)}分間）`, getPath());
  } catch {
    /* 判定できなくても続行 */
  }
  write(document.visibilityState === "hidden" ? "hidden" : "visible");
  const onVis = () => write(document.visibilityState === "hidden" ? "hidden" : "visible");
  refreshLife = onVis;
  const onHide = (e: PageTransitionEvent) => write(e.persisted ? "hidden" : "closed");
  const onShow = () => write(document.visibilityState === "hidden" ? "hidden" : "visible");
  document.addEventListener("visibilitychange", onVis);
  window.addEventListener("pagehide", onHide);
  window.addEventListener("pageshow", onShow);
  return () => {
    refreshLife = null;
    document.removeEventListener("visibilitychange", onVis);
    window.removeEventListener("pagehide", onHide);
    window.removeEventListener("pageshow", onShow);
  };
}
