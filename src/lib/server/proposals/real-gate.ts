/**
 * 実AI（mode=real）の登録案を作るための「許可証」（Phase 2）。**承認済みの関門 `checkJudgmentRealRun` を通った評価入口だけが発行する**。
 * 登録案の生成（generate.ts）は、この許可証が無いと mode=real を生成しない。通常の画面・server action・cron・収集の接続口は、この許可証を作れない（静的テスト: 発行を import できるのは評価入口だけ）。
 * 環境変数だけ・本番にある秘密キーの存在だけ・ユーザーの通常の画面操作だけでは、有料AIは動かない（許可証の発行には 承認額・確認・開発専用キー・ローカルのSupabase が揃う必要がある）。
 * 保証の限界: 許可証は「承認額の範囲内で実行してよい」ことを示すだけで、API側の請求額を保証しない（予約は呼び出し前の見積・実費は呼び出し後にしか確定しない。`cost-preflight.ts`）。
 */
import type { JudgmentRealGate } from "@/lib/judgment/real-gate";

const MARK = Symbol("real-run-ticket");
const LOCAL_SUPABASE = /^http:\/\/(127\.0\.0\.1|localhost|\[::1\]):\d+\/?$/;

export interface RealRunTicket {
  readonly [MARK]: true;
  readonly model: string;
  readonly totalCapJpy: number;
  readonly perCaseCapJpy: number;
  /** 発行時刻（監査用） */
  readonly issuedAt: string;
  /** 発行元: eval=承認済み評価入口（ローカル）／prod_shadow=本番シャドー（多重の本番ゲートを通ったときだけ）。prod_shadow は検索・実取得を持たない読み取り専用の解析に限る */
  readonly origin: "eval" | "prod_shadow";
}

export type TicketResult = { ok: true; ticket: RealRunTicket } | { ok: false; reason: string };

/** 関門を通過した結果と環境から許可証を発行する。ローカルのSupabase以外（本番DB）・Vercel では発行しない */
export function issueRealRunTicket(gate: JudgmentRealGate, env: Record<string, string | undefined> = process.env): TicketResult {
  if (!gate.ok) return { ok: false, reason: `gate:${gate.reason}` };
  if (env.VERCEL || env.VERCEL_ENV) return { ok: false, reason: "vercel" };
  if (env.TOREMANE_ENV !== "local") return { ok: false, reason: "not_local_env" };
  if (!LOCAL_SUPABASE.test(env.NEXT_PUBLIC_SUPABASE_URL ?? "")) return { ok: false, reason: "not_local_database" }; // 本番の候補に対して実AIを実行しない
  return { ok: true, ticket: Object.freeze({ [MARK]: true as const, model: gate.model, totalCapJpy: gate.totalCapJpy, perCaseCapJpy: gate.perCaseCapJpy, issuedAt: new Date().toISOString(), origin: "eval" as const }) };
}

/**
 * 本番シャドー（Phase 3）の許可証。**本番の多重ゲート（productionPreviewPermission: 本番環境・2つのスイッチ・停止なし・DB設定・世帯の許可リスト・専用予算・専用キー）が allowed のときだけ**発行する。
 * 承認額の関門（checkJudgmentRealRun）は評価用（開発専用キー・ローカル限定）なので通らない。上限は本番側の設定（日次・月次・1件）から呼び出し側が渡す（ここでは1件上限を5円・総額を1000円で頭打ち）。
 */
export function issueProductionShadowTicket(decision: { allowed: true } | { allowed: false }, a: { model: string; totalCapJpy: number; perCaseCapJpy: number }): TicketResult {
  if (!decision.allowed) return { ok: false, reason: "prod_gate_denied" };
  if (!(a.totalCapJpy > 0) || !(a.perCaseCapJpy > 0)) return { ok: false, reason: "no_budget" };
  if (!/^claude-[a-z0-9.-]{3,60}$/.test(a.model)) return { ok: false, reason: "bad_model" };
  return { ok: true, ticket: Object.freeze({ [MARK]: true as const, model: a.model, totalCapJpy: Math.min(a.totalCapJpy, 1000), perCaseCapJpy: Math.min(a.perCaseCapJpy, 5), issuedAt: new Date().toISOString(), origin: "prod_shadow" as const }) };
}

export const isRealRunTicket = (x: unknown): x is RealRunTicket => !!x && typeof x === "object" && (x as Record<symbol, unknown>)[MARK] === true;
