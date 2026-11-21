/**
 * 第2段階の旧方式との比較（Stage 10E）。**純関数のみ。AI・DB・ネットワークには接続しない**。比較は2つに分けて扱う:
 *  (a) 構造判定のみ: 旧の固定判定（`judgeForm`）を同じ原文に適用する。**費用なし・実AI不要**。旧方式は店舗選択式・店舗別独立・不明しか表現できず、
 *      商品別・開催回別・1送信複数独立は「表現不能」として別に数える（旧方式の誤りとは混ぜない。また、新方式に有利にならないよう正解にも入れない）。
 *  (b) 項目抽出まで含む比較: 旧の自動収集の抽出（`LotteryExtractor.extract`・実AI）を保存済み原文に適用する。**課金APIが必要なため、今回は未実行**。
 *      比較のための採点関数と費用見積もりだけを用意する。旧抽出の結果を正解（gold）に流用しない。
 */
import { judgeForm } from "@/lib/lottery-form";
import { dateMatches, type Gold } from "./replay";

export type LegacyKind = "store_select" | "per_store" | "unknown";

/** 旧方式の構造判定（原文だけから。既存の抽選の店舗方式があれば渡す） */
export function legacyStructureFromTexts(texts: string[], storeMode: "fixed" | "store_select" | "store_independent" | string = "fixed"): LegacyKind {
  const r = judgeForm({ storeMode: storeMode as never, texts: texts.filter(Boolean), selectableStoreCount: 0 });
  return r.form === "store_select" ? "store_select" : r.form === "store_independent" ? "per_store" : "unknown";
}

/** 旧方式が表現できる構造 */
const LEGACY_EXPRESSIBLE = new Set(["store_select", "per_store", "one_form_one", "unknown"]);

export interface StructureComparison {
  legacyCorrect: number;
  legacyWrong: number;
  /** 旧方式が表現できない構造の正解（商品別・開催回別・1送信複数独立）。誤りとは別集計 */
  legacyUnexpressible: number;
  scored: number;
}

/** 構造のみの比較。gold が検証不能・構造なしの事例は数えない。旧の "unknown" は one_form_one の正解とは一致させない（旧は1形式を断定しない） */
export function compareStructureOnly(rows: { gold: Gold; legacy: LegacyKind }[]): StructureComparison {
  const c: StructureComparison = { legacyCorrect: 0, legacyWrong: 0, legacyUnexpressible: 0, scored: 0 };
  for (const r of rows) {
    if (!r.gold.verifiable || !r.gold.structure) continue;
    c.scored++;
    if (!LEGACY_EXPRESSIBLE.has(r.gold.structure)) c.legacyUnexpressible++;
    else if (r.legacy === r.gold.structure) c.legacyCorrect++;
    else c.legacyWrong++;
  }
  return c;
}

/** 項目抽出の比較（旧抽出の項目と、人が確認した正解の項目）。旧抽出の実行は課金のため別途承認。正解がある項目だけ採点する */
export function scoreLegacyFields(gold: Gold, legacy: Record<string, string | null | undefined>): { scored: number; correct: number } {
  let scored = 0;
  let correct = 0;
  for (const [k, want] of Object.entries(gold.fields ?? {})) {
    scored++;
    const v = legacy[k];
    if (typeof v === "string" && dateMatches(v, want)) correct++;
  }
  return { scored, correct };
}

export interface CostPlan {
  cases: number;
  newMaxJpy: number;
  newTypicalJpy: number;
  legacyExtractEstJpy: number;
  totalCapJpy: number;
  perCaseCapJpy: number;
  /** 新方式の予約上限（総額の配分）。超過分は事前予約で停止（未実行として報告） */
  newBudgetJpy: number;
  legacyBudgetJpy: number;
  /** 最悪（全件3回）が配分内に収まるか。収まらなければ、予算停止で未実行になる事例が出うる */
  worstCaseFits: boolean;
  /** 配分内で、最悪でも全件完了できる最大件数 */
  maxCasesWorstCase: number;
}

/**
 * 費用の見積もり。**単価は実測・過去の報告書に基づく見積もりであり、実行前の予約が上限を保証する（見積もりが外れても上限は超えない）**。
 *  - 新方式: 1回の最悪 約0.55円（最大出力まで）× 最大3回 = 約1.65円/件。典型は約0.2〜0.4円/件（第1〜r4の実測: 0.19〜1.04円）。
 *  - 旧抽出: 1件約0.3円（過去の概算・未実測。旧抽出の本番実績で再確認が必要）。
 */
export function phase2CostPlan(cases: number, includeLegacyExtract: boolean, opts: { totalCapJpy?: number; perCaseCapJpy?: number } = {}): CostPlan {
  const total = opts.totalCapJpy ?? 50;
  const perCase = opts.perCaseCapJpy ?? 3;
  const maxPerCase = 1.65;
  const legacyBudget = includeLegacyExtract ? 15 : 0;
  const newBudget = total - legacyBudget;
  const newMax = round(cases * maxPerCase);
  return {
    cases,
    newMaxJpy: newMax,
    newTypicalJpy: round(cases * 0.4),
    legacyExtractEstJpy: includeLegacyExtract ? round(cases * 0.3) : 0,
    totalCapJpy: total,
    perCaseCapJpy: perCase,
    newBudgetJpy: newBudget,
    legacyBudgetJpy: legacyBudget,
    worstCaseFits: newMax <= newBudget && maxPerCase <= perCase,
    maxCasesWorstCase: Math.floor(newBudget / maxPerCase),
  };
}

const round = (x: number) => Math.round(x * 100) / 100;
