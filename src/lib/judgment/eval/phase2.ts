/**
 * 第2段階（保存済み実原文の評価）の準備部品（Stage 10E 精度改善）。**純関数のみ。DB・ネットワーク・外部AIには接続しない**。
 * 実行（本番DBの読み取り・外部AIへの送信）は別途承認が必要で、ここでは**架空データだけ**で、抽出→伏せ字→漏洩検出→送信可否の流れをテストする。
 *  - 伏せ字: `redact`（キー・メール・電話・郵便番号つき住所）に加え、より厳しい漏洩検出（`detectLeaks`）を**伏せ字の後**にかける。
 *    検出が1件でもある原文は、自動では送らず「除外または人が修正」。さらに、**人が全件を目視確認した記録（reviewed）が無い原文は送信不可**。
 *  - 検出は漏れをゼロにする保証ではない（日本語の氏名・住所は規則で完全には拾えない）。だから人の全件確認を必須にする。
 */
import { redact } from "@/lib/case-model/redact";

export interface LeakFinding {
  kind: LeakKind;
  /** 見つかった箇所の短い抜粋（ログ・報告に原文全体を出さないため先頭数文字だけ） */
  sample: string;
}
export type LeakKind = "email" | "phone" | "postal_address" | "address_like" | "person_name_label" | "long_number" | "card_number" | "url_token" | "api_key" | "sns_handle" | "bearer_token" | "session_secret" | "credential_value" | "basic_auth_url" | "filled_personal_value";

/** 厳格な旧規則（Stage 10E〜10J）。比較・監査用に残す（送信判定には使わない）。項目名・住所らしき並び・SNSの名前などで、公開ページを過剰に除外していた */
const STRICT_RULES: [LeakKind, RegExp][] = [
  ["api_key", /sk-[A-Za-z0-9_-]{8,}|(?:api[_-]?key|token|secret|password)\s*[:=]\s*\S+/gi],
  ["email", /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g],
  ["postal_address", /〒\s?\d{3}-?\d{4}/g],
  ["phone", /(?<![\d-])0\d{1,4}-\d{1,4}-\d{3,4}(?![\d-])|(?<!\d)0[789]0\d{8}(?!\d)/g],
  ["card_number", /(?<!\d)(?:\d[ -]?){13,16}(?!\d)/g],
  ["long_number", /(?<![\d-])\d{9,12}(?![\d-])/g],
  ["address_like", /(?:東京都|北海道|(?:京都|大阪)府|[^\s]{2,3}県)[^\s]{1,8}[市区町村][^\s]{0,12}\d+[-−ー]\d+/g],
  ["person_name_label", /(?:お?名前|氏名|ご住所|お届け先|宛名|申込者|応募者名)\s*[:：]\s*\S+/g],
  ["url_token", /https?:\/\/[^\s]*[?&](?:token|key|sig|signature|auth|session|code|id)=[A-Za-z0-9_-]{8,}/gi],
  ["sns_handle", /(?<![A-Za-z0-9_])@[A-Za-z0-9_]{4,15}(?![A-Za-z0-9_.])/g],
];

export function detectLeaksStrict(text: string): LeakFinding[] {
  const out: LeakFinding[] = [];
  for (const [kind, re] of STRICT_RULES) for (const m of text.matchAll(re)) out.push({ kind, sample: `${m[0].slice(0, 6)}…` });
  return out;
}

/**
 * 送信を止める検出（Stage 10K）。**項目名（氏名・住所・メール・電話などの欄の名前）や、公開ページの定型の記載では除外しない**。止めるのは次の2種類だけ。
 *  1) 認証・秘密の**実値**: APIキー／Bearer・認証トークン／セッション・Cookieの値／資格情報（パスワードの値）／認証つきURL／トークンつきURL／有効なカード番号（Luhn）
 *  2) **実際に入力された私的な値**: 項目名のあとに実際の値（メール・電話・郵便番号と住所・氏名らしき値・注文番号などの番号）が続く場合。項目名だけ・空欄・「必須」「例」などの記載は対象外
 * メール・電話・郵便番号つきの住所の文字列そのものは、保存時の伏せ字（redact）で消える。店舗の公開の住所・SNSのアカウント名・数字の並びは、それだけでは除外しない。
 * 実秘密に当たるテストデータは、規則を満たす形で実行時に組み立てる（テストに本物の秘密を埋め込まない）。
 */
const PLACEHOLDER = /^(必須|任意|入力|ください|例|会員|氏名|お名前|姓|名|カナ|フリガナ|メール|住所|電話|なし|未入力|空欄|ー|-|＊|\*|〇|○|●|■|□|xxx|XXX|sample|サンプル|ここ)/;
const SECRET_RULES: [LeakKind, RegExp][] = [
  ["api_key", /\bsk-(?:ant-)?[A-Za-z0-9_-]{16,}|\b(?:AKIA|ASIA)[0-9A-Z]{16}\b|\bgh[pousr]_[A-Za-z0-9]{20,}|\bxox[abprs]-[A-Za-z0-9-]{10,}|\b(?:api[_-]?key|apikey|secret|client_secret)\s*[:=]\s*["']?[A-Za-z0-9_\-./+]{12,}/gi],
  ["bearer_token", /\bbearer\s+[A-Za-z0-9._~+/=-]{16,}|\bauthorization\s*[:=]\s*\S{12,}|\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/gi],
  ["session_secret", /\b(?:sessionid|session_id|phpsessid|jsessionid|sid|auth_token|access_token|refresh_token|id_token|csrf_?token|xsrf-token|set-cookie|cookie)\s*[:=]\s*["']?[A-Za-z0-9_\-./+%=]{12,}/gi],
  ["credential_value", /(?:\bpassword|\bpasswd|パスワード|暗証番号)\s*[:=：]\s*["']?[^\s"'*＊]{6,}/gi],
  ["basic_auth_url", /https?:\/\/[^/\s:@]+:[^/\s@]+@[^\s]+/gi],
  ["url_token", /https?:\/\/[^\s]*[?&](?:token|access_token|key|api_key|sig|signature|auth|session|sessionid|code)=[A-Za-z0-9_%\-.]{12,}/gi],
];
const FILLED_RULES: [string, RegExp][] = [
  ["email", /(?:メール(?:アドレス)?|e-?mail)\s*[:：]\s*[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/gi],
  ["phone", /(?:電話(?:番号)?|tel|携帯)\s*[:：]\s*0\d{1,4}-?\d{1,4}-?\d{3,4}/gi],
  ["postal", /(?:郵便番号|ご住所|住所)\s*[:：]\s*(?:〒\s?\d{3}-?\d{4}|(?:東京都|北海道|(?:京都|大阪)府|[^\s]{2,3}県)[^\s]{1,10}[市区町村][^\s]{0,14}\d+)/g],
  ["number", /(?:注文番号|応募番号|会員番号|予約番号|お客様番号|受付番号|整理番号)\s*[:：]?\s*[A-Za-z0-9-]{6,}/g],
];
const NAME_LABEL = /(?:お?名前|氏名|申込者|応募者名)\s*[:：]\s*([^\s]{2,12})/g;

const luhn = (digits: string): boolean => {
  let sum = 0;
  let dbl = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let d = Number(digits[i]);
    if (dbl) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
    dbl = !dbl;
  }
  return sum % 10 === 0;
};

export function detectLeaks(text: string): LeakFinding[] {
  const out: LeakFinding[] = [];
  for (const [kind, re] of SECRET_RULES) for (const m of text.matchAll(re)) out.push({ kind, sample: `${m[0].slice(0, 6)}…` });
  for (const m of text.matchAll(/(?<!\d)(?:\d[ -]?){13,19}(?!\d)/g)) {
    const d = m[0].replace(/\D/g, "");
    if (d.length >= 13 && d.length <= 19 && luhn(d)) out.push({ kind: "card_number", sample: `${m[0].slice(0, 6)}…` });
  }
  for (const [, re] of FILLED_RULES) for (const m of text.matchAll(re)) out.push({ kind: "filled_personal_value", sample: `${m[0].slice(0, 6)}…` });
  for (const m of text.matchAll(NAME_LABEL)) {
    const v = m[1];
    if (!PLACEHOLDER.test(v) && /[一-龥ぁ-んァ-ヶー]{2,}/.test(v)) out.push({ kind: "filled_personal_value", sample: `${m[0].slice(0, 6)}…` });
  }
  return out;
}

export interface StoredRow {
  /** 候補の識別子（collection_candidates.id）。外部へ送るときは使わず、連番へ置き換える */
  id: string;
  /** 層（抽出時に付ける分類: 例 store_select / per_store / per_product / multi / unfetchable / chain_name / deadline_change） */
  stratum: string;
  /** 保存された原文（last_good.evidence.text）。取得不能・未保存なら null */
  text: string | null;
  /** 取得の日時（新しいもの＝9Z導入後を優先） */
  fetchedAt: string | null;
  /** 公開告知かの機械確認に使う既存メタデータ（取得方法・情報元URL）。外部へは送らない */
  meta?: { via: string | null; url: string | null };
}

const PUBLIC_VIA = new Set(["x_api", "web_fetch", "x_oembed"]);
/** 公開告知（公開URLから取得した本文）だと、既存メタデータから機械的に確認できるか。判別できなければ false（送らない） */
export function isPublicNotice(meta: StoredRow["meta"]): boolean {
  if (!meta || !meta.via || !PUBLIC_VIA.has(meta.via) || !meta.url) return false;
  let u: URL;
  try {
    u = new URL(meta.url);
  } catch {
    return false;
  }
  if (u.protocol !== "https:" || u.username || u.password) return false;
  const h = u.hostname.toLowerCase();
  if (h === "localhost" || h.endsWith(".local") || h.endsWith(".internal") || /^[0-9.]+$/.test(h) || h.includes(":") || !h.includes(".")) return false;
  if (/[?&](?:token|key|sig|signature|auth|session|code|id)=/i.test(u.search)) return false;
  return true;
}

/** 層ごとに均等に近く選ぶ（上限 limit。既定30）。決定的（同じ入力なら同じ結果）。原文のない行は、検証不能の層として少数だけ許す */
export function selectStratified(rows: StoredRow[], limit = 30, maxNoText = 3): StoredRow[] {
  const strata = [...new Set(rows.map((r) => r.stratum))].sort();
  const byS = new Map(strata.map((s) => [s, rows.filter((r) => r.stratum === s).sort((a, b) => (b.fetchedAt ?? "").localeCompare(a.fetchedAt ?? "") || a.id.localeCompare(b.id))]));
  const picked: StoredRow[] = [];
  let noText = 0;
  for (let round = 0; picked.length < limit; round++) {
    let progressed = false;
    for (const s of strata) {
      const r = byS.get(s)![round];
      if (!r || picked.length >= limit) continue;
      progressed = true;
      if (r.text == null) {
        if (noText >= maxNoText) continue;
        noText++;
      }
      picked.push(r);
    }
    if (!progressed) break;
  }
  return picked;
}

export type PrepDecision = "ready" | "excluded_leak" | "excluded_no_text" | "excluded_not_public" | "needs_human_review";
export interface Prepared {
  /** 外部送信用の連番（元の識別子は含めない） */
  seq: number;
  stratum: string;
  decision: PrepDecision;
  /** 伏せ字後の本文（送信候補）。除外のときは null */
  text: string | null;
  findingsAfterRedact: LeakFinding["kind"][];
}

/** 抽出した行を、伏せ字→漏洩検出→送信可否へ。reviewedIds = 人が全文を目視確認して「送信してよい」とした元の識別子 */
export function prepareForExternal(rows: StoredRow[], reviewedIds: ReadonlySet<string>, opts: { requirePublic?: boolean } = {}): Prepared[] {
  return rows.map((r, i) => {
    const base = { seq: i + 1, stratum: r.stratum };
    if (r.text == null) return { ...base, decision: "excluded_no_text" as const, text: null, findingsAfterRedact: [] };
    const red = redact(r.text);
    const f = detectLeaks(red);
    if (f.length) return { ...base, decision: "excluded_leak" as const, text: null, findingsAfterRedact: [...new Set(f.map((x) => x.kind))] };
    if (opts.requirePublic && !isPublicNotice(r.meta)) return { ...base, decision: "excluded_not_public" as const, text: null, findingsAfterRedact: [] };
    if (!reviewedIds.has(r.id)) return { ...base, decision: "needs_human_review" as const, text: red, findingsAfterRedact: [] };
    return { ...base, decision: "ready" as const, text: red, findingsAfterRedact: [] };
  });
}

/** 送信してよい件だけ（ready）。1件でも ready でない原文は送らない */
export const sendable = (p: Prepared[]): Prepared[] => p.filter((x) => x.decision === "ready");

/**
 * 外部AIへの送信の最終関門。承認ゲート（A・B・C）が揃い、正解が固定済みで、送信対象がすべて「人の全件確認済み・漏洩なし」でなければ例外。
 * 1件でも ready でない原文があれば、全体を送らない（一部だけ黙って送らない）。ゲートの判定は `scripts/lib/phase2-extract.mjs` の `checkGates("send_external", …)` の結果を渡す。
 */
export function assertMaySend(gates: { ok: boolean; missing: string[] }, prepared: Prepared[], goldFrozen: boolean): Prepared[] {
  if (!gates.ok) throw new Error(`承認ゲート ${gates.missing.join("・")} が未承認のため、外部AIへ送信できません`);
  if (!goldFrozen) throw new Error("正解が固定されていないため、外部AIへ送信できません");
  const notReady = prepared.filter((p) => p.decision !== "ready");
  if (notReady.length) throw new Error(`送信不可の原文が ${notReady.length} 件あります（人の全件確認・漏洩検出の結果を解消するまで送信しません）`);
  if (!prepared.length) throw new Error("送信対象がありません");
  return sendable(prepared);
}

/**
 * 新旧比較（シャドー）の外部送信の関門。正解（gold）は要求しない（比較は「疑い」の差分を人が見る運用。正解率の断定にだけ gold が要る）。
 * ゲート未承認、または1件でも未確認・漏洩・原文なしがあれば全体を送らない。
 */
export function assertMaySendShadow(gates: { ok: boolean; missing: string[] }, prepared: Prepared[]): Prepared[] {
  if (!gates.ok) throw new Error(`承認ゲート ${gates.missing.join("・")} が未承認のため、外部AIへ送信できません`);
  const notReady = prepared.filter((p) => p.decision !== "ready");
  if (notReady.length) throw new Error(`送信不可の原文が ${notReady.length} 件あります（人の全件確認・漏洩検出の結果を解消するまで送信しません）`);
  if (!prepared.length) throw new Error("送信対象がありません");
  return sendable(prepared);
}
