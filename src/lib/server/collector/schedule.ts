import "server-only";
import { currentSlot, dueSources, type AttemptLite, type DueResult } from "@/lib/collector/schedule";
import type { Db } from "@/lib/server/lottery-service";

/**
 * 定期収集の計画（Stage 6A）。今のスロットで、まだ取得できていない収集元を返す。
 * 手動収集の履歴は見ない。取得結果を読めないとき（DBエラー）は null を返し、呼び出し側は収集を始めない（記録なしで数分おきに再実行されるのを防ぐ）。
 */
export async function planScheduledCollection(db: Db, householdId: string, now: Date, hours: number | ReadonlyArray<number | null | undefined>): Promise<DueResult | null> {
  const slot = currentSlot(now, hours);
  const [src, att] = await Promise.all([
    db.from("collection_sources").select("id").eq("household_id", householdId).eq("enabled", true),
    db.from("collection_source_attempts").select("source_id,trigger,slot_date,status,created_at").eq("household_id", householdId).eq("slot_date", slot.date).gte("created_at", slot.start.toISOString()).eq("trigger", "cron"),
  ]);
  if (src.error || att.error) {
    console.error(`[collect] 定期収集の計画を作れませんでした code=${src.error?.code ?? att.error?.code ?? "?"}`);
    return null;
  }
  const attempts: AttemptLite[] = (att.data ?? []).map((a) => ({ sourceId: a.source_id, trigger: "cron", slotDate: a.slot_date, status: a.status as AttemptLite["status"], at: new Date(a.created_at) }));
  return dueSources(now, hours, (src.data ?? []).map((s) => s.id), attempts);
}
