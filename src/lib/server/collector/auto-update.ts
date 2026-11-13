import "server-only";
import { appendHistory, planAutoUpdate, UPDATE_COLUMNS, updateFlexKey, type AutoUpdatePlan, type UpdateEntry } from "@/lib/collector/auto-update";
import { jstDayString, type FieldChange } from "@/lib/collector/queue";
import type { LotteryInput } from "@/lib/lottery-input";
import { lotteryRow } from "@/lib/lottery-payload";
import type { Db } from "@/lib/server/lottery-service";
import type { Json } from "@/types/database";
import type { Lottery } from "@/types/domain";

/**
 * 登録済み抽選の自動更新（Stage 9B）。判定は src/lib/collector/auto-update.ts（純関数）。
 * 反映するのは日時の列だけ。応募・当選・購入・通知の記録には触れない。更新前後の値・情報源・時刻を lotteries.update_history に保存し、元に戻せる。
 * 失敗（列が無い・同時更新で競合した）ときは何も変えず null を返し、呼び出し側が従来の「更新の提案」へ回す。
 */
const MANUAL_EDIT_TOLERANCE_MS = 120_000;
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- 新しい列は生成型に無い
const raw = (db: Db) => db as any;

export interface AutoUpdateResult {
  plan: AutoUpdatePlan;
  applied: FieldChange[];
}

export async function tryAutoUpdate(
  db: Db,
  lot: Lottery,
  input: LotteryInput,
  changes: FieldChange[],
  o: { sourceUrl: string; sourceKind: string; official: boolean; now: Date },
): Promise<AutoUpdateResult | null> {
  const { data: row, error } = await raw(db).from("lotteries").select("*").eq("id", lot.id).maybeSingle();
  if (error || !row) return null;
  const history = (Array.isArray(row.update_history) ? row.update_history : []) as UpdateEntry[];
  const base = new Date(row.cautions_updated_at ?? row.created_at).getTime();
  const nowIso = o.now.toISOString();
  const plan = planAutoUpdate(changes, input, {
    lot,
    autoRegistered: row.source_kind === "auto",
    manuallyEdited: new Date(row.updated_at).getTime() - base > MANUAL_EDIT_TOLERANCE_MS,
    archived: !!row.archived_at,
    official: o.official,
    sameSource: ((row.source_urls ?? []) as string[]).includes(o.sourceUrl),
    history,
    today: jstDayString(o.now),
    now: nowIso,
  });
  if (plan.apply.length === 0) return { plan, applied: [] };
  const newRow = lotteryRow(input as never, null) as unknown as Record<string, unknown>;
  const before: Record<string, unknown> = {};
  const after: Record<string, unknown> = {};
  const afterKeys: Record<string, string> = {};
  const patch: Record<string, unknown> = {};
  for (const ch of plan.apply) {
    for (const col of UPDATE_COLUMNS[ch.key] ?? []) {
      before[col] = row[col] ?? null;
      after[col] = newRow[col] ?? null;
      patch[col] = newRow[col] ?? null;
    }
    afterKeys[ch.key] = updateFlexKey(input[ch.key as "applyDeadline"] as never);
  }
  const entry: UpdateEntry = {
    id: crypto.randomUUID(),
    at: nowIso,
    keys: plan.apply.map((c) => c.key),
    labels: plan.apply.map((c) => c.label),
    before,
    after,
    afterKeys,
    summary: plan.apply.map((c) => `${c.label}: ${c.before} → ${c.after}`),
    sourceUrl: o.sourceUrl,
    sourceKind: o.sourceKind,
    official: o.official,
  };
  // 締切が埋まったら、「応募締切が未確認」の注意を外す
  const cautions = ((Array.isArray(row.cautions) ? row.cautions : []) as { code: string }[]).filter((c) => !((c.code === "deadline_unknown" || c.code === "end_candidate") && plan.apply.some((a) => a.key === "applyDeadline")));
  const { data: upd, error: ue } = await raw(db)
    .from("lotteries")
    .update({ ...patch, update_history: appendHistory(history, entry) as unknown as Json, cautions: cautions as unknown as Json, cautions_updated_at: nowIso })
    .eq("id", lot.id)
    .eq("updated_at", row.updated_at)
    .select("id");
  if (ue || !upd || upd.length === 0) return null; // 競合・失敗: 反映しない（提案に回す）
  return { plan, applied: plan.apply };
}

/** 列の値の比較（日時は表記の違い（Z／+00:00）を吸収する） */
const sameVal = (a: unknown, b: unknown): boolean => {
  const x = a ?? null;
  const y = b ?? null;
  if (x === y) return true;
  if (typeof x === "string" && typeof y === "string" && /^\d{4}-\d{2}-\d{2}T/.test(x) && /^\d{4}-\d{2}-\d{2}T/.test(y)) return Date.parse(x) === Date.parse(y);
  return false;
};

export type RevertResult = { ok: true; reverted: string[] } | { ok: false; error: string };

/** 自動更新を元に戻す（利用者の操作）。その後に値が変わっている項目があれば、上書きせず戻さない。戻した抽選は手動で更新された扱いになり、以後の自動更新は提案になる */
export async function revertAutoUpdate(db: Db, lotteryId: string, entryId: string, actor: string | null): Promise<RevertResult> {
  const { data: row, error } = await raw(db).from("lotteries").select("*").eq("id", lotteryId).maybeSingle();
  if (error || !row) return { ok: false, error: "抽選が見つかりません" };
  const history = (Array.isArray(row.update_history) ? row.update_history : []) as UpdateEntry[];
  const entry = history.find((h) => h.id === entryId);
  if (!entry) return { ok: false, error: "元に戻せる更新が見つかりません" };
  if (entry.revertedAt) return { ok: false, error: "すでに元に戻しています" };
  for (const [col, v] of Object.entries(entry.after)) {
    if (!sameVal(row[col], v)) return { ok: false, error: "その後に内容が変更されているため、元に戻せません。内容を確認して手動で修正してください" };
  }
  const nextHistory = history.map((h) => (h.id === entryId ? { ...h, revertedAt: new Date().toISOString() } : h));
  const { data: upd, error: ue } = await raw(db)
    .from("lotteries")
    .update({ ...entry.before, update_history: nextHistory as unknown as Json, updated_by_profile_id: actor })
    .eq("id", lotteryId)
    .eq("updated_at", row.updated_at)
    .select("id");
  if (ue || !upd || upd.length === 0) return { ok: false, error: "元に戻せませんでした（同時に変更された可能性があります）" };
  return { ok: true, reverted: entry.labels };
}
