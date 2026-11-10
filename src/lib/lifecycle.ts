/**
 * 画面（Webコンテンツプロセス）が異常終了していないかの検出（Stage 7D・純関数部分）。
 * iOSでは、メモリ不足などでWebKitのプロセスが終了すると JavaScript では何も実行できない。そのため「終了の瞬間」ではなく、
 * 次に起動したときに「前回の状態」を見て判定する（端末に小さな印を残す）。
 *   closed  = 前回は正常に閉じた（pagehide）。通常の再読み込み・画面の離脱
 *   hidden  = 前回はバックグラウンドへ移ったまま戻らなかった（OSがバックグラウンドのページを破棄した。iOSでは通常の動作）
 *   visible = 前回は表示中のまま、閉じる通知（pagehide）なしに終わった → 表示中にプロセスが終了した可能性（メモリ不足・描画の失敗など）
 */
export type LifeState = "visible" | "hidden" | "closed";
export interface LifeMark {
  state: LifeState;
  /** 最後に状態が変わった時刻(ms) */
  at: number;
  /** 最後にいた画面（IDを除いたパス） */
  path: string;
  build: string;
}

export type LaunchVerdict = { kind: "first" } | { kind: "normal" } | { kind: "discarded_in_background"; path: string; awayMs: number } | { kind: "terminated_while_visible"; path: string; sinceMs: number };

/** 起動時に、前回の印から前回の終わり方を判定する */
export function judgeLaunch(prev: LifeMark | null, now: number): LaunchVerdict {
  if (!prev) return { kind: "first" };
  if (prev.state === "closed") return { kind: "normal" };
  if (prev.state === "hidden") return { kind: "discarded_in_background", path: prev.path, awayMs: Math.max(0, now - prev.at) };
  return { kind: "terminated_while_visible", path: prev.path, sinceMs: Math.max(0, now - prev.at) };
}

export function parseLifeMark(raw: string | null): LifeMark | null {
  if (!raw) return null;
  try {
    const v = JSON.parse(raw) as Partial<LifeMark>;
    if ((v.state === "visible" || v.state === "hidden" || v.state === "closed") && typeof v.at === "number" && typeof v.path === "string") return { state: v.state, at: v.at, path: v.path.slice(0, 80), build: String(v.build ?? "") };
  } catch {
    /* 壊れた印は無視 */
  }
  return null;
}

/** 前回の画面へ戻してよい画面（IDやクエリを含まない一覧・設定の画面だけ。編集中の内容は復元しない） */
const RESTORABLE = /^\/(lotteries|purchases|finance|records|battles|collection|settings(\/[a-z-]+)?)$/;
/** 復元する最大の離席時間（これより長いときは、起動画面から始める） */
export const RESTORE_WITHIN_MS = 30 * 60_000;

/**
 * iOSがバックグラウンドのページを破棄したあと、ホーム画面アプリが起動画面（/lotteries）から始まったときに、直前の画面へ戻すか（Stage 7O・純関数）。
 * 戻すのは「バックグラウンドのまま破棄された（OSの通常のメモリ回収）」かつ30分以内で、いまが起動画面（クエリなし）で、直前の画面が別の一覧・設定のとき。
 * 「表示中に終了した可能性」（クラッシュの疑い）のときは戻さない（同じ画面で繰り返し落ちるのを避け、起動画面から始める）。
 * 戻り値は戻り先のパス（戻さないときは null）。
 */
export function restorePath(verdict: LaunchVerdict, current: { pathname: string; search: string }): string | null {
  if (verdict.kind !== "discarded_in_background") return null;
  if (verdict.awayMs > RESTORE_WITHIN_MS) return null;
  if (current.pathname !== "/lotteries" || current.search !== "") return null;
  if (verdict.path === "/lotteries" || !RESTORABLE.test(verdict.path)) return null;
  return verdict.path;
}
