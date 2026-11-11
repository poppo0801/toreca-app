/**
 * 接続先（本番／開発）の判定（Stage 8C）。開発サーバーが本番の Supabase に繋がらないための、アプリ側の安全装置。
 * scripts/lib/target.mjs と同じ判定（target.test.ts が一致を検査する）。本番ビルドの挙動は変えない。
 */
export const PRODUCTION_REFS: readonly string[] = ["yofqgfarflrlhzufjhqs"];

const HOSTED = /^https:\/\/([a-z0-9-]+)\.supabase\.(co|in)\/?$/;
const LOCAL = /^http:\/\/(127\.0\.0\.1|localhost|\[::1\]):\d+\/?$/;

export type TargetKind = "production" | "hosted-other" | "local" | "unknown" | "unset";

/** JWT（anon / service_role 鍵）の ref 要求。ローカルのデモ鍵には無い。値は返すだけで出力しない */
export function jwtRef(key: string | undefined): string | null {
  try {
    const part = (key ?? "").split(".")[1];
    if (!part) return null;
    const payload = JSON.parse(atob(part.replace(/-/g, "+").replace(/_/g, "/")));
    return typeof payload.ref === "string" ? payload.ref : null;
  } catch {
    return null;
  }
}

export function classifyTarget(url: string | undefined, ...keys: (string | undefined)[]): TargetKind {
  if (keys.some((k) => { const r = jwtRef(k); return !!r && PRODUCTION_REFS.includes(r); })) return "production";
  const u = (url ?? "").trim();
  if (!u) return "unset";
  const hosted = HOSTED.exec(u);
  if (hosted) return PRODUCTION_REFS.includes(hosted[1]) ? "production" : "hosted-other";
  if (LOCAL.test(u)) return "local";
  return "unknown";
}

/** ローカルの Supabase（http://127.0.0.1:ポート）。開発・テスト時のみ許可する（本番ビルドでは許可しない） */
export function isLocalSupabaseUrl(url: string | undefined): boolean {
  return LOCAL.test((url ?? "").trim());
}
