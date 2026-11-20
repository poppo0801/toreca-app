/**
 * 案件（Case）と判断履歴の共通基盤（Stage 10D・サーバー側）。通常収集・手動操作のどちらからも**まだ呼ばれない**（10E以降で接続）。
 *  - 履歴保護: 自律的な変更・統合・削除は、必ず `guardAutonomousOp` を通す（DB関数 lottery_history_blockers ＋ 純関数の判定）。拒否は判断履歴に記録する。
 *  - 判断履歴: 追記のみ。文面は伏せ字・切り詰めのうえ保存（外部本文の指示は実行しない＝データとして保存するだけ）。AIへ渡すときの検索は `searchJudgments`（読み取りのみ）。
 *  - 抽選IDは変更しない。案件への関連づけ（lotteries.case_id）は非破壊。
 */
import type { Db } from "@/lib/server/lottery-service";
import { decideAutonomousOp, type AutonomousOp, type GuardDecision } from "@/lib/case-model/history-guard";
import { redact } from "@/lib/case-model/redact";

// 新しい表は型生成の対象外のため、他のサービスと同様に緩い型で扱う
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const any = (db: Db) => db as any;

export type JudgmentKind = "structure" | "identity" | "relation" | "field" | "guard_refusal" | "reeval" | "correction";
export type ClaimBasis = "fact" | "inference" | "unknown";

export interface JudgmentInput {
  householdId: string;
  caseId?: string | null;
  lotteryId?: string | null;
  relatedLotteryId?: string | null;
  kind: JudgmentKind;
  subject?: string;
  claimBasis: ClaimBasis;
  value?: string;
  relation?: "same" | "independent" | "same_campaign_other" | "unknown" | null;
  evidenceCandidateId?: string | null;
  evidenceHash?: string | null;
  evidenceUrl?: string | null;
  observedAt?: string | null;
  evidenceStatus?: "fetched" | "not_fetched" | "unfetchable" | "fetched_unread" | null;
  evidenceRefs?: { candidateId?: string; hash?: string; url?: string }[];
  judgeKind?: "ai" | "fixed" | "human";
  modelId?: string | null;
  promptVersion?: string | null;
  correctionOf?: string | null;
  correctionSource?: "human" | "ai" | "verification" | null;
  costJpy?: number | null;
  reevalReason?: string;
  reevalResult?: string;
  actorProfileId?: string | null;
}

const clip = (s: string | undefined, n: number) => redact(s ?? "").slice(0, n);

/** 判断履歴を1件追記する。文面は伏せ字・切り詰め。失敗は例外にせず error を返す */
export async function recordJudgment(db: Db, j: JudgmentInput): Promise<{ ok: true; id: string } | { ok: false; error: string }> {
  const row = {
    household_id: j.householdId,
    case_id: j.caseId ?? null,
    lottery_id: j.lotteryId ?? null,
    related_lottery_id: j.relatedLotteryId ?? null,
    kind: j.kind,
    subject: clip(j.subject, 80),
    claim_basis: j.claimBasis,
    value: clip(j.value, 500),
    relation: j.relation ?? null,
    evidence_candidate_id: j.evidenceCandidateId ?? null,
    evidence_hash: j.evidenceHash ?? null,
    evidence_url: j.evidenceUrl ? clip(j.evidenceUrl, 600) : null,
    observed_at: j.observedAt ?? null,
    evidence_status: j.evidenceStatus ?? null,
    evidence_refs: (j.evidenceRefs ?? []).slice(0, 10).map((r) => ({ candidateId: r.candidateId, hash: r.hash, url: r.url ? clip(r.url, 300) : undefined })),
    judge_kind: j.judgeKind ?? "fixed",
    model_id: j.modelId ? clip(j.modelId, 80) : null,
    prompt_version: j.promptVersion ? clip(j.promptVersion, 80) : null,
    correction_of: j.correctionOf ?? null,
    correction_source: j.correctionSource ?? null,
    cost_jpy: j.costJpy ?? null, // 不明は NULL（0円にしない）
    reeval_reason: clip(j.reevalReason, 200),
    reeval_result: clip(j.reevalResult, 200),
    created_by_profile_id: j.actorProfileId ?? null,
  };
  const { data, error } = await any(db).from("case_judgments").insert(row).select("id").single();
  if (error || !data) return { ok: false, error: error?.message ?? "保存できませんでした" };
  return { ok: true, id: data.id as string };
}

/** 抽選の保護の理由コードを、DB関数から取得する（RLSにより、呼び出し者の世帯の記録だけが対象） */
export async function lotteryBlockerCodes(db: Db, lotteryId: string): Promise<string[]> {
  const { data, error } = await any(db).rpc("lottery_history_blockers", { p_lottery_id: lotteryId });
  if (error) return ["not_found"]; // 取得できないときは安全側（拒否）
  return (data ?? []) as string[];
}

/**
 * 自律的な操作（AI・自動処理）の可否を判定する共通入口。拒否したときは理由を判断履歴に記録する。
 * 手動の操作（人が画面から行う）には使わない。UI側のチェックに依存せず、自律処理は必ずここを通す。
 */
export async function guardAutonomousOp(db: Db, o: { householdId: string; lotteryId: string; op: AutonomousOp; actor: string; caseId?: string | null }): Promise<GuardDecision> {
  const codes = await lotteryBlockerCodes(db, o.lotteryId);
  const d = decideAutonomousOp(o.op, codes);
  if (!d.allowed && !codes.includes("not_found")) {
    await recordJudgment(db, {
      householdId: o.householdId,
      lotteryId: o.lotteryId,
      caseId: o.caseId ?? null,
      kind: "guard_refusal",
      subject: o.op,
      claimBasis: "fact",
      value: `${o.actor}の操作（${o.op}）を拒否: ${d.reasons.join("、")}`,
      judgeKind: "fixed",
    });
  }
  return d;
}

/** 案件を作る（構造は未確定が既定。根拠なく複数の応募機会を作らない） */
export async function createCase(db: Db, o: { householdId: string; title?: string; origin?: "collection" | "manual" | "reeval" | "autonomous" }): Promise<{ ok: true; id: string } | { ok: false; error: string }> {
  const { data, error } = await any(db).from("cases").insert({ household_id: o.householdId, title: clip(o.title, 200), origin: o.origin ?? "collection" }).select("id").single();
  if (error || !data) return { ok: false, error: error?.message ?? "案件を作成できませんでした" };
  return { ok: true, id: data.id as string };
}

/** 抽選を案件へ関連づける（非破壊: lotteries.case_id だけを設定。抽選ID・応募・履歴は変えない）。冪等（同じ関連づけの再実行は何も変えない） */
export async function linkLotteryToCase(db: Db, o: { householdId: string; lotteryId: string; caseId: string }): Promise<{ ok: true; changed: boolean } | { ok: false; error: string }> {
  const g = await guardAutonomousOp(db, { householdId: o.householdId, lotteryId: o.lotteryId, op: "link_case", actor: "case-foundation", caseId: o.caseId });
  if (!g.allowed) return { ok: false, error: g.reasons.join("、") };
  const { data: cur } = await any(db).from("lotteries").select("case_id").eq("id", o.lotteryId).maybeSingle();
  if (!cur) return { ok: false, error: "抽選が見つかりません" };
  if (cur.case_id === o.caseId) return { ok: true, changed: false };
  const { error } = await any(db).from("lotteries").update({ case_id: o.caseId }).eq("id", o.lotteryId).eq("household_id", o.householdId);
  return error ? { ok: false, error: error.message } : { ok: true, changed: true };
}

export interface JudgmentQuery {
  householdId: string;
  caseId?: string;
  lotteryId?: string;
  evidenceHash?: string;
  kind?: JudgmentKind;
  subject?: string;
  limit?: number;
}

/** 過去の判断・訂正の検索（読み取りのみ。10Eで、AIの入力に関連する過去判断を渡すために使う）。新しい順。件数の上限あり */
export async function searchJudgments(db: Db, q: JudgmentQuery): Promise<Record<string, unknown>[]> {
  let b = any(db).from("case_judgments").select("id,case_id,lottery_id,kind,subject,claim_basis,value,relation,evidence_hash,evidence_status,judge_kind,model_id,prompt_version,correction_of,correction_source,cost_jpy,created_at").eq("household_id", q.householdId);
  if (q.caseId) b = b.eq("case_id", q.caseId);
  if (q.lotteryId) b = b.eq("lottery_id", q.lotteryId);
  if (q.evidenceHash) b = b.eq("evidence_hash", q.evidenceHash);
  if (q.kind) b = b.eq("kind", q.kind);
  if (q.subject) b = b.eq("subject", q.subject);
  const { data } = await b.order("created_at", { ascending: false }).limit(Math.min(q.limit ?? 20, 100));
  return (data ?? []) as Record<string, unknown>[];
}
