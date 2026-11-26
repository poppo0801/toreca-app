"use server";

import { createClient as createAdminClient } from "@supabase/supabase-js";
import { revalidatePath } from "next/cache";
import { currentHouseholdId, type Db } from "@/lib/server/lottery-service";
import { proposalPreviewEnabled, proposalSurfaceEnabled } from "@/lib/server/proposals/flag";
import { generateForPendingCandidates } from "@/lib/server/proposals/generate";
import { recordMissed, recordReview, recordTruth } from "@/lib/server/proposals/review";
import { createClient } from "@/lib/supabase/server";

/**
 * 新AIの登録案プレビュー（Stage 10Z・開発専用）の操作。**ローカル開発環境かつ PROPOSAL_PREVIEW=on のときだけ動く**（本番・未設定では常に拒否）。
 *  - generate: 確認待ちの候補について、費用ゼロのモック（実AIではない）で登録案を作る。登録案テーブルにだけ書く。
 *  - review: 登録案への人のレビュー（保留／修正して承認／却下）を追記する。**承認は抽選の登録ではない**（lotteries・応募・購入・通知には書かない）。
 */
type R<T = object> = ({ ok: true } & T) | { ok: false; error: string };

async function ctx(): Promise<{ db: Db; householdId: string } | null> {
  try {
    const db = (await createClient()) as unknown as Db;
    const { data } = await db.auth.getUser();
    if (!data.user) return null;
    const householdId = await currentHouseholdId(db);
    return householdId ? { db, householdId } : null;
  } catch {
    return null;
  }
}

export async function generateProposalsAction(): Promise<R<{ candidates: number; inserted: number; unchanged: number; superseded: number; skipped: number }>> {
  if (!proposalPreviewEnabled()) return { ok: false, error: "この機能は有効になっていません" };
  const c = await ctx();
  if (!c) return { ok: false, error: "ログインが必要です" };
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return { ok: false, error: "サーバーの設定がありません" };
  const admin = createAdminClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } }) as unknown as Db; // 登録案の書き込みはサービス権限のみ（RLS）。世帯はログイン中の利用者のもの
  const r = await generateForPendingCandidates({ db: admin, householdId: c.householdId });
  revalidatePath("/lotteries/candidates");
  return { ok: true, ...r };
}

export async function reviewProposalAction(input: { proposalId: string; decision: string; edits?: Record<string, string>; note?: string }): Promise<R> {
  if (!proposalSurfaceEnabled()) return { ok: false, error: "この機能は有効になっていません" };
  const c = await ctx();
  if (!c) return { ok: false, error: "ログインが必要です" };
  const r = await recordReview({ db: c.db, householdId: c.householdId, proposalId: String(input.proposalId), decision: String(input.decision), edits: input.edits, note: input.note });
  if (!r.ok) return { ok: false, error: r.reason === "not_current" ? "再評価で新しい版になりました。画面を更新してください" : r.reason === "invalid" ? "入力が正しくありません" : "保存できませんでした" };
  revalidatePath("/lotteries/candidates");
  return { ok: true };
}

/** 登録案の正解の記録（正しい／正解を修正／後で確認）。抽選の登録・削除・通知はしない（記録だけ） */
export async function truthProposalAction(input: { proposalId: string; verdict: string; truthDecision?: string; opportunity?: string; userFit?: string; edits?: Record<string, string>; unknownFields?: string[]; note?: string }): Promise<R> {
  if (!proposalSurfaceEnabled()) return { ok: false, error: "この機能は有効になっていません" };
  const c = await ctx();
  if (!c) return { ok: false, error: "ログインが必要です" };
  const r = await recordTruth({ db: c.db, householdId: c.householdId, proposalId: String(input.proposalId), verdict: String(input.verdict), ...(input.truthDecision ? { truthDecision: String(input.truthDecision) } : {}), ...(input.opportunity ? { opportunity: String(input.opportunity) } : {}), ...(input.userFit ? { userFit: String(input.userFit) } : {}), edits: input.edits, unknownFields: input.unknownFields, note: input.note });
  if (!r.ok) return { ok: false, error: r.reason === "not_current" ? "再評価で新しい版になりました。画面を更新してください" : r.reason === "invalid" ? "入力が正しくありません（修正する項目を選んでください）" : "保存できませんでした" };
  revalidatePath("/lotteries/candidates");
  return { ok: true };
}

/** 登録案に無い応募機会（取りこぼし）の記録。抽選は登録しない */
export async function missedOpportunityAction(input: { candidateId: string; note: string }): Promise<R> {
  if (!proposalSurfaceEnabled()) return { ok: false, error: "この機能は有効になっていません" };
  const c = await ctx();
  if (!c) return { ok: false, error: "ログインが必要です" };
  const r = await recordMissed({ db: c.db, householdId: c.householdId, candidateId: String(input.candidateId), note: String(input.note ?? "") });
  if (!r.ok) return { ok: false, error: r.reason === "invalid" ? "内容を入力してください" : "保存できませんでした" };
  revalidatePath("/lotteries/candidates");
  return { ok: true };
}
