import type { ExtractedFlex, ExtractedLottery } from "@/lib/ai/extraction";
import type { FlexInput, LotteryInput } from "@/lib/lottery-input";
import { normName } from "@/lib/norm";

/**
 * AI解析結果と、利用者が確認して保存した最終内容の比較（登録時に1回だけ記録する）。
 *
 * 項目ごとの結果:
 *   adopted      AIの抽出結果をそのまま採用
 *   modified     AIが抽出した値を、利用者が変更（または削除）した
 *   supplemented AIが未抽出だった項目を、利用者が補完した
 *   normalized   AIの値が、マスター照合で正式名称などに正規化され、利用者はその正規化後の値を採用した
 * 「変更した」ことだけで、AIの誤認識とは断定しない。誤認識として数えるのは、利用者が理由として「AIの読み取りが間違っていた」を
 * 明示した項目だけ（explicit）。登録後の通常編集はここでは扱わない（初回登録時だけ比べる）。
 */

export const FEEDBACK_FIELDS = [
  "chain",
  "store",
  "items",
  "multiMode",
  "applyStart",
  "applyDeadline",
  "resultDate",
  "procedureDeadline",
  "applyMethod",
  "receiveMethod",
  "limit",
  "announcementMethod",
  "announcementUrl",
  "conditions",
  "verification",
] as const;
export type FeedbackField = (typeof FEEDBACK_FIELDS)[number];

export type FieldStatus = "adopted" | "modified" | "supplemented" | "normalized";
export const FEEDBACK_REASONS = ["ai_wrong", "other_source", "official_name", "other"] as const;
export type FeedbackReason = (typeof FEEDBACK_REASONS)[number];

export const REASON_LABEL: Record<FeedbackReason, string> = {
  ai_wrong: "AIの読み取りが間違っていた",
  other_source: "別の情報源で補完した",
  official_name: "正式名称へ変更した",
  other: "その他",
};

export interface FieldResult {
  status: FieldStatus;
  /** 利用者が選んだ理由（修正・補完した項目だけ） */
  reason?: FeedbackReason;
  /** 利用者が「AIの読み取りが間違っていた」と明示した */
  explicit?: boolean;
  ai?: unknown;
  final?: unknown;
}

export type Snapshot = Record<FeedbackField, unknown>;

const s = (v: string | undefined | null) => (v ?? "").normalize("NFKC").replace(/\s+/g, " ").trim();
const flexOf = (f: { precision: string; date: string; time: string }) => (f.precision === "unknown" ? null : { p: f.precision, d: f.date, t: f.precision === "date_time" ? f.time : "" });

/** AIの抽出結果（検証済み）→ 比較用の値 */
export function aiSnapshot(ex: ExtractedLottery): Snapshot {
  const fx = (f: ExtractedFlex) => flexOf(f);
  return {
    chain: s(ex.chainName) || null,
    store: s(ex.storeName) || null,
    items: ex.items.length ? ex.items.map((i) => ({ n: s(i.name), q: i.quantity, u: i.unit })) : null,
    // 方式は複数商品のときだけ意味がある（フォームの値と同じ基準にそろえる）
    multiMode: ex.items.length > 1 && ex.multiMode !== "unknown" ? ex.multiMode : null,
    applyStart: fx(ex.applyStart),
    applyDeadline: fx(ex.applyDeadline),
    resultDate: fx(ex.resultDate),
    procedureDeadline: fx(ex.procedureDeadline),
    applyMethod: ex.applyMethod === "unknown" ? null : ex.applyMethod,
    receiveMethod: ex.receiveMethod === "unknown" ? null : ex.receiveMethod,
    limit: ex.limitBasis === "unknown" ? null : { b: ex.limitBasis, m: ex.limitMaxCount ?? 1 },
    announcementMethod: s(ex.announcementMethod) || null,
    announcementUrl: ex.announcementUrl || null,
    conditions: s(ex.conditionsText) || null,
    verification: s(ex.verificationText) || null,
  };
}

const flexInput = (f: FlexInput | undefined) => (!f || f.precision === "unknown" ? null : { p: f.precision, d: f.date, t: f.precision === "date_time" ? f.time : "" });

/** フォームの入力値 → 比較用の値（マスター照合後の下書き、または最終保存内容に使う） */
export function inputSnapshot(i: LotteryInput): Snapshot {
  const items = (i.items ?? []).filter((it) => (it.product.name ?? "").trim() !== "");
  return {
    chain: s(i.chain.name) || null,
    store: s(i.store.name) || null,
    items: items.length ? items.map((it) => ({ n: s(it.product.name), q: it.quantity, u: it.unit })) : null,
    multiMode: items.length > 1 ? (i.multiMode ?? "single") : null,
    applyStart: flexInput(i.applyStart),
    applyDeadline: flexInput(i.applyDeadline),
    resultDate: flexInput(i.resultDate),
    procedureDeadline: flexInput(i.procedureDeadline),
    // 初期値のまま（利用者が確認していない）の応募方法・受取方法は、利用者の補完としては数えない
    applyMethod: i.applyMethod === "unknown" || i.unconfirmedFields?.includes("applyMethod") ? null : i.applyMethod,
    receiveMethod: i.receiveMethod === "unknown" || i.unconfirmedFields?.includes("receiveMethod") ? null : i.receiveMethod,
    limit: i.limitBasis === "unknown" ? null : { b: i.limitBasis, m: i.limitMaxCount ?? 1 },
    announcementMethod: s(i.announcementMethod) || null,
    announcementUrl: i.announcementUrl || null,
    conditions: s(i.conditionsText) || null,
    verification: s(i.verificationText) || null,
  };
}

/** 値の同一性（文字列は表記の揺れ（全角半角・空白・大文字小文字）を無視する） */
function same(a: unknown, b: unknown): boolean {
  if (a === null || b === null) return a === b;
  if (typeof a === "string" && typeof b === "string") return normName(a) === normName(b);
  if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((x, i) => same(x, b[i]));
  if (typeof a === "object" && typeof b === "object") {
    const ka = Object.keys(a as object);
    const kb = Object.keys(b as object);
    return ka.length === kb.length && ka.every((k) => same((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]));
  }
  return a === b;
}

export interface FeedbackResult {
  fields: Partial<Record<FeedbackField, FieldResult>>;
  adopted: number;
  modified: number;
  supplemented: number;
  normalized: number;
  explicitError: number;
}

/**
 * @param ai      AIの最初の抽出結果
 * @param filled  マスター照合・正規化後にフォームへ入力された値（利用者が触る前）
 * @param final   利用者が確認して保存した最終内容
 * @param reason  任意の修正理由（修正・補完した項目に付く）
 */
export function compareFeedback(ai: Snapshot, filled: Snapshot, final: Snapshot, reason: FeedbackReason | null): FeedbackResult {
  const fields: FeedbackResult["fields"] = {};
  const out: FeedbackResult = { fields, adopted: 0, modified: 0, supplemented: 0, normalized: 0, explicitError: 0 };
  for (const f of FEEDBACK_FIELDS) {
    const a = ai[f];
    const d = filled[f];
    const z = final[f];
    if (a === null && z === null) continue; // AIも最終も空: 比べる対象がない
    let r: FieldResult;
    if (same(a, z)) r = { status: "adopted" };
    // AIが出していない値を、アプリ側（マスター照合など）が補い、利用者がそのまま採用した → 利用者の補完ではなく正規化
    else if (a === null && d !== null && same(d, z)) r = { status: "normalized", ai: a, final: z };
    else if (a === null) r = { status: "supplemented", ai: a, final: z };
    else if (same(d, z) && !same(a, d)) r = { status: "normalized", ai: a, final: z };
    else r = { status: "modified", ai: a, final: z };
    if ((r.status === "modified" || r.status === "supplemented") && reason) {
      r.reason = reason;
      // 誤認識として数えるのは、利用者が「AIの読み取りが間違っていた」を選び、AIが値を出していて変更された項目だけ
      if (reason === "ai_wrong" && r.status === "modified") r.explicit = true;
    }
    fields[f] = r;
    if (r.status === "adopted") out.adopted++;
    else if (r.status === "modified") out.modified++;
    else if (r.status === "supplemented") out.supplemented++;
    else out.normalized++;
    if (r.explicit) out.explicitError++;
  }
  return out;
}
