"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { EXCLUSION_REASONS, EXCLUSION_LABEL, canExcludeSource, domainExcludable, feedbackTarget, type ExclusionReasonCode } from "@/lib/collector/triage";
import { createClient } from "@/lib/supabase/server";
import { archiveLottery, currentHouseholdId, type Db } from "@/lib/server/lottery-service";

export type ActionResult = { ok: true } | { ok: false; error: string };

async function ctx(): Promise<{ db: Db; householdId: string; userId: string } | null> {
  const db = (await createClient()) as unknown as Db;
  const { data: auth } = await db.auth.getUser();
  if (!auth.user) return null;
  const householdId = await currentHouseholdId(db);
  return householdId ? { db, householdId, userId: auth.user.id } : null;
}

const reasonCode = z.enum(EXCLUSION_REASONS.map((r) => r.code) as [ExclusionReasonCode, ...ExclusionReasonCode[]]);
const id = z.uuid();
const note = z.string().trim().max(500).default("");
const actorSchema = z.uuid().nullable();

// ------------------------------------------------------------ 要手動確認（収集候補）
/** 対応完了（候補の中身は変えない。ポップアップを閉じただけでは対応済みにならない） */
export async function manualDoneAction(candidateId: string): Promise<ActionResult> {
  if (!id.safeParse(candidateId).success) return { ok: false, error: "不正な指定です" };
  const c = await ctx();
  if (!c) return { ok: false, error: "ログインが必要です" };
  const { error } = await c.db.from("collection_candidates").update({ manual_state: "resolved", manual_resolved_at: new Date().toISOString(), manual_resolved_by: c.userId }).eq("id", candidateId).eq("triage", "manual");
  revalidatePath("/settings/collection");
  return error ? { ok: false, error: "更新できませんでした" } : { ok: true };
}

/** 対象外として除外（候補は物理削除せず、理由を残す。除外一覧から戻せる） */
export async function manualDismissAction(candidateId: string, code: ExclusionReasonCode, text: string): Promise<ActionResult> {
  const p = z.object({ id, code: reasonCode, text: note }).safeParse({ id: candidateId, code, text });
  if (!p.success) return { ok: false, error: "不正な指定です" };
  const c = await ctx();
  if (!c) return { ok: false, error: "ログインが必要です" };
  const nowIso = new Date().toISOString();
  const { error } = await c.db
    .from("collection_candidates")
    .update({ status: "excluded", job_state: "skipped", manual_state: "dismissed", manual_resolved_at: nowIso, manual_resolved_by: c.userId, reasons: [`利用者が対象外として除外（${EXCLUSION_LABEL[p.data.code]}）${p.data.text ? `: ${p.data.text}` : ""}`.slice(0, 300)], resolved_at: nowIso, completed_at: nowIso })
    .eq("id", candidateId);
  revalidatePath("/settings/collection");
  return error ? { ok: false, error: "更新できませんでした" } : { ok: true };
}

/** 再調査: 自動再調査（保留）へ戻し、次回のワーカーですぐ確認する */
export async function manualRecheckAction(candidateId: string): Promise<ActionResult> {
  if (!id.safeParse(candidateId).success) return { ok: false, error: "不正な指定です" };
  const c = await ctx();
  if (!c) return { ok: false, error: "ログインが必要です" };
  const cur = (await c.db.from("collection_candidates").select("job_state,draft").eq("id", candidateId).maybeSingle()).data;
  if (!cur) return { ok: false, error: "候補が見つかりません" };
  const failed = cur.job_state === "failed";
  const patch = failed
    ? { job_state: "retry", status: "pending", attempts: 0, next_run_at: new Date().toISOString(), lease_until: null, locked_by: null, completed_at: null }
    : { job_state: "review", status: "pending" };
  const { error } = await c.db.from("collection_candidates").update({ ...patch, triage: "auto_retry", triage_reason: "利用者の操作で再調査します", hold_count: 0, manual_state: null, next_run_at: new Date().toISOString() } as never).eq("id", candidateId);
  revalidatePath("/settings/collection");
  return error ? { ok: false, error: "更新できませんでした" } : { ok: true };
}

// ------------------------------------------------------------ 登録済みの自動収集の抽選
/** 自動収集した抽選を、利用者が確認した履歴を残す（内容の正確性を保証するものではない） */
export async function confirmLotteryAction(lotteryId: string, actor: string | null): Promise<ActionResult> {
  const p = z.object({ lotteryId: id, actor: actorSchema }).safeParse({ lotteryId, actor });
  if (!p.success) return { ok: false, error: "不正な指定です" };
  const c = await ctx();
  if (!c) return { ok: false, error: "ログインが必要です" };
  const { data, error } = await c.db.from("lotteries").update({ registration_path: "auto_confirmed", confirmed_at: new Date().toISOString(), confirmed_by_profile_id: p.data.actor }).eq("id", lotteryId).eq("source_kind", "auto").select("id").maybeSingle();
  revalidatePath("/lotteries");
  return error || !data ? { ok: false, error: "更新できませんでした" } : { ok: true };
}

/**
 * 自動収集した抽選を除外する（アーカイブ。理由を記録）。応募・当落・購入の履歴がある抽選は、履歴を保持するため除外できない。
 */
export async function excludeLotteryAction(lotteryId: string, code: ExclusionReasonCode, text: string, actor: string | null): Promise<ActionResult> {
  const p = z.object({ lotteryId: id, code: reasonCode, text: note, actor: actorSchema }).safeParse({ lotteryId, code, text, actor });
  if (!p.success) return { ok: false, error: "不正な指定です" };
  const c = await ctx();
  if (!c) return { ok: false, error: "ログインが必要です" };
  const apps = await c.db.from("applications").select("id", { count: "exact", head: true }).eq("lottery_id", lotteryId);
  if ((apps.count ?? 0) > 0) return { ok: false, error: "応募・当落の履歴があるため除外できません（履歴を保持します）" };
  const mgmt = await c.db.from("lottery_management").select("lottery_id", { count: "exact", head: true }).eq("lottery_id", lotteryId);
  if ((mgmt.count ?? 0) > 0) return { ok: false, error: "要チェックのため除外できません。先に要チェックを外してください" };
  const { error: e1 } = await c.db.from("lotteries").update({ exclusion_reason_code: p.data.code, exclusion_reason_note: p.data.text }).eq("id", lotteryId);
  if (e1) return { ok: false, error: "更新できませんでした" };
  const r = await archiveLottery(c.db, lotteryId, p.data.actor);
  revalidatePath("/lotteries");
  void feedbackTarget(p.data.code); // 反映先は明示的なルール・フィルタ・AIフィードバックのみ（自動学習・自動ブラックリストはしない）
  return r.ok ? { ok: true } : { ok: false, error: "除外できませんでした" };
}

// ------------------------------------------------------------ 収集元の除外ルール
const scopeSchema = z.enum(["store", "chain", "x_account", "domain", "source_post"]);

/** 今後この収集元を除外する（世帯共通のルール）。範囲は呼び出し側が明示して指定する。X全体・まとめサイト全体・共通の応募サービス全体は指定できない */
export async function excludeSourceAction(input: { scope: z.infer<typeof scopeSchema>; key: string; label: string; code: ExclusionReasonCode; text: string; actor: string | null }): Promise<ActionResult> {
  const p = z.object({ scope: scopeSchema, key: z.string().trim().min(1).max(300), label: z.string().trim().max(120), code: reasonCode, text: note, actor: actorSchema }).safeParse(input);
  if (!p.success) return { ok: false, error: "不正な指定です" };
  const v = p.data;
  if (!canExcludeSource(v.code)) return { ok: false, error: "この理由は収集元全体の除外には使えません（応募資格・条件・地域・重複は個別の判断です）" };
  if (v.scope === "domain" && !domainExcludable(v.key)) return { ok: false, error: "X・まとめサイト・短縮URL・共通の応募サービス全体は除外できません" };
  if ((v.scope === "store" || v.scope === "chain") && !id.safeParse(v.key).success) return { ok: false, error: "不正な指定です" };
  if (v.scope === "x_account" && !/^[A-Za-z0-9_]{1,15}$/.test(v.key)) return { ok: false, error: "Xアカウント名が不正です" };
  const c = await ctx();
  if (!c) return { ok: false, error: "ログインが必要です" };
  const row = { household_id: c.householdId, scope: v.scope, key: v.key, label: v.label, reason_code: v.code, reason_note: v.text, store_id: v.scope === "store" ? v.key : null, chain_id: v.scope === "chain" ? v.key : null, created_by_profile_id: v.actor };
  const { error } = await c.db.from("collection_exclusions").insert(row as never);
  if (error && error.code !== "23505") return { ok: false, error: "保存できませんでした" };
  revalidatePath("/settings/collection");
  return { ok: true };
}

/** 除外ルールの解除（履歴として残す）／理由の編集 */
export async function releaseExclusionAction(ruleId: string, actor: string | null): Promise<ActionResult> {
  const p = z.object({ ruleId: id, actor: actorSchema }).safeParse({ ruleId, actor });
  if (!p.success) return { ok: false, error: "不正な指定です" };
  const c = await ctx();
  if (!c) return { ok: false, error: "ログインが必要です" };
  const { error } = await c.db.from("collection_exclusions").update({ active: false, released_at: new Date().toISOString(), released_by_profile_id: p.data.actor }).eq("id", ruleId);
  revalidatePath("/settings/collection");
  return error ? { ok: false, error: "解除できませんでした" } : { ok: true };
}

export async function updateExclusionAction(ruleId: string, code: ExclusionReasonCode, text: string): Promise<ActionResult> {
  const p = z.object({ ruleId: id, code: reasonCode, text: note }).safeParse({ ruleId, code, text });
  if (!p.success) return { ok: false, error: "不正な指定です" };
  if (!canExcludeSource(p.data.code)) return { ok: false, error: "この理由は収集元全体の除外には使えません" };
  const c = await ctx();
  if (!c) return { ok: false, error: "ログインが必要です" };
  const { error } = await c.db.from("collection_exclusions").update({ reason_code: p.data.code, reason_note: p.data.text }).eq("id", ruleId).eq("active", true);
  revalidatePath("/settings/collection");
  return error ? { ok: false, error: "更新できませんでした" } : { ok: true };
}
