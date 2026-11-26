/**
 * 登録案への人のレビュー（保留／修正して承認／却下）の記録（Stage 10Z）。**承認は「新方式の登録案に対するレビュー記録」で、抽選の登録ではない**。
 * lotteries・applications・購入・通知には一切書かない。追記専用（更新・削除は権限もトリガもない）。AIの値は書き換えず、人の修正は edits に別に持つ。
 * 利用者のセッションのクライアント（RLS: 世帯の構成員・本人名義）で呼ぶ。
 */
import type { Db } from "@/lib/server/lottery-service";
import { proposalSurfaceEnabled } from "./flag";
import { recordHumanExperience } from "./experience-store";

export const REVIEW_DECISIONS = ["hold", "approve_with_edits", "reject"] as const;
export type ReviewDecision = (typeof REVIEW_DECISIONS)[number];

export type ReviewResult = { ok: true } | { ok: false; reason: "disabled" | "invalid" | "not_current" | "failed" };

const EDIT_FIELDS = /^[\p{L}\p{N}_ ]{1,40}$/u;
/** 修正できる項目数（抽選管理の全20項目＋判断・機会の補助。以前は12/16件で、超えた分を黙って捨てていた）・値の字数（条件・応募方法の長い記載を落とさない）。DBの上限（edits 4,000バイト・unknown_fields 16件）を超えるときは黙って捨てず「invalid」で返す */
export const MAX_EDIT_FIELDS = 30;
export const MAX_EDIT_CHARS = 400;
export const MAX_UNKNOWN_FIELDS = 16;
const EDITS_MAX_BYTES = 3900;
const bytes = (o: unknown): number => new TextEncoder().encode(JSON.stringify(o)).length;
/** 記録時点のAIの出力（全項目。値は DB の上限 4,000バイトに収まるよう、必要なときだけ短くする。完全な値は版として登録案の行に残る） */
export function aiSnapshotOf(p: { decision: string; verified: boolean; model_id: string | null; prompt_version: string | null; input_hash: string; version: number; mode: string; apply_unit: string; fields: Record<string, { value?: string | null; basis?: string; absence?: string }> }): Record<string, unknown> {
  const entries = Object.entries(p.fields ?? {}).filter(([k]) => k !== "_rationale" && k !== "_ask_human");
  for (const cap of [160, 100, 60, 30, 12]) {
    const s = { decision: p.decision, verified: p.verified, model_id: p.model_id, prompt_version: p.prompt_version, input_hash: p.input_hash, version: p.version, mode: p.mode, apply_unit: p.apply_unit, fields: Object.fromEntries(entries.map(([k, f]) => [k, { value: String(f?.value ?? "").slice(0, cap), basis: f?.basis ?? "unknown", ...(f?.absence ? { absence: f.absence } : {}) }])), ...(cap < 160 ? { valuesShortened: cap } : {}) };
    if (bytes(s) <= 3900) return s;
  }
  return { decision: p.decision, verified: p.verified, model_id: p.model_id, prompt_version: p.prompt_version, input_hash: p.input_hash, version: p.version, mode: p.mode, apply_unit: p.apply_unit, fields: {}, valuesShortened: 0 };
}

export async function recordReview(a: { db: Db; householdId: string; proposalId: string; decision: string; edits?: Record<string, unknown>; note?: string; env?: Record<string, string | undefined> }): Promise<ReviewResult> {
  if (!proposalSurfaceEnabled(a.env ?? process.env)) return { ok: false, reason: "disabled" };
  if (!(REVIEW_DECISIONS as readonly string[]).includes(a.decision)) return { ok: false, reason: "invalid" };
  const edits: Record<string, string> = {};
  if (Object.keys(a.edits ?? {}).length > MAX_EDIT_FIELDS) return { ok: false, reason: "invalid" };
  for (const [k, v] of Object.entries(a.edits ?? {})) {
    if (!EDIT_FIELDS.test(k) || typeof v !== "string" || v.length > MAX_EDIT_CHARS) return { ok: false, reason: "invalid" };
    edits[k] = v.trim();
  }
  if (bytes(edits) > EDITS_MAX_BYTES) return { ok: false, reason: "invalid" };
  if (a.decision === "approve_with_edits" && a.edits === undefined) return { ok: false, reason: "invalid" };
  const note = String(a.note ?? "").slice(0, 300);
  const db = a.db as unknown as { from: (n: string) => any }; // eslint-disable-line @typescript-eslint/no-explicit-any
  const cur = (await db.from("registration_proposals").select("id,proposal_key,superseded_at").eq("id", a.proposalId).eq("household_id", a.householdId).maybeSingle()) as { data: { id: string; proposal_key: string; superseded_at: string | null } | null };
  if (!cur.data) return { ok: false, reason: "invalid" };
  if (cur.data.superseded_at) return { ok: false, reason: "not_current" }; // 古い版にはレビューしない（現行の版を見て判断する）
  const ins = (await db.from("registration_proposal_reviews").insert({ household_id: a.householdId, proposal_key: cur.data.proposal_key, proposal_id: cur.data.id, decision: a.decision, edits, note })) as { error: unknown };
  if (ins.error) return { ok: false, reason: "failed" };
  // 人の確認（修正あり承認）は、検証済み（human）の調査経験として追記する（次回以降の「最初に見せる位置」の根拠）。失敗してもレビューの記録は成功のまま
  // 従来のレビュー（修正して承認）は、修正していない項目を人が確認したとは限らないため、経験としては残さない（ADAPTIVE_REVIEW の確認: 未確認の項目を人の確認とみなしていた）。人の確認済みの経験は、正解の記録で「正しい」としたときだけ残す
  return { ok: true };
}

// ------------------------------------------------------------------ 人の正解の記録（ADAPTIVE_REVIEW）
export const TRUTH_VERDICTS = ["correct", "corrected", "unknown_later"] as const;
export type TruthVerdict = (typeof TRUTH_VERDICTS)[number];
const TRUTH_DECISIONS = ["register", "exclude", "hold"] as const;
const OPPORTUNITY = ["exists", "absent", "unknown"] as const;
const USER_FIT = ["fit", "unfit", "unknown"] as const;
const inList = <T extends string>(xs: readonly T[], v: unknown): v is T => typeof v === "string" && (xs as readonly string[]).includes(v);
export type TruthResult = { ok: true; experience: number } | { ok: false; reason: "disabled" | "invalid" | "not_current" | "failed" };

/**
 * 登録案に対する「正解」を記録する（追記専用。AIの出力・過去の行は書き換えない）。**抽選の登録・削除・通知は一切しない**。
 *  - correct（変更なし）: AIの判断・項目をそのまま正解とする（記録時点のAIの出力を ai_snapshot に残す）
 *  - corrected（正解を修正）: 変更した項目・判断だけを入力する（正しい項目は再入力しない）。明示的に不明な項目は unknown_fields
 *  - unknown_later（まだ不明・後で確認）: 正解とも不正解とも数えない
 * 人が全項目を確認した「正しい」のときだけ、その引用を人の確認済みの調査経験として残す（未確認の項目を人の確認とみなさない）。経験は登録案と同じモード（mock/real）で保存する。
 */
export async function recordTruth(a: { db: Db; householdId: string; proposalId: string; verdict: string; truthDecision?: string; opportunity?: string; userFit?: string; edits?: Record<string, unknown>; unknownFields?: string[]; /** 原文を確認したが記載が無い項目（INTENSIVE_EVALUATION）。unknown_fields に `<項目>__none` として残す（明示的な不明と区別） */ notStatedFields?: string[]; note?: string; env?: Record<string, string | undefined> }): Promise<TruthResult> {
  if (!proposalSurfaceEnabled(a.env ?? process.env)) return { ok: false, reason: "disabled" };
  if (!inList(TRUTH_VERDICTS, a.verdict)) return { ok: false, reason: "invalid" };
  if (a.truthDecision !== undefined && a.truthDecision !== "" && !inList(TRUTH_DECISIONS, a.truthDecision)) return { ok: false, reason: "invalid" };
  if (a.opportunity !== undefined && a.opportunity !== "" && !inList(OPPORTUNITY, a.opportunity)) return { ok: false, reason: "invalid" };
  if (a.userFit !== undefined && a.userFit !== "" && !inList(USER_FIT, a.userFit)) return { ok: false, reason: "invalid" };
  const edits: Record<string, string> = {};
  if (Object.keys(a.edits ?? {}).length > MAX_EDIT_FIELDS) return { ok: false, reason: "invalid" };
  for (const [k, v] of Object.entries(a.edits ?? {})) {
    if (!EDIT_FIELDS.test(k) || typeof v !== "string" || v.length > MAX_EDIT_CHARS) return { ok: false, reason: "invalid" };
    if (v.trim()) edits[k] = v.trim();
  }
  if (bytes(edits) > EDITS_MAX_BYTES) return { ok: false, reason: "invalid" };
  const unknownFields = [...new Set([...(a.unknownFields ?? []).filter((k) => EDIT_FIELDS.test(k)), ...(a.notStatedFields ?? []).filter((k) => EDIT_FIELDS.test(k) && k.length <= 34).map((k) => `${k}__none`)])];
  if (unknownFields.length > MAX_UNKNOWN_FIELDS) return { ok: false, reason: "invalid" }; // 黙って捨てない（DBの上限16件）
  if (a.verdict === "corrected" && !Object.keys(edits).length && !unknownFields.length && !a.truthDecision && !a.opportunity && !a.userFit) return { ok: false, reason: "invalid" }; // 修正なのに何も変えていない
  const db = a.db as unknown as { from: (n: string) => any }; // eslint-disable-line @typescript-eslint/no-explicit-any
  const cur = (await db.from("registration_proposals").select("id,proposal_key,candidate_id,superseded_at,decision,verified,model_id,prompt_version,input_hash,version,mode,apply_unit,fields").eq("id", a.proposalId).eq("household_id", a.householdId).maybeSingle()) as { data: { id: string; proposal_key: string; candidate_id: string; superseded_at: string | null; decision: string; verified: boolean; model_id: string | null; prompt_version: string | null; input_hash: string; version: number; mode: string; apply_unit: string; fields: Record<string, { value?: string | null; basis?: string }> } | null };
  const p = cur.data;
  if (!p) return { ok: false, reason: "invalid" };
  if (p.superseded_at) return { ok: false, reason: "not_current" };
  const aiDecision = p.verified ? (p.decision === "tentative" ? "hold" : p.decision === "none" ? "hold" : p.decision) : "hold";
  const truthDecision = a.verdict === "correct" ? aiDecision : a.verdict === "corrected" ? a.truthDecision || null : null;
  const snapshot = aiSnapshotOf(p);
  const ins = (await db.from("registration_proposal_reviews").insert({ household_id: a.householdId, kind: "truth", decision: "truth", proposal_key: p.proposal_key, proposal_id: p.id, candidate_id: p.candidate_id, verdict: a.verdict, truth_decision: truthDecision, opportunity: a.verdict === "unknown_later" ? null : a.opportunity || null, user_fit: a.verdict === "unknown_later" ? null : a.userFit || null, edits: a.verdict === "corrected" ? edits : {}, unknown_fields: a.verdict === "corrected" ? unknownFields : [], note: String(a.note ?? "").slice(0, 300), ai_snapshot: snapshot })) as { error: unknown };
  if (ins.error) return { ok: false, reason: "failed" };
  let experience = 0;
  if (a.verdict === "correct") experience = (await recordHumanExperience({ db: a.db, householdId: a.householdId, proposalId: p.id, edits: {}, at: new Date().toISOString(), mode: p.mode === "real" ? "real" : p.mode === "replay" ? "replay" : "mock" }).catch(() => ({ saved: 0 }))).saved;
  return { ok: true, experience };
}

/** 登録案に無い応募機会（取りこぼし）を、候補に対して記録する（現行が見つけた候補との比較。AI独自の発見ではない）。追記専用・抽選は登録しない */
export async function recordMissed(a: { db: Db; householdId: string; candidateId: string; note: string; env?: Record<string, string | undefined> }): Promise<{ ok: true } | { ok: false; reason: "disabled" | "invalid" | "failed" }> {
  if (!proposalSurfaceEnabled(a.env ?? process.env)) return { ok: false, reason: "disabled" };
  const note = String(a.note ?? "").trim().slice(0, 300);
  if (!note) return { ok: false, reason: "invalid" };
  const db = a.db as unknown as { from: (n: string) => any }; // eslint-disable-line @typescript-eslint/no-explicit-any
  const c = (await db.from("collection_candidates").select("id").eq("id", a.candidateId).eq("household_id", a.householdId).maybeSingle()) as { data: { id: string } | null };
  if (!c.data) return { ok: false, reason: "invalid" };
  const ins = (await db.from("registration_proposal_reviews").insert({ household_id: a.householdId, kind: "missed", decision: "missed", candidate_id: c.data.id, note })) as { error: unknown };
  return ins.error ? { ok: false, reason: "failed" } : { ok: true };
}
