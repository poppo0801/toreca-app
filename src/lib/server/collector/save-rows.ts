import "server-only";
import { deepClean } from "@/lib/text-safe";
import type { Db } from "@/lib/server/lottery-service";

/**
 * 候補の新規保存（Stage 6B）。一括で保存し、失敗したら1件ずつに分けて保存する（1件の不具合でバッチ全体を失わない）。
 * 保存した件数・失敗した件数を返す。以前は結果の error を見ておらず、97件の保存が1件のために全滅しても「新規0件」と記録されていた。
 */
export async function saveCandidateRows(db: Db, rows: Record<string, unknown>[]): Promise<{ saved: number; failed: number; firstError: string | null }> {
  if (rows.length === 0) return { saved: 0, failed: 0, firstError: null };
  const clean = rows.map((r) => deepClean(r));
  const opts = { onConflict: "household_id,dedupe_key", ignoreDuplicates: true } as const;
  const batch = await db.from("collection_candidates").upsert(clean as never, opts).select("id");
  if (!batch.error) return { saved: batch.data?.length ?? 0, failed: 0, firstError: null };
  let saved = 0;
  let failed = 0;
  let firstError: string | null = `${batch.error.code ?? "?"}`;
  for (const r of clean) {
    const one = await db.from("collection_candidates").upsert([r] as never, opts).select("id");
    if (one.error) {
      failed++;
      firstError = firstError ?? `${one.error.code ?? "?"}`;
    } else saved += one.data?.length ?? 0;
  }
  console.error(`[collect] 候補の一括保存に失敗したため1件ずつ保存しました code=${batch.error.code ?? "?"} 保存${saved}件・失敗${failed}件`);
  return { saved, failed, firstError };
}
