/**
 * 自動登録・情報更新・確認待ち・除外の判断基準（Stage 10P・純関数）。**プレビューのみ。この関数は何も書き込まない**。
 *
 * 【公式性は条件ではない（10Pの方針）】公式であること・公式サイトを取得できること・公式SNSとの相互リンク・公式バッジの有無は、登録・候補・通知・補完の**必要条件にしない**。
 *   公式性を欠くという理由だけで、確認待ち・除外にしない。この関数は official.ts を読まず、情報源の種類（kind）も判断に使わない（テストで固定）。
 *   判断は、情報の**具体性・整合性・検証可能な根拠・独立性・応募単位・対象条件・重複リスク・期限**で行う。公式／非公式は根拠の一属性で、正確性の保証ではない。
 *
 * 新規（既存の登録に結びつかない応募機会）の区分:
 *   auto_register_preview = 実行可能な最低限の情報（抽選であること・系列と店舗または通販・商品・応募期間の締切・応募先/方法）が原文で確認でき、応募単位が明確で、対象条件に合い、
 *                           致命的な矛盾・重複の疑い・同一性の曖昧さが無い。**非公式の単独の情報源でも可**。登録の「プレビュー」を作る（実際の登録は本番導入後・別の承認）。
 *   candidate_with_gaps   = 上のうち、応募先・方法が不明など実行に関わる項目が欠けている（欠けている項目を明記）。
 *   needs_review          = 対象条件・同一性・重複・応募単位・締切（年・矛盾・役割）が曖昧、または重要項目に矛盾がある、または原文で確認できない。
 *   excluded              = 明確な対象外（地域外・他TCG・除外系列・通販除外）／終了済み／非抽選。登録・通知しないが、理由つきの発見記録を残す。
 * 既存の登録に結びついた応募機会: フィールド別の提案（補完／訂正の確認）だけ。保護された登録は確認のみ。
 * 独立性: 同じ元（同じ候補・同じ転載元）の情報源は1つの根拠として数える。転載の複数記事を独立した根拠と数えない。
 */
import type { ConditionResult } from "./conditions";
import { deadlineIsPast, isNotifiableDeadline, normalizeDateTime, validatePeriod, type NormalizedDateTime } from "./datetime";
import type { Cluster, FieldName, SourceFact } from "./types";

export type Decision = "auto_register_preview" | "candidate_with_gaps" | "needs_review" | "excluded" | "update_proposals";

/** 登録を止めない軽微な項目 */
const MINOR_FIELDS: FieldName[] = ["applyStart", "resultDate", "prefecture"];
/** 矛盾していたら人の確認が要る重要な項目 */
const CRITICAL_FIELDS: FieldName[] = ["chain", "store", "products", "applyDeadline", "applyStart"];

export interface DecisionInput {
  cluster: Cluster;
  /** クラスターの情報源（独立性・応募先・基準日の判定に使う。種類 kind は使わない） */
  facts: SourceFact[];
  eligibility: ConditionResult | null;
  now: Date;
  /** 重複の疑いが未解決の組の数。0でなければ確認待ち */
  unresolvedDuplicatePairs: number;
  aiUnstable?: boolean;
  isLottery?: boolean;
  /** 過去に訂正・誤報と分かった情報源の識別子。含まれていれば確認待ち */
  retractedSources?: ReadonlySet<string>;
}

export interface DecisionResult {
  decision: Decision;
  reasons: string[];
  gaps: FieldName[];
  conflicts: FieldName[];
  /** 独立した根拠の数（同じ元・同じ転載元は1つ） */
  independentSources: number;
  /** 締切の正規化（無ければ null） */
  deadline: NormalizedDateTime | null;
  /** 通知に使ってよい締切か（役割が締切・年が明示/曜日で確認・時刻まで・原文の根拠が確認済み） */
  notifiable: boolean;
}

/** 独立した根拠の数: 元（originId）または転載元（repostOf）が同じ情報源は1つ */
export function independentSourceCount(facts: SourceFact[]): number {
  return new Set(facts.map((f) => f.originId ?? f.repostOf ?? f.sourceId)).size;
}

export function isExpired(deadline: string | null | undefined, now: Date): boolean {
  if (!deadline) return false;
  const n = normalizeDateTime(deadline, { role: "apply_deadline", reference: now });
  return deadlineIsPast(n, now);
}

export function decideOpportunity(i: DecisionInput): DecisionResult {
  const c = i.cluster;
  const reasons: string[] = [];
  const fields = new Map(c.fields.map((f) => [f.field, f]));
  const conflicts = c.fields.filter((f) => f.status === "conflict").map((f) => f.field);
  const gaps = c.fields.filter((f) => f.status === "missing").map((f) => f.field);
  const independent = independentSourceCount(i.facts);
  const dl = fields.get("applyDeadline");
  const st = fields.get("applyStart");
  const ref = new Date(Math.min(...i.facts.map((f) => Date.parse(f.postedAt ?? f.fetchedAt ?? "") || i.now.getTime()), i.now.getTime()));
  const deadlineRaw = typeof dl?.adopted === "string" ? dl.adopted : null;
  const deadline = deadlineRaw ? normalizeDateTime(deadlineRaw, { role: "apply_deadline", reference: ref }) : null;
  const startRaw = typeof st?.adopted === "string" ? st.adopted : null;
  const start = startRaw ? normalizeDateTime(startRaw, { role: "apply_start", reference: ref }) : null;
  const deadlineVerified = !!dl?.candidates.some((x) => x.quoteVerified);
  const notifiable = !!deadline && isNotifiableDeadline(deadline, deadlineVerified);
  const out = (decision: Decision, rs: string[]): DecisionResult => ({ decision, reasons: rs, gaps, conflicts, independentSources: independent, deadline, notifiable });

  if (i.isLottery === false) return out("excluded", ["not_lottery"]);
  if (c.registrations.length > 0) {
    const n = c.proposals.length;
    return out("update_proposals", [n ? "has_field_proposals" : "no_changes_needed", ...(c.registrations.length > 1 ? ["possible_duplicate_registration"] : [])]);
  }
  if (i.eligibility?.verdict === "ineligible") return out("excluded", i.eligibility.reasons.filter((r) => r !== "tcg_unknown" && r !== "region_unknown"));
  if (deadline && deadlineIsPast(deadline, i.now)) return out("excluded", ["expired_closed"]);

  // ---- 確認待ち（曖昧さ・矛盾）
  if (!i.eligibility) reasons.push("eligibility_not_evaluated");
  else if (i.eligibility.verdict === "unknown") reasons.push(...(i.eligibility.reasons.length ? i.eligibility.reasons : ["eligibility_unknown"]));
  if (c.contested.length) reasons.push("identity_contested");
  if (i.unresolvedDuplicatePairs > 0) reasons.push("possible_duplicate_unresolved");
  if (i.aiUnstable) reasons.push("ai_adjudication_unstable");
  if (i.facts.some((f) => i.retractedSources?.has(f.sourceId))) reasons.push("source_previously_corrected");
  for (const f of conflicts) if (CRITICAL_FIELDS.includes(f)) reasons.push(`conflict_${f}`);
  if (!deadlineRaw) reasons.push("deadline_missing_or_conflicting");
  else {
    if (!deadlineVerified) reasons.push("deadline_not_verified_in_source");
    if (deadline && (deadline.yearBasis === "ambiguous" || deadline.weekdayMismatch || deadline.precision === "unparsed")) reasons.push("deadline_year_or_weekday_unresolved");
    if (validatePeriod(start, deadline) === "reversed") reasons.push("period_reversed");
  }
  const unit = c.applyUnit.value;
  const store = fields.get("store");
  const storeKnown = !!store && store.status !== "missing" && store.status !== "conflict";
  const online = !!i.eligibility && i.eligibility.basis.region === "eligible" && !storeKnown && /通販|オンライン/.test(JSON.stringify(store?.candidates ?? []));
  if (unit === "unknown") reasons.push(storeKnown || online ? "apply_unit_unknown" : "apply_unit_and_store_unknown");
  if (!storeKnown && !online && unit !== "unknown") reasons.push("store_unknown");
  if (fields.get("chain")?.status === "missing") reasons.push("chain_missing");
  if (!fields.get("products") || fields.get("products")?.status === "missing") reasons.push("products_missing");
  // 重要項目の原文確認: 系列・商品は、少なくとも1つの情報源で原文の根拠が確認できること（公式かどうかは問わない）
  for (const f of ["chain", "products"] as FieldName[]) if (!fields.get(f)?.candidates.some((x) => x.quoteVerified)) reasons.push(`field_not_verified_${f}`);
  if (reasons.length) return out("needs_review", [...new Set(reasons)]);

  // ---- 実行可能な最低限の情報は揃っている。応募先・方法が不明なら欠落つき候補
  const destination = fields.get("applyUrl")?.status !== "missing" || fields.get("method")?.status !== "missing" || i.facts.some((f) => (f.urls ?? []).length > 0);
  const minorGaps = gaps.filter((g) => MINOR_FIELDS.includes(g));
  if (!destination) return out("candidate_with_gaps", ["gap_apply_destination", ...minorGaps.map((g) => `gap_${g}`)]);
  return out("auto_register_preview", ["minimum_executable_info_verified", independent >= 2 ? "independent_sources_2plus" : "single_independent_source", ...minorGaps.map((g) => `minor_gap_${g}`)]);
}
