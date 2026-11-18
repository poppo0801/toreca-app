import "server-only";
import { confidenceOf, endCandidateCaution, STALE_UNKNOWN_DEADLINE_DAYS, type Caution } from "@/lib/collector/attention";
import { planCompletion, type CompletionFields } from "@/lib/collector/complete";
import { dbToFlex, flexInputToDb, flexToInput, type LotteryInput } from "@/lib/lottery-input";
import type { Db } from "@/lib/server/lottery-service";
import type { Json } from "@/types/database";

/**
 * 注意付きの自動登録の抽選を、新しい情報で自動補完する（Stage 7A）。判定は src/lib/collector/complete.ts（純関数）。
 * 対象は「自動収集で登録され、注意が残っていて、登録後に手動編集されていない」抽選だけ。
 *  - 手動編集の判定: 最後の更新が、自動処理による更新（cautions_updated_at）から2分以内であること（利用者が保存し直した抽選は触らない）
 *  - 値のある項目は上書きしない（締切の暫定採用・公式による更新だけが例外。planCompletion を参照）
 */
const MANUAL_EDIT_TOLERANCE_MS = 120_000;
type FlexCols = { precision: string; date: string | null; at: string | null };

const COLS = {
  applyStart: ["apply_start_precision", "apply_start_date", "apply_start_at"],
  resultDate: ["result_precision", "result_date", "result_at"],
  applyDeadline: ["apply_deadline_precision", "apply_deadline_date", "apply_deadline_at"],
  procedureStart: ["procedure_start_precision", "procedure_start_date", "procedure_start_at"],
  procedureDeadline: ["procedure_deadline_precision", "procedure_deadline_date", "procedure_deadline_at"],
  receiveStart: ["receive_start_precision", "receive_start_date", "receive_start_at"],
  receiveDeadline: ["receive_deadline_precision", "receive_deadline_date", "receive_deadline_at"],
} as const;
type FlexKey = keyof typeof COLS;

export interface CompleteResult {
  updated: boolean;
  filled: string[];
  skipped?: "not_found" | "not_auto" | "no_cautions" | "manual_edit";
}

export async function autoCompleteLottery(db: Db, lotteryId: string, incoming: CompletionFields, o: { official: boolean; now: Date }): Promise<CompleteResult> {
  const { data: row } = await db.from("lotteries").select("*").eq("id", lotteryId).maybeSingle();
  if (!row) return { updated: false, filled: [], skipped: "not_found" };
  if (row.source_kind !== "auto" || row.archived_at) return { updated: false, filled: [], skipped: "not_auto" };
  const cautions = (Array.isArray(row.cautions) ? row.cautions : []) as unknown as Caution[];
  if (cautions.length === 0) return { updated: false, filled: [], skipped: "no_cautions" };
  const base = new Date(row.cautions_updated_at ?? row.created_at).getTime();
  if (new Date(row.updated_at).getTime() - base > MANUAL_EDIT_TOLERANCE_MS) return { updated: false, filled: [], skipped: "manual_edit" };

  const r = row as unknown as Record<string, string | null>;
  const flex = (k: FlexKey) => flexToInput(dbToFlex(r[COLS[k][0]] ?? "unknown", r[COLS[k][1]] ?? null, r[COLS[k][2]] ?? null));
  const cur: CompletionFields = {
    applyStart: flex("applyStart"),
    resultDate: flex("resultDate"),
    applyDeadline: flex("applyDeadline"),
    procedureStart: flex("procedureStart"),
    procedureDeadline: flex("procedureDeadline"),
    receiveStart: flex("receiveStart"),
    receiveDeadline: flex("receiveDeadline"),
    receiveMethod: row.receive_method as LotteryInput["receiveMethod"],
    applyMethod: row.apply_method as LotteryInput["applyMethod"],
  };
  const plan = planCompletion(cur, incoming, cautions, { official: o.official, now: o.now.toISOString() });
  if (Object.keys(plan.patch).length === 0 && !plan.cautionsChanged) return { updated: false, filled: [] };

  const update: Record<string, unknown> = {};
  for (const k of Object.keys(COLS) as FlexKey[]) {
    const v = plan.patch[k];
    if (!v) continue;
    const db2 = flexInputToDb(v as never) as FlexCols;
    update[COLS[k][0]] = db2.precision;
    update[COLS[k][1]] = db2.date;
    update[COLS[k][2]] = db2.at;
  }
  if (plan.patch.receiveMethod) update.receive_method = plan.patch.receiveMethod;
  if (plan.patch.applyMethod) update.apply_method = plan.patch.applyMethod;
  const hasConflict = plan.cautions.some((c) => c.code.startsWith("conflict_") || c.code === "deadline_conflict" || c.code === "text_conflict");
  update.cautions = plan.cautions as unknown as Json;
  const conf = confidenceOf({}, plan.cautions.length > 0, hasConflict);
  update.confidence = conf === "single_source" && o.official ? "official" : conf;
  update.cautions_updated_at = new Date().toISOString();
  const { error } = await db.from("lotteries").update(update as never).eq("id", lotteryId);
  return error ? { updated: false, filled: [] } : { updated: true, filled: plan.filled };
}

/**
 * 補足投稿（応募条件だけを説明する投稿）で、登録済みの注意付き抽選の応募条件を補う（Stage 9A）。
 * 応募条件が未登録のときだけ補う（値のある項目は上書きしない）。手動編集された抽選・自動収集でない抽選には触れない。補ったら「応募条件が未確認」の注意を解除する。
 */
export async function autoCompleteConditions(db: Db, lotteryId: string, conditionsText: string): Promise<CompleteResult> {
  const text = conditionsText.trim().slice(0, 2000);
  if (!text) return { updated: false, filled: [] };
  const { data: row } = await db.from("lotteries").select("*").eq("id", lotteryId).maybeSingle();
  if (!row) return { updated: false, filled: [], skipped: "not_found" };
  if (row.source_kind !== "auto" || row.archived_at) return { updated: false, filled: [], skipped: "not_auto" };
  const base = new Date(row.cautions_updated_at ?? row.created_at).getTime();
  if (new Date(row.updated_at).getTime() - base > MANUAL_EDIT_TOLERANCE_MS) return { updated: false, filled: [], skipped: "manual_edit" };
  if ((row.conditions_text ?? "").trim()) return { updated: false, filled: [] };
  const cautions = ((Array.isArray(row.cautions) ? row.cautions : []) as unknown as Caution[]).filter((c) => c.code !== "conditions_unknown");
  const hasConflict = cautions.some((c) => c.code.startsWith("conflict_") || c.code === "deadline_conflict" || c.code === "text_conflict");
  const { error } = await db.from("lotteries").update({ conditions_text: text, cautions: cautions as unknown as Json, confidence: confidenceOf({}, cautions.length > 0, hasConflict), cautions_updated_at: new Date().toISOString() } as never).eq("id", lotteryId);
  return error ? { updated: false, filled: [] } : { updated: true, filled: ["応募条件"] };
}

/**
 * 日時が長く確認できていない自動登録の抽選に、「終了候補」の注意を付ける（Stage 9B）。
 * 非表示・削除・アーカイブ・終了日時の推測はしない。一覧には表示され続け、情報源の再確認も続く。日時が分かれば注意は自動で外れる。
 * 対象: 自動収集で登録され、手動編集されておらず、「応募締切が未確認」の注意が付いたまま、登録から days 日を超えたもの。
 */
export async function markEndCandidates(db: Db, householdId: string, now: Date, o: { days?: number; limit?: number } = {}): Promise<number> {
  const days = o.days ?? STALE_UNKNOWN_DEADLINE_DAYS;
  const before = new Date(now.getTime() - days * 86_400_000).toISOString();
  const { data } = await db
    .from("lotteries")
    .select("id,cautions,created_at,updated_at,cautions_updated_at")
    .eq("household_id", householdId)
    .eq("source_kind", "auto")
    .is("archived_at", null)
    .contains("cautions", JSON.stringify([{ code: "deadline_unknown" }]))
    .lt("created_at", before)
    .limit(o.limit ?? 30);
  let marked = 0;
  for (const r of data ?? []) {
    const cs = (Array.isArray(r.cautions) ? r.cautions : []) as unknown as Caution[];
    if (cs.some((c) => c.code === "end_candidate")) continue;
    const base = new Date(r.cautions_updated_at ?? r.created_at).getTime();
    if (new Date(r.updated_at).getTime() - base > MANUAL_EDIT_TOLERANCE_MS) continue; // 手動で編集された抽選には触れない
    const next = [...cs, endCandidateCaution(now.toISOString(), (now.getTime() - new Date(r.created_at).getTime()) / 86_400_000)];
    const { error } = await db.from("lotteries").update({ cautions: next as unknown as Json, cautions_updated_at: now.toISOString() } as never).eq("id", r.id).eq("updated_at", r.updated_at);
    if (!error) marked++;
  }
  return marked;
}

/**
 * 同一企画の複数商品を、既存の1枚の抽選カードに追加する（Stage 9C・⑨）。判断は src/lib/collector/multi-product.ts（純関数）。
 * 守ること: 自動収集で登録され手動編集されていない抽選だけ／応募の記録が1件でもある抽選には商品を足さない（応募した内容の意味が変わるため）／
 * 追加するだけで、既存の商品・応募・当選・購入の記録は変更しない。応募方式（全商品・どれか1つ）は告知から確定できないため「未確認」の注意を付ける。
 * 追加できなかったとき（条件に合わない・競合）は何も変更せず null を返し、呼び出し側は通常の流れ（新規・重複判定）に戻る。
 */
export async function addProductsToLottery(
  db: Db,
  lotteryId: string,
  items: { productId: string; quantity: number; unit: string }[],
  o: { actor: string | null; now: Date; sourceUrl: string },
): Promise<{ added: number } | null> {
  if (items.length === 0 || items.some((i) => !["box", "pack", "set"].includes(i.unit))) return null;
  const { data: row } = await db.from("lotteries").select("id,household_id,source_kind,archived_at,cautions,cautions_updated_at,created_at,updated_at,multi_mode").eq("id", lotteryId).maybeSingle();
  if (!row || row.source_kind !== "auto" || row.archived_at) return null;
  const base = new Date(row.cautions_updated_at ?? row.created_at).getTime();
  if (new Date(row.updated_at).getTime() - base > MANUAL_EDIT_TOLERANCE_MS) return null;
  const { count: apps } = await db.from("applications").select("id", { count: "exact", head: true }).eq("lottery_id", lotteryId);
  if ((apps ?? 0) > 0) return null;
  const { data: cur } = await db.from("lottery_items").select("product_id").eq("lottery_id", lotteryId);
  const have = new Set((cur ?? []).map((x) => x.product_id));
  const fresh = items.filter((i) => !have.has(i.productId));
  if (fresh.length === 0) return { added: 0 };
  const ins = await db.from("lottery_items").insert(fresh.map((i) => ({ household_id: row.household_id, lottery_id: lotteryId, product_id: i.productId, quantity: i.quantity, unit: i.unit, updated_by_profile_id: o.actor })) as never);
  if (ins.error) return null;
  const cautions = (Array.isArray(row.cautions) ? row.cautions : []) as unknown as Caution[];
  const nowIso = o.now.toISOString();
  const next = cautions.some((c) => c.code === "mode_unconfirmed") ? cautions : [...cautions, { code: "mode_unconfirmed", field: "mode", message: "複数商品の応募方式（全商品を対象／どれか1つ）が確認できていません。同一企画の商品として追加しました", at: nowIso } as Caution];
  // 商品が複数になるため、応募方式は未確定のまま「全商品を対象」として扱う（確認の注意を付ける）。自動処理の更新時刻を更新し、手動編集とは区別する
  await db.from("lotteries").update({ multi_mode: row.multi_mode === "single" ? "all" : row.multi_mode, cautions: next as unknown as Json, cautions_updated_at: nowIso }).eq("id", lotteryId).eq("updated_at", row.updated_at);
  return { added: fresh.length };
}
