"use server";

import { canAutoGroup, isLotteryGroupingEnabled } from "@/lib/agent/lottery-grouping/flags";
import { createGroupingFetcher, createGroupingLlm } from "@/lib/server/agent/lottery-grouping-engine";
import { scanLotteryGrouping, type ScanSummary } from "@/lib/server/agent/lottery-grouping-service";
import { currentHouseholdId, type Db } from "@/lib/server/lottery-service";
import { createClient } from "@/lib/supabase/server";

/**
 * 抽選グループ判定の検証画面の操作（Stage 8F。開発用）。**開発環境（TOREMANE_ENV=local）でのみ動く**（本番では拒否され、DBにも触れない）。
 * 権限: 抽選・グループの読み取りと、専用の表（lottery_group_proposals）への提案の保存、検証層が「自動」と判定した提案の実行だけ。
 * 店舗ごとの抽選・応募・当選・購入・店舗マスターは更新しない。既定はモック（実APIは使わない。実APIは real-gate の条件と GROUPING_REAL_CONFIRM=yes が必要）。
 */
type R<T = object> = ({ ok: true } & T) | { ok: false; error: string };
const DEV_ONLY = "この操作は開発環境でのみ使えます";

async function ctx(): Promise<{ db: Db; householdId: string; actor: string | null } | null> {
  try {
    const db = (await createClient()) as unknown as Db;
    const { data } = await db.auth.getUser();
    if (!data.user) return null;
    const householdId = await currentHouseholdId(db);
    if (!householdId) return null;
    const { data: p } = await db.from("profiles").select("id").eq("household_id", householdId).order("sort_order").limit(1);
    return { db, householdId, actor: (p?.[0]?.id as string | undefined) ?? null };
  } catch {
    return null;
  }
}

export interface LogRow { id: string; status: string; tier: string; kind: string; confidence: number; rationale: string; engine: string; createdAt: string; count: number }

/** 最近の判定の記録（自動でまとめたもの・候補・単独・保留・却下） */
export async function listGroupingLogAction(): Promise<R<{ rows: LogRow[] }>> {
  if (!isLotteryGroupingEnabled()) return { ok: false, error: DEV_ONLY };
  const c = await ctx();
  if (!c) return { ok: false, error: "ログインが必要です" };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- 新しい表は生成型に無い
  const { data, error } = await (c.db as any).from("lottery_group_proposals").select("id,status,tier,kind,confidence,rationale,engine,created_at,lottery_ids").order("created_at", { ascending: false }).limit(30);
  if (error) return { ok: false, error: "判定の記録を読み込めませんでした（マイグレーション099が未適用の可能性があります）" };
  return { ok: true, rows: (data as { id: string; status: string; tier: string; kind: string; confidence: number; rationale: string; engine: string; created_at: string; lottery_ids: string[] }[]).map((r) => ({ id: r.id, status: r.status, tier: r.tier, kind: r.kind, confidence: r.confidence, rationale: r.rationale.split(" / ")[0].slice(0, 120), engine: r.engine, createdAt: r.created_at, count: r.lottery_ids.length })) };
}

/** グループに入っていない抽選を判定する（AIの実行回数・判定件数に上限）。モックAIが既定 */
export async function scanGroupingAction(): Promise<R<{ summary: ScanSummary; engine: string; real: boolean; note: string }>> {
  if (!isLotteryGroupingEnabled()) return { ok: false, error: DEV_ONLY };
  const c = await ctx();
  if (!c) return { ok: false, error: "ログインが必要です" };
  const eng = createGroupingLlm(process.env);
  const summary = await scanLotteryGrouping(c.db, c.householdId, { llm: eng.llm, allowAuto: canAutoGroup(), asService: false, actor: c.actor, followUps: 1, fetcher: await createGroupingFetcher(process.env), maxAiRuns: 30, maxEvaluations: 100 });
  return { ok: true, summary, engine: eng.llm.name, real: eng.real, note: eng.note };
}
