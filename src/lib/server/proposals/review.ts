/**
 * 登録案への人のレビュー（保留／修正して承認／却下）の記録（Stage 10Z）。**承認は「新方式の登録案に対するレビュー記録」で、抽選の登録ではない**。
 * lotteries・applications・購入・通知には一切書かない。追記専用（更新・削除は権限もトリガもない）。AIの値は書き換えず、人の修正は edits に別に持つ。
 * 利用者のセッションのクライアント（RLS: 世帯の構成員・本人名義）で呼ぶ。
 */
import type { Db } from "@/lib/server/lottery-service";
import { proposalPreviewEnabled } from "./flag";
import { recordHumanExperience } from "./experience-store";

export const REVIEW_DECISIONS = ["hold", "approve_with_edits", "reject"] as const;
export type ReviewDecision = (typeof REVIEW_DECISIONS)[number];

export type ReviewResult = { ok: true } | { ok: false; reason: "disabled" | "invalid" | "not_current" | "failed" };

const EDIT_FIELDS = /^[\p{L}\p{N}_ ]{1,40}$/u;

export async function recordReview(a: { db: Db; householdId: string; proposalId: string; decision: string; edits?: Record<string, unknown>; note?: string; env?: Record<string, string | undefined> }): Promise<ReviewResult> {
  if (!proposalPreviewEnabled(a.env ?? process.env)) return { ok: false, reason: "disabled" };
  if (!(REVIEW_DECISIONS as readonly string[]).includes(a.decision)) return { ok: false, reason: "invalid" };
  const edits: Record<string, string> = {};
  for (const [k, v] of Object.entries(a.edits ?? {}).slice(0, 12)) {
    if (!EDIT_FIELDS.test(k) || typeof v !== "string" || v.length > 200) return { ok: false, reason: "invalid" };
    edits[k] = v.trim();
  }
  if (a.decision === "approve_with_edits" && a.edits === undefined) return { ok: false, reason: "invalid" };
  const note = String(a.note ?? "").slice(0, 300);
  const db = a.db as unknown as { from: (n: string) => any }; // eslint-disable-line @typescript-eslint/no-explicit-any
  const cur = (await db.from("registration_proposals").select("id,proposal_key,superseded_at").eq("id", a.proposalId).eq("household_id", a.householdId).maybeSingle()) as { data: { id: string; proposal_key: string; superseded_at: string | null } | null };
  if (!cur.data) return { ok: false, reason: "invalid" };
  if (cur.data.superseded_at) return { ok: false, reason: "not_current" }; // 古い版にはレビューしない（現行の版を見て判断する）
  const ins = (await db.from("registration_proposal_reviews").insert({ household_id: a.householdId, proposal_key: cur.data.proposal_key, proposal_id: cur.data.id, decision: a.decision, edits, note })) as { error: unknown };
  if (ins.error) return { ok: false, reason: "failed" };
  // 人の確認（修正あり承認）は、検証済み（human）の調査経験として追記する（次回以降の「最初に見せる位置」の根拠）。失敗してもレビューの記録は成功のまま
  if (a.decision === "approve_with_edits") await recordHumanExperience({ db: a.db, householdId: a.householdId, proposalId: cur.data.id, edits, at: new Date().toISOString() }).catch(() => undefined);
  return { ok: true };
}
