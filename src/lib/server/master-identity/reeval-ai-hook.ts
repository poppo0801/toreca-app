import "server-only";
import type { Db } from "@/lib/server/lottery-service";

/**
 * 一括再評価のAI再調査を呼び出す口（Stage 9H-3S-3）。収集の呼び出し口（autonomous-hook.ts など）と同じ作り。
 *  - 開発環境（TOREMANE_ENV=local）、または本番で明示的に許可（REEVAL_AI=on）されたときだけ動く。それ以外は、AIの部品を読み込まず、何もしない（先頭の判定で即座に戻る）
 *  - AIの調査部品（lib/agent・lib/server/agent）は、判定を通ったあとに初めて動的に読み込む（本番で無効のときは読み込まれない）
 *  - 費用: 利用者が指定した上限（バッチの残り予算）の範囲だけ。通常の自律型収集の予算（日額100円・月額1,500円）とは別枠。上限・権限はAIが変更できない
 *  - 同時に2つ実行しない（実行中の印）。サーバーレスの時間制限の前に区切りのよい所で止まり、続きは次の実行で再開する
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- 新しい表は生成型に含まれない
const any = (db: Db) => db as any;

export const REEVAL_AI_DEFAULT_MAX_JPY = 100;
const RUN_LOCK_MS = 5 * 60_000;
/** 1回の実行の長さ（Vercelの上限300秒より前に止まる） */
export const REEVAL_AI_RUN_MS = 200_000;

export function isReevalAiEnabled(env: Record<string, string | undefined> = process.env): boolean {
  return env.TOREMANE_ENV === "local" || env.REEVAL_AI === "on";
}

export type ReevalAiRunResult =
  | { ok: true; units: number; investigated: number; insufficient: number; failed: number; confirmed: number; fillsCreated: number; learned: number; costJpy: number; totalCostJpy: number; capJpy: number; stopped: string | null }
  | { ok: false; error: string };

/** 費用の目安（1単位あたり。実AI・実Webの検証での実測 3〜8円に基づく概算）。実際の費用は上限を超えない */
export const UNIT_COST_JPY: Record<string, { min: number; max: number }> = { dates: { min: 3, max: 8 }, form: { min: 4, max: 10 }, region: { min: 4, max: 9 }, expired: { min: 3, max: 8 }, name: { min: 1, max: 4 }, candidate: { min: 3, max: 8 } };

export interface ReevalEstimate {
  pending: Record<keyof typeof UNIT_COST_JPY, number>;
  units: number;
  minJpy: number;
  maxJpy: number;
  usedJpy: number;
  capJpy: number | null;
}

/** AIの未調査の項目から、実行前の費用見積もりを出す（読み取りのみ。AIは呼ばない） */
export async function estimateReevalAi(db: Db, batchId: string): Promise<ReevalEstimate | null> {
  const a = any(db);
  const { data: b } = await a.from("master_reeval_batches").select("params").eq("id", batchId).maybeSingle();
  if (!b) return null;
  const { data } = await a.from("master_reeval_items").select("action,target_type,proposal,ai_state").eq("batch_id", batchId).eq("status", "proposed").eq("ai_state", "not_investigated").limit(5000);
  const pending = { dates: 0, form: 0, region: 0, expired: 0, name: 0, candidate: 0 } as ReevalEstimate["pending"];
  const stores = new Set<string>();
  for (const i of (data ?? []) as { action: string; target_type: string; proposal: { subKind?: string; evidence?: { stores?: string[] } } }[]) {
    const sub = i.proposal?.subKind;
    if (i.action === "review" && sub === "missing_dates") pending.dates++;
    else if (i.action === "consolidate_lotteries") pending.form++;
    else if (i.action === "archive_region") pending.region++;
    else if (i.action === "archive_expired") pending.expired++;
    else if (i.action === "review" && (sub === "master_candidate" || sub === "name_candidate")) pending.name++;
    else if (i.target_type === "candidate" && i.action === "dismiss_candidate" && (sub === "region" || sub === "expired")) pending.candidate++;
    void stores;
  }
  let min = 0;
  let max = 0;
  for (const k of Object.keys(pending) as (keyof typeof UNIT_COST_JPY)[]) {
    min += pending[k] * UNIT_COST_JPY[k].min;
    max += pending[k] * UNIT_COST_JPY[k].max;
  }
  const p = b.params as { costJpy?: number; costCapJpy?: number };
  return { pending, units: Object.values(pending).reduce((x, y) => x + y, 0), minJpy: Math.round(min), maxJpy: Math.round(max), usedJpy: Number(p.costJpy ?? 0), capJpy: p.costCapJpy ?? null };
}

/**
 * AI再調査を1回実行する。上限（totalCapJpy）は、このバッチの累計の上限（円）。残りが小さい（6円未満）ときは開始しない。
 * 2回目以降は、調査済みの項目を再調査せず、続きから再開する。
 */
export async function runReevalAi(db: Db, householdId: string, actor: string | null, batchId: string, o: { totalCapJpy: number; limit: number; now?: Date }): Promise<ReevalAiRunResult> {
  if (!isReevalAiEnabled()) return { ok: false, error: "一括再調査のAI実行は、この環境で有効になっていません" };
  const maxCap = Number(process.env.REEVAL_AI_MAX_JPY) > 0 ? Number(process.env.REEVAL_AI_MAX_JPY) : REEVAL_AI_DEFAULT_MAX_JPY;
  if (!(o.totalCapJpy >= 6) || o.totalCapJpy > maxCap) return { ok: false, error: `費用の上限が不正です（6〜${maxCap}円）` };
  const a = any(db);
  const { data: b } = await a.from("master_reeval_batches").select("id,params,status").eq("id", batchId).eq("household_id", householdId).maybeSingle();
  if (!b) return { ok: false, error: "計画が見つかりません" };
  if (b.status === "aborted") return { ok: false, error: "この計画は破棄されています" };
  const params = b.params as { costJpy?: number; aiRunningAt?: string };
  const now = o.now ?? new Date();
  if (params.aiRunningAt && now.getTime() - Date.parse(params.aiRunningAt) < RUN_LOCK_MS) return { ok: false, error: "別のAI再調査が実行中です。終わってからもう一度実行してください" };
  const used = Number(params.costJpy ?? 0);
  const remaining = o.totalCapJpy - used;
  if (remaining < 6) return { ok: false, error: `費用の上限に達しています（使用 ${used.toFixed(1)}円／上限 ${o.totalCapJpy}円）。上限を上げるか、ここで終了してください` };
  // 実行中の印（二重実行の防止）。終了時（成功・失敗とも）に外す
  await a.from("master_reeval_batches").update({ params: { ...params, aiRunningAt: now.toISOString() } }).eq("id", batchId);
  try {
    const svc = await import("@/lib/server/agent/reeval-ai-service");
    const run = await import("@/lib/server/agent/reeval-ai-run");
    const isLocal = process.env.TOREMANE_ENV === "local";
    const built = isLocal
      ? svc.realReevalDeps({ env: { ...process.env, AGENT_MODEL: process.env.AGENT_MODEL ?? "claude-haiku-5-5" }, capJpy: Math.min(remaining, 100), perCaseJpy: 12, ledgerDir: "backups/reeval-ledger" })
      : svc.prodReevalDeps({ env: process.env, capJpy: remaining, perCaseJpy: 12 });
    if (!built.ok) return { ok: false, error: built.reason };
    const report = await run.runAiReevaluation(db, householdId, actor, batchId, built.deps, { limit: Math.min(Math.max(o.limit, 1), 30), now, deadlineMs: Date.now() + REEVAL_AI_RUN_MS });
    return { ok: true, units: report.units, investigated: report.investigated, insufficient: report.insufficient, failed: report.failed, confirmed: report.confirmed, fillsCreated: report.fillsCreated, learned: report.learned.filter((x) => x.persisted === "alias").length, costJpy: report.costJpy, totalCostJpy: Math.round((used + report.costJpy) * 100) / 100, capJpy: o.totalCapJpy, stopped: report.stopped };
  } catch (e) {
    return { ok: false, error: (e instanceof Error ? e.message : "実行に失敗しました").slice(0, 200) };
  } finally {
    const { data: cur } = await a.from("master_reeval_batches").select("params").eq("id", batchId).maybeSingle();
    if (cur) {
      const { aiRunningAt: _drop, ...rest } = cur.params as Record<string, unknown>;
      void _drop;
      await a.from("master_reeval_batches").update({ params: { ...rest, costCapJpy: o.totalCapJpy } }).eq("id", batchId);
    }
  }
}

/** AIが学習した別名の一覧（AI推定のもの。取り消せる） */
export async function listLearnedAliases(db: Db, householdId: string): Promise<{ id: string; kind: "chain" | "product"; alias: string; master: string; at: string; reason: string }[]> {
  const a = any(db);
  const [c, p] = await Promise.all([
    a.from("chain_aliases").select("id,alias,created_at,evidence,chains(name)").eq("household_id", householdId).eq("source", "ai").eq("status", "inferred").order("created_at", { ascending: false }).limit(50),
    a.from("product_aliases").select("id,alias,created_at,evidence,products(official_name)").eq("household_id", householdId).eq("source", "ai").eq("status", "inferred").order("created_at", { ascending: false }).limit(50),
  ]);
  type R = { id: string; alias: string; created_at: string; evidence: { reason?: string } | null; chains?: { name: string } | null; products?: { official_name: string } | null };
  return [
    ...((c.data ?? []) as R[]).map((r) => ({ id: r.id, kind: "chain" as const, alias: r.alias, master: r.chains?.name ?? "", at: r.created_at, reason: String(r.evidence?.reason ?? "") })),
    ...((p.data ?? []) as R[]).map((r) => ({ id: r.id, kind: "product" as const, alias: r.alias, master: r.products?.official_name ?? "", at: r.created_at, reason: String(r.evidence?.reason ?? "") })),
  ].sort((x, y) => y.at.localeCompare(x.at));
}

/** AIが推定した別名の取り消し（誤学習の訂正）。人が確定した別名・正式名・取り込み由来の別名は対象外。取り消した名称は、関連候補として保持しない（同じ誤りを繰り返さないよう却下の候補にする） */
export async function revokeLearnedAlias(db: Db, householdId: string, kind: "chain" | "product", aliasId: string): Promise<{ ok: true } | { ok: false; error: string }> {
  const a = any(db);
  const table = kind === "chain" ? "chain_aliases" : "product_aliases";
  const col = kind === "chain" ? "chain_id" : "product_id";
  const { data: row } = await a.from(table).select(`id,alias,normalized_alias,${col}`).eq("id", aliasId).eq("household_id", householdId).eq("source", "ai").eq("status", "inferred").maybeSingle();
  if (!row) return { ok: false, error: "取り消せる別名が見つかりません（人が確定した別名は取り消せません）" };
  const { error } = await a.from(table).delete().eq("id", aliasId).eq("household_id", householdId).eq("source", "ai").eq("status", "inferred");
  if (error) return { ok: false, error: "取り消せませんでした" };
  // 同じ誤学習を繰り返さないよう、却下した関連候補として記録する（次回以降、同じ根拠だけでは別名にしない）
  const norm = String(row.normalized_alias).slice(0, 160);
  const { data: ex } = await a.from("master_alias_candidates").select("id").eq("household_id", householdId).eq("kind", kind).eq("normalized_name", norm).eq("candidate_master_id", row[col]).maybeSingle();
  if (ex) await a.from("master_alias_candidates").update({ status: "dismissed", relation: "conflict", evidence: { reason: "利用者がAIの別名学習を取り消した" } }).eq("id", ex.id);
  else await a.from("master_alias_candidates").insert({ household_id: householdId, kind, observed_name: String(row.alias).slice(0, 160), normalized_name: norm, candidate_master_id: row[col], relation: "conflict", evidence: { reason: "利用者がAIの別名学習を取り消した" }, status: "dismissed", source: "manual" });
  return { ok: true };
}
