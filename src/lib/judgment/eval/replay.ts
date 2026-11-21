/**
 * 再生評価の土台（Stage 10E）。入力（eval/judgment-10e/cases.json）と正解（eval/judgment-10e/gold/gold.json）は別ファイル。
 * 入力の組み立てには正解を渡さない（`loadCases` は gold を読まない）。採点だけが正解を読む。
 * 旧方式（固定の形態判定 `judgeForm`）は、同じ原文で構造だけを判定できる。旧方式の項目抽出は実AI（既存の自動収集の抽出）が要るため**未測定**。
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { judgeForm } from "@/lib/lottery-form";
import { buildJudgmentInput, type EvidenceSeed } from "../build-input";
import type { FailureRecord, JudgmentInput, RelatedOpportunity } from "../contract";
import { findMasterCandidates, type MasterRow } from "../identity";
import type { JudgmentOutput } from "../contract";

const dir = join(process.cwd(), "eval", "judgment-10e");

export interface ReplayCase {
  id: string;
  title: string;
  evidence: (Omit<EvidenceSeed, "hash"> & { hash?: string })[];
  related: RelatedOpportunity[];
  failures?: FailureRecord[];
  masterRows?: MasterRow[];
  masterQuery?: { kind: "chain" | "store" | "product"; name: string };
  followUp?: { url: string; text: string };
  /** 利用者の対象地域（都道府県）。地域の絞り込みは固定の前処理の責務で、判断の入力として渡すだけ */
  regionPrefectures?: string[];
}

/** 評価セット: 既定は旧19件（eval/judgment-10e）。"unseen" は10E精度改善時の架空ケースK01〜K12（結果を見て修正したため今後は未見と呼ばない）、"holdout" は安定化で新設した独立ホールドアウトH01〜H06（正解は先に固定済み・実AI評価は未実施） */
export type EvalSet = "main" | "unseen" | "holdout";
const setDir = (set: EvalSet) => (set === "main" ? dir : join(dir, set));

export function loadCases(set: EvalSet = "main"): { now: string; cases: ReplayCase[] } {
  const j = JSON.parse(readFileSync(join(setDir(set), "cases.json"), "utf8"));
  return { now: j.now, cases: j.cases };
}

export interface Gold {
  verifiable: boolean;
  reason?: string;
  structure?: string;
  opportunityCount?: number;
  fields?: Record<string, string>;
  relations?: Record<string, string>;
  mustNotChange?: string[];
  mustNotAssertFacts?: boolean;
  candidates?: Record<string, string[]>;
  notCandidates?: string[];
  afterInvestigation?: Record<string, string>;
  /** 応募条件（conditions）の事実の主張に含まれるべき語（地域の限定・除外など） */
  conditionsMention?: string[];
  /** 店舗が未確定の事例: 店舗を事実として断定してはならない */
  storeMustNotBeAsserted?: boolean;
  /** 構造が unknown（保留）であることが正しい事例（種類を断定すると誤り） */
  structureHold?: boolean;
  issue: string;
}
export function loadGold(set: EvalSet = "main"): Record<string, Gold> {
  return JSON.parse(readFileSync(join(setDir(set), "gold", "gold.json"), "utf8")).gold;
}

export async function inputFor(c: ReplayCase, now: string): Promise<JudgmentInput> {
  return buildJudgmentInput({
    caseId: null,
    title: c.title,
    now: new Date(now),
    evidence: c.evidence.map((e, i) => ({ ...e, hash: e.hash ?? (e.text ? `${i}`.padStart(64, "0") : null), fetchedAt: e.fetchedAt ?? now, via: e.via ?? "web_fetch" })),
    related: c.related,
    masters: c.masterRows && c.masterQuery ? findMasterCandidates(c.masterQuery, c.masterRows) : [],
    failures: c.failures ?? [],
    regionPrefectures: c.regionPrefectures ?? [],
  });
}

// ---------------------------------------------------------------- 採点
export interface CaseScore {
  id: string;
  verifiable: boolean;
  structureOk: boolean | null;
  countOk: boolean | null;
  fieldsOk: Record<string, boolean>;
  falseMerge: number;
  falseSplit: number;
  unsupportedFacts: number;
  mustNotChangeViolations: number;
  /** 応募条件に、正解の語がすべて事実として記録されたか（地域の限定・除外など）。対象外は null */
  conditionsOk: boolean | null;
  /** 既存の抽選との関係: 正解の件数と、一致した件数（unknown・未出力は不一致として数えるが、誤統合・誤分割には数えない） */
  relScored: number;
  relCorrect: number;
  /** 店舗未確定の事例で、店舗を事実として断定した件数 */
  storeAsserted: number;
}

/** 日付の一致: 正解が日付のみ（YYYY-MM-DD）なら、値が「その日付で始まり、続きが時刻だけ（または無い）」ときに一致。注釈つきの値（例: `2099-03-14（原文上の…）`）は、別の問題（出力形式）として一致にしない */
export function dateMatches(value: string, gold: string): boolean {
  const v = value.trim();
  return v === gold || (v.startsWith(gold) && /^[ T]\d{2}:\d{2}(:\d{2})?$/.test(v.slice(gold.length)));
}

const flatFields = (o: JudgmentOutput) => o.opportunities.flatMap((op) => (["applyDeadline", "applyStart", "resultDate"] as const).map((f) => ({ f, c: op[f] })));

export function scoreCase(id: string, gold: Gold, out: JudgmentOutput | null): CaseScore {
  const s: CaseScore = { id, verifiable: gold.verifiable, structureOk: null, countOk: null, fieldsOk: {}, falseMerge: 0, falseSplit: 0, unsupportedFacts: 0, mustNotChangeViolations: 0, conditionsOk: null, relScored: 0, relCorrect: 0, storeAsserted: 0 };
  if (!out) return s;
  const factClaims = [out.caseType, ...out.opportunities.flatMap((op) => [op.chain, op.store, op.products, op.applyStart, op.applyDeadline, op.resultDate, op.conditions])].filter((c) => c && c.basis === "fact");
  if (!gold.verifiable) {
    s.unsupportedFacts = gold.mustNotAssertFacts ? factClaims.length : 0;
    return s;
  }
  s.structureOk = gold.structureHold ? out.structure.kind === "unknown" : gold.structure ? out.structure.kind === gold.structure : null;
  s.countOk = gold.opportunityCount != null ? out.opportunities.length === gold.opportunityCount : null;
  for (const [k, v] of Object.entries(gold.fields ?? {})) s.fieldsOk[k] = flatFields(out).some((x) => x.f === k && x.c && x.c.basis === "fact" && dateMatches(x.c.value, v));
  for (const [lid, want] of Object.entries(gold.relations ?? {})) {
    s.relScored++;
    if (out.relations.some((r) => r.lotteryId === lid && r.relation === want)) s.relCorrect++;
  }
  // 関係は「応募機会 × 既存カード」の組み合わせ単位で見る（Stage 10E r3 安定化）。
  // 既存カード1件に対して複数の応募機会があるとき、同じ権利を表す機会（same）と、別の権利を表す機会（same_campaign_other 等）が同時に成り立つ。
  //  - 正解が same: same の機会が1つも無いのに別扱い（independent / same_campaign_other）が出たら誤分割。same が別々の機会に2つ以上付いたら、
  //    1枚のカードを複数の独立した権利と同一視する誤統合（超過分を数える）。same と別回の別扱いが併存するのは、誤分割にしない。
  //  - 正解が same 以外: same と判断した機会ごとに誤統合。正解が same_campaign_other で independent と判断した機会ごとに誤分割。
  for (const [lid, g] of Object.entries(gold.relations ?? {})) {
    const rs = out.relations.filter((r) => r.lotteryId === lid);
    const sameKeys = new Set(rs.filter((r) => r.relation === "same").map((r) => r.opportunityKey));
    if (g === "same") {
      if (sameKeys.size === 0) s.falseSplit += rs.filter((r) => r.relation === "independent" || r.relation === "same_campaign_other").length;
      else if (sameKeys.size > 1) s.falseMerge += sameKeys.size - 1;
    } else {
      s.falseMerge += sameKeys.size;
      if (g === "same_campaign_other") s.falseSplit += rs.filter((r) => r.relation === "independent").length;
    }
  }
  if (gold.opportunityCount != null && out.opportunities.length > gold.opportunityCount) s.falseSplit += out.opportunities.length - gold.opportunityCount;
  // 独立した応募機会を、より少ない件数にまとめてしまった（機会の誤統合）。関係の判断による誤統合とは別に数える
  if (gold.opportunityCount != null && out.opportunities.length < gold.opportunityCount) s.falseMerge += gold.opportunityCount - out.opportunities.length;
  if (gold.conditionsMention) {
    const text = out.opportunities.map((op) => (op.conditions && op.conditions.basis === "fact" ? op.conditions.value : "")).join(" ");
    s.conditionsOk = gold.conditionsMention.every((w) => text.includes(w));
  }
  if (gold.storeMustNotBeAsserted) s.storeAsserted = out.opportunities.filter((op) => op.store && op.store.basis === "fact").length;
  for (const p of out.plannedChanges) if (gold.mustNotChange?.includes(p.lotteryId) && p.op !== "link_case") s.mustNotChangeViolations++;
  return s;
}

/** 旧方式（固定の形態判定）の、同じ原文での構造判定。per_product・複数機会は表現できない（未対応） */
export function legacyStructure(c: ReplayCase): "store_select" | "per_store" | "unknown" {
  const texts = c.evidence.map((e) => e.text).filter((t): t is string => !!t);
  const r = judgeForm({ storeMode: c.related[0]?.storeMode ?? "fixed", texts, selectableStoreCount: 0 });
  return r.form === "store_select" ? "store_select" : r.form === "store_independent" ? "per_store" : "unknown";
}
