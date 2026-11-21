/**
 * 応募単位の推論（Stage 10Q）の型・文脈の組み立て・出力の検証（純関数）。
 *  - 原則: 「明記が無い＝判定不能」としない。明示・応募先の構造・URLの違い・系列の運用傾向・過去の実例・参考知識を総合して**仮説**を立てる。ただし固定ルールにしない:
 *    今回の**明示的な根拠は経験則より優先**。根拠は 直接（今回の原文の抜粋）／類推（参考知識・過去の実例）／未確認 に区別する。
 *  - 機械検証できるもの: 直接の根拠の抜粋が与えた文脈に実在するか／参照した参考知識のIDが渡したものか／単位・タイミングが定義の範囲か。検証に通らない「直接」は「類推」へ降格する。
 *    AIの数値・確信度の自己申告だけで登録しない（類推のみの仮説は暫定候補までで、自動登録には進まない。decision.ts）。
 *  - 応募できる回数と応募時の選択肢を分ける: independentUnit（応募の独立単位）／selectableStores・storeGroups（選択肢）／selectionTiming（応募時か当選後か）。
 *    当選後に受取先を選ぶ型のものは、アプリの管理上は店舗選択式（appManagedUnit=store_select）だが、**応募時の選択必須とは表示しない**（displayStoreSelectAtApply=false）。
 */
import type { KnowledgeEntry, SelectionTiming, SuggestedUnit } from "./knowledge/knowledge";

export const UNIT_VALUES: SuggestedUnit[] = ["one_form_one", "store_select", "per_store", "per_store_group", "per_product", "shared_all_stores", "per_round", "unknown"];
export const TIMING_VALUES: SelectionTiming[] = ["at_apply", "after_win", "unknown"];
export type EvidenceBasis = "direct" | "analogy" | "unconfirmed";

export interface UnitEvidence {
  /** 今回の文脈からそのまま写した抜粋（直接の根拠）。類推・未確認では空でもよい */
  quote: string;
  basis: EvidenceBasis;
  /** 参照した参考知識・過去の実例のID */
  knowledgeIds: string[];
  note: string;
}
export interface UnitInference {
  independentUnit: SuggestedUnit;
  selectableStores: string[];
  storeGroups: string[];
  perProductForm: "yes" | "no" | "unknown";
  selectionTiming: SelectionTiming;
  /** 推論された方式（短い説明） */
  method: string;
  alternatives: { unit: SuggestedUnit; why: string }[];
  evidence: UnitEvidence[];
  /** AIの確信度（自己申告。登録の根拠にはしない） */
  confidence: "high" | "medium" | "low";
  unknowns: string[];
  /** 追加調査の候補（公開の応募ページ・規約・系列の過去の抽選など） */
  furtherInvestigation: string[];
}
export interface VerifiedUnitInference extends UnitInference {
  /** 直接の根拠（今回の原文の抜粋が実在）が1つ以上あるか */
  directEvidence: boolean;
  /** 機械検証で降格・除去したもの（原因コード） */
  downgraded: string[];
  /** アプリの管理上の単位（当選後の受取先選択も store_select として扱う） */
  appManagedUnit: SuggestedUnit;
  /** 応募時に店舗選択が必須と表示してよいか（当選後・不明なら false） */
  displayStoreSelectAtApply: boolean;
}

/** AIに渡す文脈（必要最小限。原文は伏せ字処理を通す。応募・当選・購入の履歴・個人情報は含めない） */
export interface UnitContext {
  /** 今回の告知の原文の抜粋（見出し・項目・本文の要点） */
  texts: string[];
  chain: string | null;
  stores: string[];
  products: string[];
  applyUrlHosts: string[];
  /** 応募フォーム・応募ページの構造の観察（取得できた場合のみ。例: 店舗選択肢の一覧） */
  formObservations: string[];
  /** 店舗グループ・応募制限の文言（原文から機械的に抜いたもの） */
  restrictionPhrases: string[];
  /** 店舗マスターの網羅性: 不完全なので、登録店舗が1つでも単店舗系列とは推論しない */
  storeMasterCompleteness: "unknown";
  /** 過去の関連する実例（同じ系列の既存の登録の応募方式の分布。人が確定したものと、そうでないものを分ける） */
  pastExamples: { id: string; summary: string; humanConfirmed: boolean }[];
  knowledge: KnowledgeEntry[];
}

const flat = (s: string): string => s.normalize("NFKC").replace(/[ \t\r\n　]+/g, "").toLowerCase();

/** 原文から、応募制限・店舗グループの文言を機械的に抜き出す（AIへの注目点。判断はAI） */
export function extractRestrictionPhrases(texts: string[]): string[] {
  const out = new Set<string>();
  for (const t of texts) {
    const s = t.normalize("NFKC");
    for (const m of s.matchAll(/[^。\n]{0,30}(?:他店舗|複数店舗|重複応募|同時応募|お一人様|1人1回|おひとり|グループ[A-ZＡ-Ｚ]|[A-D]グループ|いずれか1店舗|1店舗のみ|店舗を選択|店舗選択|受取店舗|お受け取り店舗|店頭受取|配送|当選後)[^。\n]{0,30}/g)) out.add(m[0].trim());
  }
  return [...out].slice(0, 8);
}

/** 過去の実例の要約: 同じ系列の既存の登録の応募方式（store_mode／lottery_form）の分布。確定済み（confirmed_at あり）と未確定を分ける */
export function summarizePastExamples(rows: { chainMatch: boolean; storeMode: string | null; lotteryForm: string | null; humanConfirmed: boolean }[]): UnitContext["pastExamples"] {
  const out: UnitContext["pastExamples"] = [];
  for (const confirmed of [true, false]) {
    const hit = rows.filter((r) => r.chainMatch && r.humanConfirmed === confirmed);
    if (!hit.length) continue;
    const dist = new Map<string, number>();
    for (const r of hit) dist.set(`${r.storeMode ?? "-"}/${r.lotteryForm ?? "-"}`, (dist.get(`${r.storeMode ?? "-"}/${r.lotteryForm ?? "-"}`) ?? 0) + 1);
    out.push({ id: confirmed ? "PAST-CHAIN-CONFIRMED" : "PAST-CHAIN-UNCONFIRMED", humanConfirmed: confirmed, summary: `同じ系列の既存の登録 ${hit.length}件の応募方式（保存形式/抽選形態: 件数）: ${[...dist].map(([k, n]) => `${k}:${n}`).join("、")}` });
  }
  return out;
}

/**
 * 直接の根拠の「手掛かり」検査: 抜粋が実在するだけでは、その単位の根拠にならない（無関係な文を引用しても「直接」にならない）。
 * 単位ごとに、抜粋に**その単位を示す語の手掛かり**があるときだけ直接の根拠として認める。これは判断ではなく、AIの主張と引用の対応を確かめる**妥当性の検査**（手掛かりが無ければ類推へ降格するだけで、単位を決めない）。
 */
const UNIT_CUES: Record<string, RegExp> = {
  store_select: /選択|選んで|選び|いずれか|1店舗|一店舗|受取店舗|お?受け?取り店舗|他店舗|複数店舗|店舗を指定|当選後|ご当選後/,
  per_store_group: /グループ|ブロック|[A-DＡ-Ｄ]組/,
  per_store: /各店|店舗ごと|店舗毎|店舗別|各店舗|当店|店舗単位/,
  per_product: /商品別|商品ごと|商品毎|別フォーム|各商品|フォーム/,
  per_round: /第[0-9０-９一二三四五]+回|回目|開催回|次回/,
  shared_all_stores: /全店|全店舗|共通|どの店舗でも/,
  one_form_one: /フォーム|ひとつ|1つ|一つ|1回/,
};
const TIMING_CUES: Record<string, RegExp> = { after_win: /当選後|ご当選後|当選された方/, at_apply: /応募時|応募の際|申込時|お申し込み時|選択してください|お選びください|選んで応募/ };
export const unitCueOk = (unit: SuggestedUnit, quote: string): boolean => (UNIT_CUES[unit]?.test(quote.normalize("NFKC")) ?? false);

/** AIの出力の機械検証。直接の根拠の抜粋が文脈に実在しなければ類推へ降格。未知の参考知識IDは除去。直接の根拠が無ければ確信度は high にしない */
export function verifyUnitInference(raw: UnitInference, ctx: Pick<UnitContext, "texts" | "knowledge" | "pastExamples" | "formObservations" | "restrictionPhrases">): VerifiedUnitInference {
  const downgraded: string[] = [];
  const body = flat([...ctx.texts, ...ctx.formObservations, ...ctx.restrictionPhrases].join("\n"));
  const validIds = new Set([...ctx.knowledge.map((k) => k.id), ...ctx.pastExamples.map((p) => p.id)]);
  const evidence = raw.evidence.map((e) => {
    let basis = e.basis;
    const q = flat(e.quote);
    if (basis === "direct" && !(q.length >= 8 && body.includes(q))) {
      basis = "analogy";
      downgraded.push("direct_quote_not_found");
    } else if (basis === "direct" && !unitCueOk(raw.independentUnit, e.quote) && !(TIMING_CUES[raw.selectionTiming]?.test(e.quote.normalize("NFKC")) ?? false)) {
      // 実在する抜粋でも、主張した単位・タイミングの手掛かりが無ければ直接の根拠とは認めない
      basis = "analogy";
      downgraded.push("direct_quote_lacks_unit_cue");
    }
    const ids = e.knowledgeIds.filter((id) => validIds.has(id));
    if (ids.length !== e.knowledgeIds.length) downgraded.push("unknown_knowledge_id_removed");
    return { ...e, basis, knowledgeIds: ids, quote: basis === "direct" ? e.quote : e.quote.slice(0, 200) };
  });
  const directEvidence = evidence.some((e) => e.basis === "direct");
  const unit = UNIT_VALUES.includes(raw.independentUnit) ? raw.independentUnit : "unknown";
  if (unit !== raw.independentUnit) downgraded.push("invalid_unit");
  let timing = TIMING_VALUES.includes(raw.selectionTiming) ? raw.selectionTiming : "unknown";
  if (timing !== "unknown" && !evidence.some((e) => e.basis === "direct" && (TIMING_CUES[timing]?.test(e.quote.normalize("NFKC")) ?? false)) && !ctx.texts.some((t) => TIMING_CUES[timing]?.test(t.normalize("NFKC")))) {
    timing = "unknown";
    downgraded.push("timing_without_textual_cue");
  }
  let confidence = raw.confidence;
  if (!directEvidence && confidence === "high") {
    confidence = "medium";
    downgraded.push("confidence_capped_no_direct_evidence");
  }
  if (!evidence.length) confidence = "low";
  const appManagedUnit: SuggestedUnit = unit;
  return { ...raw, independentUnit: unit, selectionTiming: timing, evidence, confidence, directEvidence, downgraded: [...new Set(downgraded)], appManagedUnit, displayStoreSelectAtApply: (unit === "store_select" || unit === "per_store_group") && timing === "at_apply" };
}

/** 推論から、決定的な根拠（直接・確信度中以上）で「応募単位が分かっている」と扱ってよいか */
export function unitKnownByInference(v: VerifiedUnitInference | null | undefined): boolean {
  return !!v && v.independentUnit !== "unknown" && v.directEvidence && v.confidence !== "low";
}
