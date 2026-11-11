import "server-only";
import { deepClean } from "@/lib/text-safe";
import { excludedChainReason, matchExcludedChain, type ExcludedChain } from "@/lib/collector/chain-exclusion";
import type { Db } from "@/lib/server/lottery-service";

/**
 * 候補の新規保存（Stage 6B）。一括で保存し、失敗したら1件ずつに分けて保存する（1件の不具合でバッチ全体を失わない）。
 * 保存した件数・失敗した件数を返す。以前は結果の error を見ておらず、97件の保存が1件のために全滅しても「新規0件」と記録されていた。
 */
export async function saveCandidateRows(db: Db, rows: Record<string, unknown>[], excluded: readonly ExcludedChain[] = []): Promise<{ saved: number; failed: number; firstError: string | null }> {
  if (rows.length === 0) return { saved: 0, failed: 0, firstError: null };
  const nowIso = new Date().toISOString();
  const clean = rows.map((r) => {
    // 「信頼性なし」で除外した系列の題名は、解析（AI）の前に除外済みとして保存する（候補は残し、除外一覧から確認・戻せる。次回以降は再判定しない）（Stage 7Q）
    // X投稿（まとめアカウントが複数の店を並べる投稿を含む）は題名では判定せず、解析後の系列で判定する
    const m = r.status === "pending" && excluded.length > 0 && !String(r.dedupe_key ?? "").startsWith("x:") ? matchExcludedChain(excluded, { texts: [String(r.title ?? "")], textMode: "always" }) : null;
    return deepClean(m ? { ...r, status: "excluded", job_state: "skipped", triage: "auto_exclude", triage_reason: "信頼性なしの系列に一致", reasons: [excludedChainReason(m)], resolved_at: nowIso, completed_at: nowIso } : r);
  });
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
