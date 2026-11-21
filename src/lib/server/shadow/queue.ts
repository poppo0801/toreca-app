/**
 * シャドーのキューへの投入（通常収集側）。**AIは呼ばない・待たない**。投入の可否は DB（shadow_settings.enqueue_enabled。既定OFF）と環境変数の両方で決まる。
 * 失敗しても例外を出さない（旧方式の収集を止めない）。DB関数 `shadow_enqueue` が、世帯の整合・原文ハッシュの形式・設定・冪等性（同じ原文は二重に入れない）を検査する。
 */
import type { Db } from "@/lib/server/lottery-service";
import { shadowEnqueueAllowed } from "./allow";

export type ShadowEnqueuer = (candidateId: string, evidenceHash: string) => Promise<boolean>;

/** 投入口を作る。環境変数で許可されていなければ undefined（呼び出し側は何もしない＝追加の処理・待ち時間なし） */
export function makeShadowEnqueuer(db: Db, householdId: string, env: Record<string, string | undefined> = process.env): ShadowEnqueuer | undefined {
  if (!shadowEnqueueAllowed(env)) return undefined;
  return async (candidateId, evidenceHash) => {
    try {
      const call = (db as unknown as { rpc: (n: string, a: Record<string, unknown>) => PromiseLike<{ data: unknown; error: unknown }> }).rpc("shadow_enqueue", { p_household: householdId, p_candidate: candidateId, p_hash: evidenceHash });
      const r = await Promise.race([call, new Promise<null>((res) => setTimeout(() => res(null), 1500))]);
      return !!r && !r.error && r.data === true;
    } catch {
      return false;
    }
  };
}
