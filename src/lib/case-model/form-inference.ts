/**
 * 店舗選択式の推定（Stage 9H-3G・純関数。DB・ネットワークに触れない）。
 *
 * 目的: AIが今回の告知から店舗選択式かを読み取れなかったときに、過去の確認済みの実績・系列の傾向を「判断材料」として使う。
 * ただし、実績や傾向だけで確定しない。確認済みと推定を区別して記録し、推定だけを根拠に独立抽選を削除・統合しない。
 *
 * 判定の優先順位（rank）:
 *   1. 今回の抽選の一次情報（公式の告知・主催者本文）に、構造の根拠がある      → 確認済み
 *   2. 今回の抽選の複数の情報源に、構造の根拠がある                         → 確認済み
 *   3. 同じ系列・同じ応募方式の、過去の確認済みの実績                        → 推定
 *   4. 系列全体の一般的な傾向（応募方式が違う実績を含む）                    → 推定（信頼度は低い）
 * 今回の情報が店舗別の独立した受付を示すときは、系列の傾向より今回の情報を優先する（傾向は使わず、上書きしたことを記録する）。
 * 判断材料が無ければ「不明」。店舗が分からないだけでは店舗選択式と断定しない。
 */
import type { LotteryForm, FormJudgement } from "@/lib/lottery-form";
import { chainCanonicalKey } from "@/lib/chain-normalize";
import type { ChainKnowledge } from "@/lib/collector/knowledge/chain-knowledge";
import type { HumanKnowledge } from "./human-knowledge";
import { chainFormTendency, platformOf, recordsFor, type FormTendency } from "./form-learning";
export { platformOf };
import type { LivePocketStructure } from "@/lib/collector/livepocket-structure";

export type FormState = "confirmed" | "estimated" | "unknown";

export type FormAction = "apply" | "propose" | "none";

export interface FormInference {
  state: FormState;
  /** store_select / store_independent / unknown */
  form: LotteryForm;
  /** 1〜4（上の優先順位）。根拠が無いとき null */
  rank: 1 | 2 | 3 | 4 | null;
  confidence: "high" | "medium" | "low";
  /** 判断の根拠（人が読む文）。推定のときは材料の出どころも含む */
  basis: string[];
  /** 判断材料（実績・傾向）を使ったか */
  priorUsed: boolean;
  /** 今回の情報を優先して、実績・傾向を使わなかった（上書きした）か */
  priorOverridden: boolean;
  /**
   * 登録への反映:
   *   apply   = 店舗が特定できておらず、推定の店舗選択式として登録してよい（推定であることを記録する）
   *   propose = 店舗を特定できているため、登録の形は変えない。確認する候補として示すだけ
   *   none    = 何もしない
   * 推定だけで、店舗別の独立抽選の削除・統合はしない（どの値でも）。
   */
  action: FormAction;
  /** 参照した実績の識別（記録用。推定のときだけ） */
  refs?: string[];
}

/** 系列の傾向の辞書（typical_store_select）→ 傾向の評価の補助入力 */
export function dictionaryOf(k: ChainKnowledge | null | undefined): { strength: "history" | "general"; observed: number }[] {
  return (k?.traits ?? []).filter((t) => t.code === "typical_store_select").map((t) => ({ strength: t.strength === "history" ? ("history" as const) : ("general" as const), observed: t.observed ?? 0 }));
}

/**
 * 今回の抽選の系列について、人間の実績（肯定・否定の双方向）と辞書から傾向を評価する。
 * 人間の実績が1件でもあれば、辞書の実績は数えない（同じ評価から作られていることがあるため二重計上しない）。
 */
export function tendencyFor(o: { human?: HumanKnowledge | null; chain: string; knowledge?: ChainKnowledge | null; platform?: string }): FormTendency | null {
  if (!o.chain.trim()) return null;
  const recs = recordsFor(o.human?.forms?.records, o.chain);
  const t = chainFormTendency(o.chain, recs, { platform: o.platform, dictionary: dictionaryOf(o.knowledge) });
  return t.strength === "none" && t.total === 0 ? null : t;
}

export interface InferInput {
  /** 今回の告知の構造の検査結果（judgeForm） */
  judgement: FormJudgement;
  /** AIが今回の告知から読み取った応募単位（unknownまたは未指定は読み取れなかった） */
  aiUnit?: string;
  /** 今回の抽選の情報源のうち、公式・主催者本文など一次の情報源から根拠が得られたか */
  primaryEvidence?: boolean;
  /** 構造の根拠が得られた、独立した情報源の数 */
  evidenceSources?: number;
  /** LivePocketの本文の構造解析（任意） */
  livepocket?: LivePocketStructure | null;
  /** 店舗を特定できているか（店舗名が分かっている） */
  storeKnown: boolean;
  /** 今回の抽選の応募方式（情報源から。不明は undefined） */
  platform?: string;
  /** 判断材料（人間の実績の傾向。肯定・否定の双方向）。無ければ null */
  tendency?: FormTendency | null;
}

const NONE = (extra: Partial<FormInference> = {}): FormInference => ({ state: "unknown", form: "unknown", rank: null, confidence: "low", basis: [], priorUsed: false, priorOverridden: false, action: "none", ...extra });

export function inferStoreForm(i: InferInput): FormInference {
  const j = i.judgement;
  const lp = i.livepocket ?? null;
  const t = i.tendency ?? null;
  const hasPriors = !!t && t.strength !== "none";

  // 利用者の手動の分類は、そのまま尊重する（推定の対象にしない）
  if (j.basisKind === "manual") return NONE({ state: "confirmed", form: j.form, rank: 1, confidence: "high", basis: j.basis });

  // 今回の情報が食い違うとき: 推定で埋めない（確認が必要）
  if (j.conflict || lp?.klass === "conflict") return NONE({ basis: ["今回の告知に、店舗を選ぶ記載と店舗ごとに受付する記載の両方がある（確認が必要。系列の傾向は使わない）"], priorOverridden: hasPriors });

  // ---- 今回の情報が店舗別の独立した受付を示す: 系列の傾向より優先する
  const independentNow = j.form === "store_independent" || lp?.klass === "B";
  if (independentNow) {
    const why = j.form === "store_independent" ? j.basis : (lp?.reasons ?? []);
    return NONE({
      state: "confirmed",
      form: "store_independent",
      rank: i.primaryEvidence ? 1 : (i.evidenceSources ?? 1) >= 2 ? 2 : 1,
      confidence: j.form === "store_independent" ? j.confidence : lp?.confidence ?? "medium",
      basis: [...why, ...(hasPriors ? ["系列の傾向・過去の実績より、今回の告知の記載（店舗別の独立した受付）を優先した"] : [])],
      priorOverridden: hasPriors,
    });
  }

  // ---- 今回の情報が店舗選択式を示す（確認済み）
  const structural = j.form === "store_select" && j.basisKind === "structure";
  const lpSelect = lp?.klass === "A";
  if (structural || lpSelect) {
    const rank: 1 | 2 = i.primaryEvidence ? 1 : (i.evidenceSources ?? 1) >= 2 ? 2 : 1;
    const conf = structural ? j.confidence : (lp?.confidence ?? "medium");
    return NONE({ state: "confirmed", form: "store_select", rank, confidence: conf, basis: [...(structural ? j.basis : []), ...(lpSelect ? lp!.reasons : [])], action: "none" });
  }
  // AIが今回の告知から店舗選択式と読み取った（構造の検査では裏づけが無い）
  if (i.aiUnit === "store_select") return NONE({ state: "confirmed", form: "store_select", rank: 1, confidence: "medium", basis: ["AIが今回の告知から、応募時に店舗を選ぶ抽選と読み取った"] });
  if (i.aiUnit === "store_independent") return NONE({ state: "confirmed", form: "store_independent", rank: 1, confidence: "medium", basis: ["AIが今回の告知から、店舗別の独立した抽選と読み取った"], priorOverridden: hasPriors });
  if (i.aiUnit === "other") return NONE({ state: "confirmed", form: "other", rank: 1, confidence: "medium", basis: ["AIが今回の告知から、店舗選択式でも店舗別でもない抽選と読み取った"], priorOverridden: hasPriors });
  // 通販・店舗を持たない抽選は、店舗選択式の推定の対象にしない
  if (j.form === "other") return NONE({ state: "confirmed", form: "other", rank: 1, confidence: "medium", basis: j.basis, priorOverridden: hasPriors });

  // ---- 今回の情報では判断できない → 判断材料（実績の傾向）から推定する
  if (!t || !hasPriors) return NONE({ basis: [j.restrictionOnly ? "「1店舗のみ応募」などの制限の記載はあるが、店舗選択欄・店舗ごとの受付は確認できない（制限だけでは店舗選択式と断定しない）" : "今回の告知から応募受付の構造を確認できず、判断材料（過去の実績・系列の傾向）も無い"] });
  // 実績が割れている／店舗選択式以外に傾いている → 店舗選択式と推定しない（不明のまま。傾向の根拠は記録する）
  if (t.split) return NONE({ basis: ["今回の告知から確認できず、系列の実績が割れている（店舗選択式と店舗別独立が混在）ため推定しない", ...t.basis], priorUsed: true, refs: t.refs });
  if (t.lean !== "store_select") return NONE({ basis: [`今回の告知から確認できない。系列の実績は${t.lean === "store_independent" ? "店舗別独立" : t.lean === "online_only" ? "通販のみ" : "どれにも傾いていない"}の傾向のため、店舗選択式とは推定しない`, ...t.basis], priorUsed: true, refs: t.refs });
  // 店舗選択式への傾き。信頼度は実績の強さと応募方式の一致で決める（推定は『高』にしない）。例外のある系列は一段下げ、店舗を特定できないときだけ登録の形に反映する
  const methodMatch = t.sameMethod > 0;
  let confidence: "medium" | "low" = t.strength === "strong" || (t.strength === "moderate" && methodMatch) ? "medium" : "low";
  if (t.hasExceptions) confidence = "low";
  const humanBased = t.total > 0;
  const rank: 3 | 4 = humanBased && (methodMatch || !i.platform) ? 3 : 4;
  const apply = !i.storeKnown && !(t.hasExceptions && t.strength !== "strong");
  const scope = humanBased ? (methodMatch ? "同じ系列・同じ応募方式の過去の確認済みの実績から、" : "同じ系列の過去の確認済みの実績から、") : "系列の一般的な傾向から、";
  const chance = humanBased ? (confidence === "medium" ? "店舗選択式の可能性が高い" : "店舗選択式の可能性がある") : "店舗選択式の可能性がある（信頼度は低い）";
  return NONE({
    state: "estimated",
    form: "store_select",
    rank,
    confidence,
    basis: [`推定: 今回の告知から確認できていない。${scope}${chance}`, ...t.basis],
    priorUsed: true,
    refs: t.refs,
    action: apply ? "apply" : "propose",
  });
}

/** 登録の記録に残す短い表記（trace / 注意） */
export function inferenceLabel(f: FormInference): string {
  const s = f.state === "confirmed" ? "確認済み" : f.state === "estimated" ? "推定" : "不明";
  return `店舗選択式の判断: ${s}${f.rank ? `（優先順位${f.rank}・信頼度${f.confidence === "high" ? "高" : f.confidence === "medium" ? "中" : "低"}）` : ""}`;
}
