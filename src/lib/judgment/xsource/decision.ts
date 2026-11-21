/**
 * 自動登録・情報更新・確認待ち・除外の判断基準（Stage 10O・純関数）。**プレビューのみ。この関数は何も書き込まない**。
 *
 * 新規（既存の登録に結びつかない応募機会）の4区分:
 *   auto_register_preview = 確実な対象・独立した応募機会・出典（原文）確認済み・重複照合済み。登録の「プレビュー」を作ってよい（実際の登録は本番導入後・別の承認）。
 *   candidate_with_gaps   = 対象・同一性・締切は確かだが、軽微な項目が欠けている（受付開始・結果発表・応募方法など）。欠けている項目を明記した候補。
 *   needs_review          = 応募単位・対象条件・同一性・重要な日時・公式性が曖昧、または矛盾がある。人が確認する。
 *   excluded              = 明確な対象外（地域外・他TCG・除外系列・通販除外）／終了済み。**登録・通知しないが、理由つきの発見記録を残す**（監査可能）。
 * 既存の登録に結びついた応募機会: 登録の更新は**フィールド別の提案**（補完 fill_empty／訂正の確認 ask_human）だけ。保護された登録（応募済み・当選・購入・手動編集・★・通知・スルー等）には変更を提案せず確認のみ。
 * 欠落と矛盾は区別する: 欠落＝どの情報源にも値がない（登録を止めない軽微な項目もある）／矛盾＝情報源どうしで値が食い違う（重要項目なら確認待ち）。
 */
import type { ConditionResult } from "./conditions";
import { parseDate } from "./normalize";
import type { Cluster, FieldName } from "./types";

export type Decision = "auto_register_preview" | "candidate_with_gaps" | "needs_review" | "excluded" | "update_proposals";

/** 欠けていても登録を止めない軽微な項目 */
const MINOR_FIELDS: FieldName[] = ["applyStart", "resultDate", "method", "applyUrl", "prefecture"];
/** 矛盾していたら人の確認が要る重要な項目 */
const CRITICAL_FIELDS: FieldName[] = ["chain", "store", "products", "applyDeadline", "applyStart"];

export interface DecisionInput {
  cluster: Cluster;
  /** 対象条件の判定（地域・TCG・除外系列・通販）。無ければ未判定として確認待ち */
  eligibility: ConditionResult | null;
  /** 判断の基準日（締切の経過判定） */
  now: Date;
  /** 重複の疑いが未解決の組の数（不明な関係で、系列が同じ・矛盾がないもの）。0でなければ確認待ち */
  unresolvedDuplicatePairs: number;
  /** AIの照合が不安定（複数回で結果が割れた）な組を含むか。含めば自動統合・自動登録しない */
  aiUnstable?: boolean;
  /** 抽選として確定した（非抽選ではない）か */
  isLottery?: boolean;
}

export interface DecisionResult {
  decision: Decision;
  /** 理由のコード（確認画面・報告用。原文を含まない） */
  reasons: string[];
  /** 欠けている項目（軽微なもの・重要なもの） */
  gaps: FieldName[];
  /** 矛盾している項目 */
  conflicts: FieldName[];
}

/** 締切が基準日より前（終了済み）か。年が無い表記は基準日の年で、日付だけ過ぎていれば終了とみなす（時刻が無ければその日の終わりまで） */
export function isExpired(deadline: string | null | undefined, now: Date): boolean {
  const d = parseDate(deadline);
  if (!d) return false;
  const year = d.year ?? now.getFullYear();
  const end = new Date(Date.UTC(year, d.month - 1, d.day, d.hour ?? 23, d.minute ?? 59) - 9 * 3600_000); // JSTの時刻
  return end.getTime() < now.getTime();
}

export function decideOpportunity(i: DecisionInput): DecisionResult {
  const c = i.cluster;
  const reasons: string[] = [];
  const fields = new Map(c.fields.map((f) => [f.field, f]));
  const conflicts = c.fields.filter((f) => f.status === "conflict").map((f) => f.field);
  const gaps = c.fields.filter((f) => f.status === "missing").map((f) => f.field);
  const out = (decision: Decision, rs: string[]): DecisionResult => ({ decision, reasons: rs, gaps, conflicts });

  if (i.isLottery === false) return out("excluded", ["not_lottery"]);
  // 既存の登録に結びつく: 更新は提案のみ（保護は resolve が確認のみにしている）。新規登録は作らない
  if (c.registrations.length > 0) {
    const n = c.proposals.length;
    return out("update_proposals", [n ? "has_field_proposals" : "no_changes_needed", ...(c.registrations.length > 1 ? ["possible_duplicate_registration"] : [])]);
  }
  // 明確な対象外
  if (i.eligibility?.verdict === "ineligible") return out("excluded", i.eligibility.reasons.filter((r) => r !== "tcg_unknown" && r !== "region_unknown"));
  const dl = fields.get("applyDeadline");
  const deadline = typeof dl?.adopted === "string" ? dl.adopted : null;
  if (deadline && isExpired(deadline, i.now)) return out("excluded", ["expired_closed"]);

  // ---- 確認待ちの条件（1つでも当てはまれば）
  if (!i.eligibility) reasons.push("eligibility_not_evaluated");
  else if (i.eligibility.verdict === "unknown") reasons.push(...(i.eligibility.reasons.length ? i.eligibility.reasons : ["eligibility_unknown"]));
  if (c.contested.length) reasons.push("identity_contested");
  if (i.unresolvedDuplicatePairs > 0) reasons.push("possible_duplicate_unresolved");
  if (i.aiUnstable) reasons.push("ai_adjudication_unstable");
  for (const f of conflicts) if (CRITICAL_FIELDS.includes(f)) reasons.push(`conflict_${f}`);
  if (!deadline) reasons.push("deadline_missing_or_conflicting");
  else if (!dl?.candidates.some((x) => x.quoteVerified)) reasons.push("deadline_not_verified_in_source");
  const unit = c.applyUnit.value;
  const store = fields.get("store");
  const storeKnown = !!store && store.status !== "missing" && store.status !== "conflict";
  if (unit === "unknown" && !storeKnown) reasons.push("apply_unit_and_store_unknown");
  if (fields.get("chain")?.status === "missing") reasons.push("chain_missing");
  if (!fields.get("products") || fields.get("products")?.status === "missing") reasons.push("products_missing");
  // 公式性: 公式（相互リンクで裏付け）または応募先の根拠が1つも無ければ、確認待ち
  const authoritative = c.fields.some((f) => f.candidates.some((x) => x.kind === "official_site" || x.kind === "official_x" || x.kind === "apply_form"));
  const verifiedFields = (["chain", "store", "products", "applyDeadline"] as FieldName[]).every((f) => fields.get(f)?.candidates.some((x) => x.quoteVerified) || (f === "store" && !storeKnown));
  // 公式性が裏付けられていない（公式・応募先のどちらの根拠も無い）なら、自動登録にも「欠落つき候補」にもせず、確認待ち
  if (!authoritative) reasons.push("official_source_unverified");
  if (reasons.length) return out("needs_review", [...new Set(reasons)]);

  const minorGaps = gaps.filter((g) => MINOR_FIELDS.includes(g));
  if (!verifiedFields) return out("needs_review", ["field_not_verified_in_source"]);
  if (minorGaps.length || unit === "unknown") return out("candidate_with_gaps", [...minorGaps.map((g) => `gap_${g}`), ...(unit === "unknown" ? ["apply_unit_unknown"] : []), "official_or_form_source"]);
  return out("auto_register_preview", ["all_checks_passed", "official_or_form_source"]);
}
