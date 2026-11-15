/**
 * 「正常」と判断された案件の抜き取り再確認の対象判定（Stage 9H-3C・純関数。今回は判定と記録だけで、再確認の実行はしない）。
 * 案件IDのハッシュで決める（再実行しても同じ結果・偏りなし）。割合 0 なら対象なし。割合は環境変数 COLLECT_SPOTCHECK_RATE（0〜1。既定 0）。
 */
import { createHash } from "node:crypto";

export function spotCheckRate(env: Record<string, string | undefined> = process.env): number {
  const r = Number(env.COLLECT_SPOTCHECK_RATE);
  return Number.isFinite(r) ? Math.min(1, Math.max(0, r)) : 0;
}

export function spotCheckEligible(id: string, rate: number): boolean {
  if (!(rate > 0)) return false;
  const h = createHash("sha256").update(id).digest();
  return h.readUInt32BE(0) / 0xffffffff < rate;
}
