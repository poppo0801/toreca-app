/**
 * LivePocket の応募ページの構造解析（Stage 9H-3G・純関数。ネットワークに触れない）。
 * 入力は、公開されているページの本文（利用者が応募操作をしなくても読める部分）。ログイン・応募確定が必要な部分は読まない。
 *
 * 目的: LivePocket の抽選が
 *   A 店舗選択式   … 1回の応募で受取店舗を選ぶ／店舗をまたぐ応募が制限され、同一企画として扱う根拠がある
 *   B 店舗別独立   … 店舗ごとに応募受付・期間・当選処理が独立している
 *   C 不明         … 情報不足でA・Bを判断できない
 * のどれかを、文面の単語ではなく「ページの構造」（チケット種別・申込フォームの説明・対象店舗の一覧・受取の指定方法・応募の制限）の組み合わせで判定する。
 * 「複数店舗への応募禁止」の文言だけでは店舗選択式と断定しない（C）。企画の共通性（同じ商品・同じ期間のチケットが複数店舗に並ぶ）などの構造が伴うときだけ A にする。
 * 外部の文面はデータとして扱い、命令は実行しない。
 */
import { FORM_PATTERNS } from "@/lib/lottery-form";

export type LivePocketClass = "A" | "B" | "C" | "conflict";

export interface LivePocketStructure {
  klass: LivePocketClass;
  confidence: "high" | "medium" | "low";
  reasons: string[];
  /** 調査した項目ごとの結果 */
  items: {
    /** 主催者本文を読めたか（呼び出し側が、主催者の同一性を確認できたかを渡す） */
    organizerBody: boolean;
    ticketTypes: string[];
    targetStores: string[];
    formDescription: boolean;
    storeSelectField: boolean;
    crossStoreLimit: boolean;
    receiveInstruction: string | null;
    conditions: string[];
  };
  /** 確認できなかった項目（再調査・人の確認の手がかり） */
  missing: string[];
  /** 判定の根拠にした本文の抜粋（A/Bのとき。ページの本文にそのまま書かれた部分。台帳の根拠に使う） */
  quote: string | null;
}

const norm = (s: string): string => s.normalize("NFKC");
const STORE_LIKE = /([^\s、,・／/|｜（）()【】「」]{2,24}?(?:店|ストア|STORE|Store))(?![ぁ-んァ-ヶ一-龥])/;
const PRICE = /[¥￥]\s*[\d,]+|[\d,]+\s*円/;
const MIN_STORES = 2;

/** 「対象店舗」「受取店舗」などの見出しの後ろの店舗名を拾う */
function storesAfterLabel(text: string): string[] {
  const out: string[] = [];
  const re = /(対象店舗|参加店舗|実施店舗|受取店舗|お受取り?店舗|受け取り店舗|対象の店舗)[:：\s]*([^\n]{0,400}(?:\n(?![A-Za-z0-9ぁ-んァ-ヶ一-龥]{0,6}[:：])[^\n]{0,200}){0,8})/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    for (const part of m[2].split(/[、,，・\n/／|｜]+/)) {
      const t = part.replace(/^[\s・●○◆■□▼▽※-]+|[\s]+$/g, "").trim();
      const sm = STORE_LIKE.exec(t);
      if (sm && t.length <= 30) out.push(sm[1]);
    }
  }
  return out;
}

/** チケット種別（店舗名つき・価格つきの行）を拾う */
function ticketLines(text: string): string[] {
  const out: string[] = [];
  for (const line of text.split(/\n/)) {
    const t = line.trim();
    if (!t || t.length > 80) continue;
    if (STORE_LIKE.test(t) && (PRICE.test(t) || /チケット|枚|席|応募枠/.test(t))) out.push(t);
  }
  return out;
}

/** 本文中で最初に一致した文面の前後を含む抜粋 */
function excerpt(text: string, res: RegExp[]): string | null {
  for (const re of res) {
    const m = re.exec(text);
    if (m) return text.slice(Math.max(0, m.index - 8), Math.min(text.length, m.index + m[0].length + 24)).replace(/\s+/g, " ").trim().slice(0, 120);
  }
  return null;
}
const uniq = <T,>(a: T[]): T[] => [...new Set(a)];
const storeKey = (s: string) => norm(s).replace(/\s+/g, "").toLowerCase();

export function analyzeLivePocket(input: { text: string; organizerVerified?: boolean }): LivePocketStructure {
  const text = norm(input.text ?? "");
  const tickets = ticketLines(text);
  const ticketStores = uniq(tickets.map((t) => STORE_LIKE.exec(t)?.[1] ?? "").filter(Boolean).map(storeKey));
  const labelled = uniq(storesAfterLabel(text).map(storeKey));
  const targetStores = uniq([...labelled, ...ticketStores]);
  const selectField = FORM_PATTERNS.SELECT_FIELD.some((re) => re.test(text)) || /チケット(種別|の種類)?を?(選択|お選び)|受取店舗を(?:チケット|選択)/.test(text);
  const crossLimit = FORM_PATTERNS.CROSS_STORE_LIMIT.some((re) => re.test(text));
  const perStore = FORM_PATTERNS.PER_STORE.some((re) => re.test(text)) || /他店舗(への|も)?(応募|エントリー).{0,6}(可|できます|OK|大丈夫)|店舗ごとに.{0,8}(期間|当選|発表)/.test(text);
  const formDescription = /(応募|申込|申し込み|エントリー)(フォーム|方法|手順|の流れ)/.test(text);
  const receive = /((?:受取|お受取り|引取|引き取り|お渡し)[^\n]{0,60})/.exec(text)?.[1]?.trim() ?? null;
  const conditions = uniq((text.match(/[^\n。]{4,60}(?:必要|限り|のみ|不可|無効|までに)[^\n。]{0,30}/g) ?? []).map((s) => s.trim())).slice(0, 8);

  const storeTickets = ticketStores.length >= MIN_STORES;
  const reasons: string[] = [];
  const missing: string[] = [];
  if (!input.organizerVerified) missing.push("主催者本文（主催者の同一性を確認できていない）");
  if (targetStores.length === 0) missing.push("対象店舗の一覧");
  if (!formDescription) missing.push("申込フォームの説明");
  if (!receive) missing.push("受取店舗の指定方法");

  const items = { organizerBody: !!input.organizerVerified, ticketTypes: tickets.slice(0, 12), targetStores: targetStores.slice(0, 40), formDescription, storeSelectField: selectField, crossStoreLimit: crossLimit, receiveInstruction: receive, conditions };

  const selectStructure = selectField || (storeTickets && crossLimit);
  if (selectStructure && perStore) {
    return { klass: "conflict", confidence: "low", reasons: ["店舗を選ぶ構造と、店舗ごとに独立して受付する記載の両方がある（人の確認が必要）"], items, missing, quote: null };
  }
  if (selectStructure) {
    if (selectField) reasons.push("応募時に店舗（または店舗別のチケット）を選ぶ旨の記載がある");
    if (storeTickets) reasons.push(`同じ企画のチケット種別に${ticketStores.length}店舗が並んでいる`);
    if (crossLimit) reasons.push("店舗をまたぐ応募が制限されている（同一企画として扱う根拠）");
    const strong = (selectField && (storeTickets || targetStores.length >= MIN_STORES)) || (storeTickets && crossLimit);
    return { klass: "A", confidence: strong ? "high" : "medium", reasons, items, missing, quote: excerpt(text, [...FORM_PATTERNS.SELECT_FIELD, ...FORM_PATTERNS.CROSS_STORE_LIMIT]) };
  }
  if (perStore) {
    reasons.push("店舗ごとの受付・期間・当選処理が独立している旨の記載がある");
    if (crossLimit) reasons.push("店舗をまたぐ制限の記載もあるが、受付が店舗ごとに独立している記載を優先した");
    return { klass: "B", confidence: crossLimit ? "low" : "medium", reasons, items, missing, quote: excerpt(text, FORM_PATTERNS.PER_STORE) };
  }
  // 構造の根拠が無い
  if (crossLimit) reasons.push("店舗をまたぐ応募の制限の記載はあるが、店舗選択欄・店舗別チケットなどの構造が確認できない（制限だけでは店舗選択式と断定しない）");
  else if (storeTickets) reasons.push(`チケット種別に${ticketStores.length}店舗が並ぶが、応募の制限・選択欄の記載が無く、店舗選択式か店舗別かを判断できない`);
  else reasons.push("店舗選択式か店舗別独立かを判断できる構造の記載を確認できない");
  return { klass: "C", confidence: "low", reasons, items, missing, quote: null };
}

/** 調査エージェントに渡す、LivePocketで確認する項目のリスト（調査の指示文に添える。確認できた範囲だけ報告させる） */
export const LIVEPOCKET_CHECKLIST: readonly string[] = [
  "主催者本文（主催者の同一性を確認できたページか）",
  "チケット種別（店舗別に分かれているか・同じ商品／期間か）",
  "申込フォームの説明（店舗や受取方法を選ぶ欄があるか）",
  "応募条件",
  "対象店舗の一覧",
  "店舗選択の有無（応募時に1店舗を選ぶか）",
  "複数店舗への応募制限（制限だけでは店舗選択式と断定しない）",
  "受取店舗の指定方法",
];
