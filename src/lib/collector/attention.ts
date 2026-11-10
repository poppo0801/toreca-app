/**
 * 注意付き自動登録（Stage 7A・純関数）。
 * 収集した候補を A（十分な情報＝通常登録）／B（情報不足・軽微な矛盾＝注意付きで登録）／C（抽選として成立するか判断できない＝確認待ち）に分ける。
 * ここでの A/B/C は「登録の可否」で、既存の情報充実度 A〜E（completeness.ts）とは別の軸。充実度は不足項目の判定（missing）として共有し、重複して判定しない。
 *
 * 方針: 応募機会を見落とさないことを優先する。不足・軽微な矛盾は注意として構造化して保持し、注意付きで登録する。
 * ただし、誤った抽選への誘導・重複登録を防ぐため、次の場合は確認待ちに残す:
 *   系列/商品が特定できない／情報源がない／同一抽選か別抽選か判断できない／系列・店舗・商品の矛盾／締切が不明（抽選として成立するか不明）
 * 不明な情報は不明のまま保持する（推測で埋めない）。
 */
import { conflictLabels, FIELD_LABEL, type FieldKey, type FieldMap } from "@/lib/collector/fields";
import type { LotteryStage } from "@/lib/collector/stage";
import type { LotteryInput } from "@/lib/lottery-input";

export type CautionField = "resultDate" | "applyDeadline" | "receivePeriod" | "conditions" | "applyMethod" | "store" | "region" | "receiveMethod" | "mode" | "dates" | "other";

export interface Caution {
  /** 安定した識別子（自動補完・解除のキー） */
  code: string;
  field: CautionField;
  /** 利用者向けの文言（詳細画面） */
  message: string;
  /** 食い違う値など（「11/10」「11/12」） */
  values?: string[];
  /** 注意を付けた日時（ISO） */
  at: string;
  /** 利用者が「確認済みにする」で解除した日時（ISO）。解除した注意は、同じ内容では再表示しない */
  ackAt?: string;
}

/**
 * 抽選管理の対象外の矛盾か（金額・料金の表示差など）。
 * チケットサイトの「0円」と本文の「税込891円」のような差は、サイトの表示仕様による違いで、抽選情報の矛盾ではない。
 * 応募期間・当選発表・応募条件・受取など、抽選管理に必要な項目に触れている矛盾は対象外にしない。
 */
export function isUnmanagedConflict(text: string | null | undefined): boolean {
  if (!text) return false;
  const price = /金額|価格|料金|値段|税込|税抜|\d+\s*円|0円|チケット(サイト|ページ)?の?(表示|価格|金額)|販売価格|手数料/.test(text);
  if (!price) return false;
  const managed = /応募(期間|期限|締切|開始|方法|条件)|締切|締め切り|当選(発表|日)|発表日|抽選(日|結果)|受取|購入期間|引換|引き換え|受付|開始日|終了日|日時|日付|店舗|対象商品|商品名|別の抽選|抽選(では|ではない)/.test(text);
  return !managed;
}

/** 信頼度（内部管理）。利用者向けには、注意が必要なときの小さな印だけを出す */
export type Confidence = "official" | "multi_source" | "single_source" | "partial" | "conflict";
export const CONFIDENCE_LABEL: Record<Confidence, string> = { official: "公式情報で確認済み", multi_source: "複数の情報源で確認済み", single_source: "単一の情報源", partial: "一部情報不足", conflict: "情報に矛盾あり" };

/** 店舗を特定できない抽選に使う仮の店舗名（応募前に利用者が確認する。マスターの店舗として確定しない） */
export const UNCONFIRMED_STORE = "店舗未確認";

export type Grade = "A" | "B" | "C";
export interface RegistrationDecision {
  grade: Grade;
  cautions: Caution[];
  /** 確認待ちに残す理由（grade=C のとき） */
  blockers: string[];
  confidence: Confidence;
  /** 登録前に入力へ反映する補正（店舗が特定できないときの仮の店舗・店舗選択式） */
  patch: { store?: { id: string | null; name: string; prefecture: string }; storeMode?: "select_on_apply"; noteStoreSelect?: boolean } | null;
}

export interface RegistrationContext {
  input: LotteryInput;
  verdict: "match" | "review" | "exclude" | "upcoming";
  verdictReasons: string[];
  /** isReady の不足（登録に必要な確認が済んでいない点） */
  missing: string[];
  fields: FieldMap;
  /** 同一抽選かもしれない候補（high 以外）の件数 */
  duplicateCount: number;
  stage: LotteryStage;
  modePending: boolean;
  /** 本文・画像の読み取りの矛盾（AI の注意文） */
  textConflict?: string | null;
  /** 系列マスターの「店舗選択式を基本とする」 */
  chainStoreSelectDefault?: boolean;
  /** 店舗が特定できているか（マスター照合済み、または明確な仮登録、オンライン、選択式） */
  storeResolved: boolean;
  now: string;
}

const md = (iso: string) => {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
  return m ? `${Number(m[2])}/${Number(m[3])}` : iso;
};
const flexDate = (f?: { precision: string; date?: string | null }) => (f && f.precision !== "unknown" && f.date ? f.date : "");

/** 項目別の矛盾の注意文（採用した値と、食い違う値を両方示す。応募締切は早い方を暫定採用） */
function conflictCautions(fields: FieldMap, now: string): { cautions: Caution[]; blockers: string[] } {
  const cautions: Caution[] = [];
  const blockers: string[] = [];
  for (const k of Object.keys(FIELD_LABEL) as FieldKey[]) {
    const p = fields[k];
    if (p?.state !== "conflict" || !p.alt) continue;
    const label = FIELD_LABEL[k];
    if (k === "chain" || k === "store" || k === "items") {
      blockers.push(`${label}の情報源が食い違っています（${p.value} / ${p.alt.value}）`);
      continue;
    }
    if (k === "applyDeadline") {
      const a = p.value.slice(0, 10);
      const b = p.alt.value.slice(0, 10);
      const gap = Math.abs(Date.parse(a) - Date.parse(b)) / 86_400_000;
      if (!Number.isFinite(gap) || gap > 14) {
        blockers.push(`応募締切が大きく食い違っています（${md(a)} / ${md(b)}）。別の抽選の可能性があります`);
        continue;
      }
      const early = a <= b ? a : b;
      const late = a <= b ? b : a;
      cautions.push({ code: "deadline_conflict", field: "applyDeadline", message: `締切情報に相違があります。${md(early)}と${md(late)}の情報が確認されています（早い方の${md(early)}を暫定表示しています）`, values: [md(early), md(late)], at: now });
      continue;
    }
    cautions.push({ code: `conflict_${k}`, field: k === "resultDate" ? "resultDate" : k === "applyMethod" ? "applyMethod" : k === "receiveMethod" ? "receiveMethod" : "dates", message: `${label}に相違があります（${p.value.slice(0, 40)} / ${p.alt.value.slice(0, 40)}）。確認できるまで採用中の値は暫定です`, values: [p.value.slice(0, 40), p.alt.value.slice(0, 40)], at: now });
  }
  return { cautions, blockers };
}

/** 抽選として成立するか自体に重大な矛盾があるか（別の抽選・抽選ではない 等） */
const SERIOUS_TEXT_CONFLICT = /抽選(では|で は)?(ない|なく)|別(の)?(抽選|商品|店舗)|同一(の)?抽選か|抽選の存在/;

/**
 * 収集した候補を A/B/C に判定する。
 *  A: 不足も矛盾もない（通常の抽選として登録）
 *  B: 不足・軽微な矛盾があるが、応募機会を把握できる（注意付きで登録）
 *  C: 抽選として成立するか判断できない・誤登録の危険が高い（確認待ち）
 */
export function decideRegistration(c: RegistrationContext): RegistrationDecision {
  const { input } = c;
  // 抽選管理の対象外（金額の表示差など）の矛盾は、矛盾として扱わない
  if (isUnmanagedConflict(c.textConflict)) c = { ...c, textConflict: null };
  const blockers: string[] = [];
  const cautions: Caution[] = [];
  let patch: RegistrationDecision["patch"] = null;
  const miss = c.missing.join("／");

  // ---- C: 確認待ちに残す条件
  if (c.verdict === "exclude") blockers.push("収集条件の対象外です");
  if (/系列を確実に特定できません/.test(miss)) blockers.push("系列を特定できません");
  if (/商品.*(確実に判別できません|マスターに未登録)|商品マスターに未登録/.test(miss)) blockers.push(/未登録/.test(miss) ? "商品がマスターに未登録です（商品の確認が必要）" : "対象商品を特定できません");
  if (/情報源URLがありません/.test(miss)) blockers.push("情報源（確認できるURL）がありません");
  if (c.verdictReasons.some((r) => /指定商品か判断できません/.test(r))) blockers.push("商品を判別できず、収集対象の商品か判断できません");
  if (c.duplicateCount > 0) blockers.push("同じ抽選か別の抽選か判断できません（重複の疑い）");
  if (c.stage === "teaser" || c.stage === "partial") blockers.push("応募の日時が未発表です（抽選予告として追跡します）");
  else if (c.verdict === "upcoming") blockers.push("受付前です（受付が始まるまで追跡します）");
  else if (input.applyDeadline.precision === "unknown") blockers.push("応募締切が不明です");
  if (c.textConflict && SERIOUS_TEXT_CONFLICT.test(c.textConflict)) blockers.push(`抽選の内容に重大な矛盾があります: ${c.textConflict.slice(0, 60)}`);
  const cf = conflictCautions(c.fields, c.now);
  blockers.push(...cf.blockers);
  if (blockers.length > 0) return { grade: "C", cautions: [], blockers: [...new Set(blockers)], confidence: "partial", patch: null };

  // ---- B: 注意付きで登録する
  cautions.push(...cf.cautions);
  if (c.textConflict && !cf.cautions.some((x) => x.field === "applyDeadline")) cautions.push({ code: "text_conflict", field: "other", message: `情報に矛盾の疑いがあります: ${c.textConflict.slice(0, 80)}`, at: c.now });
  if (!flexDate(input.resultDate)) cautions.push({ code: "result_date_unknown", field: "resultDate", message: "当選発表日が確認できていません", at: c.now });
  const hasReceive = !!flexDate(input.receiveStart) || !!flexDate(input.receiveDeadline) || !!flexDate(input.procedureStart) || !!flexDate(input.procedureDeadline);
  if (!hasReceive) cautions.push({ code: "receive_period_unknown", field: "receivePeriod", message: "購入・受取期間が確認できていません", at: c.now });
  if (input.receiveMethod === "unknown") cautions.push({ code: "receive_method_unknown", field: "receiveMethod", message: "受取方法（店頭・発送）が確認できていません", at: c.now });
  if (!input.applyMethod || input.applyMethod === "unknown") cautions.push({ code: "apply_method_unclear", field: "applyMethod", message: "応募方法の説明が不足しています。情報元で確認してください", at: c.now });
  if (!input.conditionsText?.trim() && (input.requirementTags ?? []).length === 0) cautions.push({ code: "conditions_unknown", field: "conditions", message: "応募条件が確認できていません", at: c.now });
  for (const r of c.verdictReasons) {
    if (/対象地域（都道府県）が不明|店舗の位置が未設定/.test(r)) cautions.push({ code: "region_unconfirmed", field: "region", message: "店舗の地域が確認できていません（対象地域かどうかは未確認です）", at: c.now });
    if (/居住地域の制限/.test(r)) cautions.push({ code: "resident_area", field: "conditions", message: "居住地域の制限があります。応募できる地域を確認してください", at: c.now });
  }
  if (c.modePending) cautions.push({ code: "mode_unconfirmed", field: "mode", message: "複数商品の応募方式が確認できていません（全商品を対象として登録しています）", at: c.now });
  // 店舗: 特定できないときは、系列の設定（店舗選択式を基本とする）に従って店舗選択式として登録する。設定がなければ仮の店舗名で登録する（店舗を推測しない）
  if (!c.storeResolved) {
    if (c.chainStoreSelectDefault) {
      patch = { storeMode: "select_on_apply", noteStoreSelect: true };
      cautions.push({ code: "store_select_assumed", field: "store", message: "受取店舗が確定していません。この系列は応募時に店舗を選ぶ抽選が多いため、店舗選択式として登録しています（告知で確認してください）", at: c.now });
    } else {
      // 架空の店舗（「店舗未確認」など）は作らない。店舗は未設定のまま登録し、不足情報（注意）として残す
      patch = { store: { id: null, name: "", prefecture: "" } };
      cautions.push({ code: "store_unconfirmed", field: "store", message: "受取店舗が確定していません", at: c.now });
    }
  }
  // 受取方法・地域など、補助情報だけの不足は注意の数を増やしすぎないよう、同じ項目の重複を除く
  const uniq = [...new Map(cautions.map((x) => [x.code, x])).values()];
  const grade: Grade = uniq.length > 0 ? "B" : "A";
  const kept = uniq;
  const hasConflict = kept.some((x) => x.code.startsWith("conflict_") || x.code === "deadline_conflict" || x.code === "text_conflict");
  return { grade, cautions: kept, blockers: [], confidence: confidenceOf(c.fields, kept.length > 0, hasConflict), patch };
}

/** 信頼度。矛盾あり > 注意あり（一部情報不足）> 公式で確認済み > 複数の独立した情報源 > 単一の情報源 */
export function confidenceOf(fields: FieldMap, hasCautions: boolean, hasConflict: boolean): Confidence {
  if (hasConflict || conflictLabels(fields).length > 0) return "conflict";
  if (hasCautions) return "partial";
  const ps = Object.values(fields).filter(Boolean);
  if (ps.some((p) => p?.state === "confirmed" && (p.source.kind === "official_site" || p.source.kind === "official_x"))) return "official";
  const origins = new Set(ps.flatMap((p) => p?.origins ?? []));
  return origins.size >= 2 ? "multi_source" : "single_source";
}

/** 注意付きカードの要約（一覧のアイコンのツールチップ・詳細の見出し用）。注意が無ければ空 */
export function cautionSummary(cautions: Caution[] | undefined | null): string {
  const cs = cautions ?? [];
  if (cs.length === 0) return "";
  return cs.slice(0, 3).map((x) => x.message.replace(/（.*$/, "")).join(" ／ ");
}
