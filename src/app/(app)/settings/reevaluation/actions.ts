"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import type { ReevalAction } from "@/lib/master-identity/reeval-plan";
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
  counts: Record<string, { proposed: number; applied: number; skipped: number; failed: number; reverted: number }>;
  proposals: { id: string; action: string; targetType: string; targetId: string; risk: string; reason: string; relatedId: string | null; status: string; error: string | null }[];
}

export async function loadReevalAction(): Promise<Result<{ batch: BatchView | null }>> {
  const c = await ctx();
  if (!c) return { ok: false, error: "ログインが必要です" };
  const db = c.db as Any;
  const { data: b } = await db.from("master_reeval_batches").select("id,status,created_at,summary").eq("household_id", c.householdId).neq("status", "aborted").order("created_at", { ascending: false }).limit(1).maybeSingle();
  if (!b) return { ok: true, batch: null };
  const { data: items } = await db.from("master_reeval_items").select("id,action,target_type,target_id,risk,proposal,status,error,seq").eq("batch_id", b.id).order("seq").limit(2000);
  const counts: BatchView["counts"] = {};
  for (const i of items ?? []) {
    const k = (counts[i.action] ??= { proposed: 0, applied: 0, skipped: 0, failed: 0, reverted: 0 });
    k[i.status as keyof typeof k]++;
  }
  const proposals = (items ?? [])
    .filter((i: Any) => i.action === "merge_master" || i.action === "review")
    .slice(0, 60)
    .map((i: Any) => ({ id: i.id, action: i.action, targetType: i.target_type, targetId: i.target_id, risk: i.risk, reason: String(i.proposal?.reason ?? ""), relatedId: (i.proposal?.relatedId as string | undefined) ?? null, status: i.status, error: i.error }));
  return { ok: true, batch: { id: b.id, status: b.status, createdAt: b.created_at, summary: b.summary, counts, proposals } };
}

export async function createReevalPlanAction(actor: string | null): Promise<Result<{ items: number }>> {
  const c = await ctx(actor);
  if (!c) return { ok: false, error: "ログインが必要です" };
  const r = await createReevalPlan(c.db, c.householdId, c.actor);
  revalidatePath("/settings/reevaluation");
  return r.ok ? { ok: true, items: r.items } : r;
}

const applySchema = z.object({ batchId: z.uuid(), action: z.enum(["archive_duplicate", "archive_expired", "archive_region", "dismiss_candidate"]), limit: z.number().int().min(1).max(100) });
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
