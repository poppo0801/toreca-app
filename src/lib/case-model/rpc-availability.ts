/**
 * DB関数（RPC）の呼び出し結果の分類（Stage 10E 追加修正・純関数）。
 *
 * 目的: 履歴保護の関数 `lottery_history_blockers`（マイグレーション108）が**まだ存在しない環境**（未適用の本番）でだけ、
 * 従来の保護確認へ戻る。権限拒否・接続障害・タイムアウト・未知のエラーを「関数が無い」とみなして**保護なしで続行しない**。
 *
 * 「関数が存在しない」と判定してよいのは、次の明確な場合だけ:
 *  - PostgREST のコード PGRST202（スキーマキャッシュに該当関数が無い）
 *  - PostgreSQL のコード 42883（undefined_function）
 *  - HTTP 404 かつ、メッセージが関数の不在を示す（"Could not find the function" / "does not exist"）
 * 認証・権限（401/403・42501・PGRST301 など）、5xx、ネットワーク障害（code なし・status 0）、未知のコードは、すべて「判定不能」。
 */
export type RpcOutcome = "ok" | "missing_function" | "indeterminate";

export interface RpcErrorLike {
  code?: string | null;
  message?: string | null;
  details?: string | null;
  hint?: string | null;
  status?: number | null;
}

const MISSING_TEXT = /could not find the function|function .* does not exist|undefined function/i;

export function classifyRpcResult(r: { data: unknown; error: RpcErrorLike | null | undefined; status?: number | null }, expect: (data: unknown) => boolean): RpcOutcome {
  const e = r.error;
  if (!e) return expect(r.data) ? "ok" : "indeterminate";
  const code = (e.code ?? "").toUpperCase();
  const status = e.status ?? r.status ?? null;
  const text = `${e.message ?? ""} ${e.details ?? ""} ${e.hint ?? ""}`;
  // 権限・認証の失敗は、メッセージに "function" と書かれていても不在とはみなさない
  if (status === 401 || status === 403 || code === "42501" || code.startsWith("PGRST3")) return "indeterminate";
  if (code === "PGRST202" || code === "42883") return "missing_function";
  if (status === 404 && MISSING_TEXT.test(text)) return "missing_function";
  return "indeterminate";
}
