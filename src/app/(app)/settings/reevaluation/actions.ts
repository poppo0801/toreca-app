"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import type { ReevalAction } from "@/lib/master-identity/reeval-plan";
import { estimateReevalAi, isReevalAiEnabled, listLearnedAliases, revokeLearnedAlias, runReevalAi, type ReevalAiRunResult, type ReevalEstimate } from "@/lib/server/master-identity/reeval-ai-hook";
import { applyReevalBatch, createReevalPlan, revertReevalBatch } from "@/lib/server/master-identity/reeval-service";
import { currentHouseholdId, type Db } from "@/lib/server/lottery-service";
import { createClient } from "@/lib/supabase/server";

/** 一括再評価の操作（Stage 9H-3S）。計画の作成・区分ごとの適用・元に戻す。利用者のセッションで行い、世帯のデータだけを対象にする */
export type Result<T = Record<string, never>> = ({ ok: true } & T) | { ok: false; error: string };

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- 新しい表は生成型に含まれない
type Any = any;

const actorSchema = z.uuid().nullable();

async function ctx(actor: string | null = null): Promise<{ db: Db; householdId: string; actor: string | null } | null> {
  if (!actorSchema.safeParse(actor).success) return null;
  const db = (await createClient()) as unknown as Db;
  const { data: auth } = await db.auth.getUser();
  if (!auth.user) return null;
  const householdId = await currentHouseholdId(db);
  if (!householdId) return null;
  // 操作したプロフィールは、世帯のプロフィールのときだけ使う（他の世帯のIDは受け付けない）
  if (actor) {
    const { data: p } = await db.from("profiles").select("id").eq("id", actor).eq("household_id", householdId).maybeSingle();
    if (!p) return null;
  }
  return { db, householdId, actor };
}

export interface BatchView {
  id: string;
  status: string;
  createdAt: string;
  summary: Record<string, unknown>;
  counts: Record<string, { proposed: number; applied: number; skipped: number; failed: number; reverted: number; aiConfirmed: number; aiPending: number; aiRefuted: number; aiUnclear: number }>;
  /** AIの調査結果（変更前後・根拠・費用）。調べたものだけ */
  aiResults: { id: string; action: string; aiState: string; verdict: string; status: string; reason: string; detail: string; costJpy: number }[];
  /** AI再調査の費用（バッチの累計。通常収集の予算とは別枠） */
  ai: { enabled: boolean; usedJpy: number; capJpy: number | null; investigated: number; total: number };
  proposals: { id: string; action: string; targetType: string; targetId: string; risk: string; reason: string; relatedId: string | null; status: string; error: string | null }[];
}

export async function loadReevalAction(): Promise<Result<{ batch: BatchView | null }>> {
  const c = await ctx();
  if (!c) return { ok: false, error: "ログインが必要です" };
  const db = c.db as Any;
  const { data: b } = await db.from("master_reeval_batches").select("id,status,created_at,summary,params").eq("household_id", c.householdId).neq("status", "aborted").order("created_at", { ascending: false }).limit(1).maybeSingle();
  if (!b) return { ok: true, batch: null };
  const { data: items } = await db.from("master_reeval_items").select("id,action,target_type,target_id,risk,proposal,status,error,seq,ai_state,ai_result,ai_cost_jpy").eq("batch_id", b.id).order("seq").limit(2000);
  const counts: BatchView["counts"] = {};
  for (const i of items ?? []) {
    const k = (counts[i.action] ??= { proposed: 0, applied: 0, skipped: 0, failed: 0, reverted: 0, aiConfirmed: 0, aiPending: 0, aiRefuted: 0, aiUnclear: 0 });
    k[i.status as "proposed" | "applied" | "skipped" | "failed" | "reverted"]++;
    // AIの確認の状態（固定ロジックの暫定判定は、AIが実際の情報源を調べて確認するまで適用しない）
    if (i.status === "proposed") {
      const v = (i.ai_result as { verdict?: string } | null)?.verdict;
      // マスターの統合: 確認済みの別名・表記揺れの一致（確信度 high）は、AIの調査なしでも適用できる（統合元が仮登録・参照が限定的なものだけ。適用時に再確認）
      if (i.action === "merge_master" && (i.proposal as { evidence?: { confidence?: string } } | null)?.evidence?.confidence === "high") k.aiConfirmed++;
      else if (i.ai_state === "not_investigated") k.aiPending++;
      else if (i.ai_state === "investigated" && v === "confirm") k.aiConfirmed++;
      else if (v === "refute") k.aiRefuted++;
      else k.aiUnclear++;
    }
  }
  const detailOf = (i: Any): string => {
    const r = (i.ai_result ?? {}) as Any;
    const p = (i.proposal ?? {}) as Any;
    const alt = r.alternatives as { blocked?: { host: string }[]; reached?: { host: string; tier: string; status: string }[]; recovered?: number; unresolved?: boolean } | null | undefined;
    const altText = alt?.blocked?.length ? `／取得できなかった: ${alt.blocked.map((b) => b.host).join("・")} → 代替の情報源 ${alt.reached?.length ?? 0}件に到達（根拠として採用 ${alt.recovered ?? 0}件）${alt.unresolved ? "。確認できず不明のまま" : ""}` : "";
    if (i.action === "fill_fields") return (p.changes ?? []).map((c: Any) => `${c.field}: ${c.from ?? "空欄"} → ${c.to}`).join(" / ");
    if (i.action === "consolidate_lotteries") return `${r.form ?? "不明"}（${String(r.formBasis ?? "").slice(0, 80)}）／対象店舗: ${(p.evidence?.stores ?? []).slice(0, 6).join("・")}${r.formQuote ? `／根拠: 「${String(r.formQuote).slice(0, 80)}」` : ""}${altText}`;
    if (r.relation && r.observed) return `「${r.observed}」⇔「${r.candidate}」: ${r.relation}（${String(r.rationale ?? "").slice(0, 80)}${r.learned?.persisted === "alias" ? "／別名を学習" : r.learned?.persisted === "candidate" ? "／関連候補として保持" : ""}）`;
    if (r.address || r.prefecture) return `所在地: ${r.prefecture ?? "不明"}（${String(r.basis ?? "").slice(0, 80)}）`;
    return `取得できた情報源 ${r.fetched ?? 0}件${r.deadline ? `／締切: ${r.deadline}` : ""}${Array.isArray(r.unknown) && r.unknown.length ? `／確認できず: ${r.unknown.join("・")}` : ""}${altText}`;
  };
  const aiResults = (items ?? [])
    .filter((i: Any) => i.ai_state !== "not_investigated")
    .slice(0, 80)
    .map((i: Any) => ({ id: i.id, action: i.action, aiState: i.ai_state, verdict: String(i.ai_result?.verdict ?? ""), status: i.status, reason: String(i.proposal?.reason ?? "").slice(0, 140), detail: detailOf(i).slice(0, 300), costJpy: Number(i.ai_cost_jpy ?? 0) }));
  const params = (b.params ?? {}) as { costJpy?: number; costCapJpy?: number };
  const ai = { enabled: isReevalAiEnabled(), usedJpy: Number(params.costJpy ?? 0), capJpy: params.costCapJpy ?? null, investigated: (items ?? []).filter((i: Any) => i.ai_state !== "not_investigated").length, total: (items ?? []).length };
  const proposals = (items ?? [])
    .filter((i: Any) => i.action === "merge_master" || i.action === "review")
    .slice(0, 60)
    .map((i: Any) => ({ id: i.id, action: i.action, targetType: i.target_type, targetId: i.target_id, risk: i.risk, reason: String(i.proposal?.reason ?? ""), relatedId: (i.proposal?.relatedId as string | undefined) ?? null, status: i.status, error: i.error }));
  return { ok: true, batch: { id: b.id, status: b.status, createdAt: b.created_at, summary: b.summary, counts, proposals, aiResults, ai } };
}

export async function createReevalPlanAction(actor: string | null): Promise<Result<{ items: number }>> {
  const c = await ctx(actor);
  if (!c) return { ok: false, error: "ログインが必要です" };
  const r = await createReevalPlan(c.db, c.householdId, c.actor);
  revalidatePath("/settings/reevaluation");
  return r.ok ? { ok: true, items: r.items } : r;
}

const applySchema = z.object({ batchId: z.uuid(), action: z.enum(["archive_duplicate", "archive_expired", "archive_region", "dismiss_candidate", "fill_fields", "consolidate_lotteries", "merge_master"]), limit: z.number().int().min(1).max(100) });
export async function applyReevalAction(batchId: string, action: ReevalAction, limit: number, actor: string | null): Promise<Result<{ applied: number; failed: number; remaining: number }>> {
  const p = applySchema.safeParse({ batchId, action, limit });
  if (!p.success) return { ok: false, error: "不正な指定です" };
  const c = await ctx(actor);
  if (!c) return { ok: false, error: "ログインが必要です" };
  const r = await applyReevalBatch(c.db, c.householdId, c.actor, p.data.batchId, { actions: [p.data.action], limit: p.data.limit });
  revalidatePath("/settings/reevaluation");
  return r;
}

export async function revertReevalAction(batchId: string, actor: string | null): Promise<Result<{ reverted: number; failed: number }>> {
  if (!z.uuid().safeParse(batchId).success) return { ok: false, error: "不正な指定です" };
  const c = await ctx(actor);
  if (!c) return { ok: false, error: "ログインが必要です" };
  const r = await revertReevalBatch(c.db, c.actor, batchId);
  revalidatePath("/settings/reevaluation");
  return r;
}

// ---- AIによる再調査（Stage 9H-3S-3）。費用の見積もり→上限を指定して実行（区切りながら再開）→結果の確認→適用・元に戻す
export async function estimateReevalAiAction(batchId: string): Promise<Result<{ estimate: ReevalEstimate; enabled: boolean }>> {
  if (!z.uuid().safeParse(batchId).success) return { ok: false, error: "不正な指定です" };
  const c = await ctx();
  if (!c) return { ok: false, error: "ログインが必要です" };
  const { data: own } = await (c.db as Any).from("master_reeval_batches").select("id").eq("id", batchId).eq("household_id", c.householdId).maybeSingle();
  if (!own) return { ok: false, error: "計画が見つかりません" };
  const estimate = await estimateReevalAi(c.db, batchId);
  return estimate ? { ok: true, estimate, enabled: isReevalAiEnabled() } : { ok: false, error: "計画が見つかりません" };
}

const runSchema = z.object({ batchId: z.uuid(), totalCapJpy: z.number().min(6).max(100), limit: z.number().int().min(1).max(30) });
export async function runReevalAiAction(batchId: string, totalCapJpy: number, limit: number, actor: string | null): Promise<Result<{ run: Extract<ReevalAiRunResult, { ok: true }> }>> {
  const p = runSchema.safeParse({ batchId, totalCapJpy, limit });
  if (!p.success) return { ok: false, error: "不正な指定です" };
  const c = await ctx(actor);
  if (!c) return { ok: false, error: "ログインが必要です" };
  const r = await runReevalAi(c.db, c.householdId, c.actor, p.data.batchId, { totalCapJpy: p.data.totalCapJpy, limit: p.data.limit });
  revalidatePath("/settings/reevaluation");
  return r.ok ? { ok: true, run: r } : { ok: false, error: r.error };
}

export async function listLearnedAliasesAction(): Promise<Result<{ aliases: Awaited<ReturnType<typeof listLearnedAliases>> }>> {
  const c = await ctx();
  if (!c) return { ok: false, error: "ログインが必要です" };
  return { ok: true, aliases: await listLearnedAliases(c.db, c.householdId) };
}

export async function revokeAliasAction(kind: "chain" | "product", aliasId: string): Promise<Result<{ revoked: true }>> {
  if (!z.enum(["chain", "product"]).safeParse(kind).success || !z.uuid().safeParse(aliasId).success) return { ok: false, error: "不正な指定です" };
  const c = await ctx();
  if (!c) return { ok: false, error: "ログインが必要です" };
  const r = await revokeLearnedAlias(c.db, c.householdId, kind, aliasId);
  revalidatePath("/settings/reevaluation");
  return r.ok ? { ok: true, revoked: true as const } : r;
}
