/**
 * 共通基盤（案件ファイル・判断履歴・AI調査）の機能フラグ（Stage 9H-3B）。
 * 本番（Vercel）では、環境変数が何であっても常に無効。開発環境（TOREMANE_ENV=local）で、明示的にオンにしたときだけ有効。
 *   COLLECT_UNIFIED=on     : 判断履歴の保存・AIへの参考情報の追加・調査の要否の判定
 *   COLLECT_INVESTIGATE=on : さらに、調査が必要な案件でAI調査を呼び出す（調査機能が接続されているときだけ。既定は未接続）
 * 無効のとき、収集の動作・保存内容は従来と同一（フラグを読む以外に何もしない）。
 */
type Env = Record<string, string | undefined>;

export interface UnifiedMode {
  /** 判断履歴・参考情報・要否判定 */
  judgment: boolean;
  /** AI調査の呼び出し */
  investigate: boolean;
}

export function unifiedMode(env: Env = process.env): UnifiedMode {
  const local = env.TOREMANE_ENV === "local" && env.NODE_ENV !== "production";
  const judgment = local && env.COLLECT_UNIFIED === "on";
  return { judgment, investigate: judgment && env.COLLECT_INVESTIGATE === "on" };
}
