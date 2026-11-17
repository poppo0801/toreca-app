/**
 * 応募構造の判断と、トレマネでの店舗選択要否の判断（Stage 9H-3M・純関数。DB・ネットワークに触れない）。
 *
 * 9H-3K の人間評価で、イエローサブマリン・キントレ/トレカ丸・ゲオ・ヨドバシカメラの4件が「店舗選択式」と訂正された。
 * 根本原因は、従来の判断が「応募フォームに店舗選択欄があるか」だけを見ており、次を混同していたこと:
 *   (1) 応募の実際の構造（内部情報）
 *   (2) トレマネ上で店舗を選択・管理する必要があるか（利用者が応募・購入先の店舗を決める必要があるか）
 * 「1店舗のみ応募」「応募店舗で購入」「全国の対象店舗」「受取店舗を選ぶ」は(2)の強い材料だが、(1)の証拠ではない。
 * そこで(1)(2)を別に判断し、(2)は複数の材料の組み合わせで「推定」までにとどめる（確定しない・人間が確認した判断は上書きしない）。
 */
import { FORM_PATTERNS } from "@/lib/lottery-form";
import type { FormInference, InferInput } from "./form-inference";
import { inferStoreForm } from "./form-inference";

/** 実際の応募構造（内部情報） */
export type ApplyStructure =
  | "select_in_form" //            応募フォーム内で店舗を選択する
  | "per_store_url" //             店舗ごとに個別の応募URLがある
  | "shared_form_store_managed" // 共通フォームだが、店舗単位で応募・購入先を管理する
  | "pickup_store_choice" //       当選後（購入時）に受取店舗を選択する
  | "single_store" //              特定店舗のみの独立抽選
  | "online_only" //              通販限定（店舗選択が不要）
  | "unknown";

export type Need = "required" | "not_required" | "unknown";

export interface StructureSignal {
  code: "multi_store_scope" | "cross_store_limit" | "buy_at_applied_store" | "pickup_choice" | "chain_without_store" | "prior_store_select" | "per_store_page" | "select_field" | "single_store_named" | "shipping_only";
  label: string;
  /** 店舗選択が必要であることの材料の重み（0=材料にならない） */
  weight: number;
}

export interface StructureJudgement {
  structure: ApplyStructure;
  /** トレマネで店舗を選択・管理する必要があるか（確認済み／推定／不明を state で区別） */
  storeSelectNeed: Need;
  state: "confirmed" | "estimated" | "unknown";
  signals: StructureSignal[];
  basis: string[];
}

const norm = (s: string): string => s.normalize("NFKC").replace(/\s+/g, "");

const MULTI_STORE_SCOPE = /(全国|一部|各地|複数|対象|取扱|取り扱い|実施|参加)(の)?(店舗|店|ゲオ|ショップ)|店舗(一覧|リスト)|(対象|実施|取扱)店舗/;
const BUY_AT_APPLIED = /(応募|申込|申し込み)(した|いただいた|された)?店舗(で|にて|のみ|以外).{0,10}(購入|受取|受け取り|引取|お渡し|できません|不可|のみ)|応募店舗(で|にて|以外)/;
const PICKUP_CHOICE = /(受取|受け取り|お受取り|引取|お渡し)(方法|店舗|場所).{0,8}(選択|選べ|選ん|お選び|指定)|店舗(受取|受け取り).{0,6}(または|か|・|、).{0,6}(配送|宅配|郵送)|(配送|宅配|郵送).{0,6}(または|か|・|、).{0,6}店舗(受取|受け取り)/;

export interface StructureInput {
  /** 告知・応募条件・情報源の文面（外部由来＝データとして扱う） */
  texts: string[];
  /** AIが読み取った受取方法（store / shipping / either / null など） */
  receiveMethod?: string | null;
  /** 系列名が分かっているか */
  chainKnown: boolean;
  /** 店舗を特定できているか */
  storeKnown: boolean;
  /** 店舗ごとの応募ページがあるか（応募ページを調べた結果） */
  perStorePages?: boolean;
  /** 従来の判断（応募フォームの構造の検査と実績）の結果 */
  base: FormInference;
}

/** 応募構造を判断し、店舗選択の要否を別に判断する。確認済みの判断（人間・構造の根拠）は変えない */
export function judgeApplyStructure(i: StructureInput): StructureJudgement {
  const text = norm(i.texts.filter(Boolean).join("\n"));
  const sig: StructureSignal[] = [];
  const recv = (i.receiveMethod ?? "").toLowerCase();
  const b = i.base;

  // 確認済み（構造の根拠・人間の手動分類）: そのまま尊重する
  if (b.state === "confirmed") {
    if (b.form === "store_select") return { structure: "select_in_form", storeSelectNeed: "required", state: "confirmed", signals: [{ code: "select_field", label: "応募構造の根拠から店舗選択式（確認済み）", weight: 0 }], basis: b.basis };
    if (b.form === "store_independent") return { structure: i.perStorePages ? "per_store_url" : "single_store", storeSelectNeed: "not_required", state: "confirmed", signals: [], basis: b.basis };
    return { structure: recv === "shipping" ? "online_only" : "unknown", storeSelectNeed: "not_required", state: "confirmed", signals: [], basis: b.basis };
  }

  // 通販のみ: 店舗選択は不要
  const shippingOnly = recv === "shipping";
  if (shippingOnly) return { structure: "online_only", storeSelectNeed: "not_required", state: "estimated", signals: [{ code: "shipping_only", label: "受取方法が配送のみ（店舗の選択は不要）", weight: 0 }], basis: ["受取方法が配送のみのため、店舗の選択は不要"] };

  if (i.storeKnown) sig.push({ code: "single_store_named", label: "特定の店舗が分かっている", weight: 0 });
  if (FORM_PATTERNS.SELECT_FIELD.some((re) => re.test(text))) sig.push({ code: "select_field", label: "応募時に店舗を選ぶ旨の記載", weight: 3 });
  if (FORM_PATTERNS.CROSS_STORE_LIMIT.some((re) => re.test(text)) || FORM_PATTERNS.RESTRICTION.some((re) => re.test(text))) sig.push({ code: "cross_store_limit", label: "応募できる店舗が1つに制限されている記載（制限は構造の証拠ではなく材料）", weight: 1 });
  if (MULTI_STORE_SCOPE.test(text)) sig.push({ code: "multi_store_scope", label: "複数・全国の対象店舗を指す記載", weight: 1 });
  if (BUY_AT_APPLIED.test(text)) sig.push({ code: "buy_at_applied_store", label: "応募した店舗で購入・受取する旨の記載", weight: 1 });
  if (recv === "either" || PICKUP_CHOICE.test(text)) sig.push({ code: "pickup_choice", label: "受取を店舗か配送かで選べる／受取店舗を選ぶ", weight: 1 });
  if (!i.storeKnown && i.chainKnown && (recv === "store" || recv === "either")) sig.push({ code: "chain_without_store", label: "系列は分かるが店舗は特定できない（店舗受取）", weight: 1 });
  if (i.perStorePages) sig.push({ code: "per_store_page", label: "店舗ごとに個別の応募ページがある", weight: 0 });
  if (b.priorUsed && b.form === "store_select") sig.push({ code: "prior_store_select", label: "同じ系列の過去の確認済みの実績が店舗選択式", weight: b.confidence === "medium" ? 2 : 1 });

  const score = sig.reduce((n, s) => n + s.weight, 0);
  const kinds = new Set(sig.filter((s) => s.weight > 0).map((s) => s.code)).size;
  const named = sig.some((s) => s.code === "single_store_named");
  const structure: ApplyStructure = sig.some((s) => s.code === "select_field")
    ? "select_in_form"
    : sig.some((s) => s.code === "pickup_choice") && !sig.some((s) => s.code === "cross_store_limit")
      ? "pickup_store_choice"
      : i.perStorePages
        ? "per_store_url"
        : named && !sig.some((s) => s.code === "multi_store_scope")
          ? "single_store"
          : kinds >= 1 && !named
            ? "shared_form_store_managed"
            : "unknown";

  // 特定店舗の独立した抽選（複数店舗を指す記載・店舗をまたぐ制限が無い）: 店舗選択は不要（確認済みではなく推定）
  if (named && !sig.some((s) => s.code === "multi_store_scope" || s.code === "cross_store_limit" || s.code === "select_field")) {
    return { structure: "single_store", storeSelectNeed: "not_required", state: "estimated", signals: sig, basis: ["特定の店舗の抽選で、複数店舗を選ぶ記載は無い"] };
  }
  // 材料が2種類以上かつ合計2以上: 店舗選択が必要と「推定」する。1種類だけ（例: 店舗が不明なだけ）では推定しない
  if (kinds >= 2 && score >= 2) {
    return { structure, storeSelectNeed: "required", state: "estimated", signals: sig, basis: [`推定: ${sig.filter((s) => s.weight > 0).map((s) => s.label).join("／")}。応募フォームの店舗選択欄は確認できていないが、利用者が応募・購入先の店舗を決める必要がある抽選と判断`] };
  }
  return { structure, storeSelectNeed: "unknown", state: "unknown", signals: sig, basis: [sig.some((s) => s.weight > 0) ? `材料が1種類だけで、店舗選択の要否は判断できない（${sig.filter((s) => s.weight > 0).map((s) => s.label).join("／")}）` : "店舗選択の要否を判断する材料が無い"] };
}

export interface LayeredInput extends InferInput {
  texts: string[];
  receiveMethod?: string | null;
  chainKnown: boolean;
  perStorePages?: boolean;
}
export interface LayeredInference extends FormInference {
  /** 実際の応募構造（内部情報）と、店舗選択の要否（別の判断） */
  structure: StructureJudgement;
}

/**
 * 従来の判断（確認済み・実績による推定）に、応募構造の判断を重ねる。
 * - 確認済みの判断・人間が確認した判断は、弱い推定で上書きしない。
 * - 従来が「不明」または「店舗選択式以外へ傾く実績による不明」のとき、構造の判断が「店舗選択が必要（推定）」なら、推定の店舗選択式にする。
 * - 店舗を特定できているときは、登録の形を変えず確認候補（propose）にとどめる。店舗が不明で材料が3種類以上のときだけ登録の形に反映（apply）する。
 */
export function inferWithStructure(i: LayeredInput): LayeredInference {
  const base = inferStoreForm(i);
  const st = judgeApplyStructure({ texts: i.texts, receiveMethod: i.receiveMethod, chainKnown: i.chainKnown, storeKnown: i.storeKnown, perStorePages: i.perStorePages, base });
  if (base.state !== "unknown" || st.storeSelectNeed !== "required" || st.state !== "estimated") return { ...base, structure: st };
  // 実績が「店舗別独立」「通販のみ」などへ傾く系列は、構造の材料だけでは店舗選択式と推定しない（実績が割れているときも同様）
  if (base.priorUsed) return { ...base, structure: st };
  const kinds = new Set(st.signals.filter((s) => s.weight > 0).map((s) => s.code)).size;
  const conf: "medium" | "low" = kinds >= 3 ? "medium" : "low";
  return {
    state: "estimated",
    form: "store_select",
    rank: 4,
    confidence: conf,
    basis: [...st.basis, ...base.basis.slice(0, 1)],
    priorUsed: false,
    priorOverridden: false,
    action: !i.storeKnown && kinds >= 3 ? "apply" : "propose",
    structure: st,
  };
}

/**
 * 同じ抽選の複数の最終候補の判断から、表示・登録に使う判断を選ぶ（確認済み＞推定＞不明）。
 * 候補ごとに判断が記録されるため、表示される候補にだけ「記録なし」が出て、別の候補にある根拠が失われるのを防ぐ（9H-3Kで t-07・t-08 に発生）。
 * 食い違う確認済みの判断（店舗選択式と店舗別独立）が混在するときは選ばず null（確認が必要）。
 */
export function pickStrongestForm<T extends { state: string; form: string; rank?: number | null } | null | undefined>(list: T[]): T | null {
  const have = list.filter((x): x is NonNullable<T> => !!x && x.state !== "unknown");
  if (have.length === 0) return null;
  const confirmed = have.filter((x) => x.state === "confirmed");
  if (new Set(confirmed.map((x) => x.form)).size > 1) return null;
  const pool = confirmed.length > 0 ? confirmed : have;
  return pool.reduce((a, b) => ((b.rank ?? 9) < (a.rank ?? 9) ? b : a));
}
