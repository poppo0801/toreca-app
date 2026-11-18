/**
 * 既存の抽出結果・登録入力 → 案件ファイル（Stage 9H-3B・純関数）。
 * 通常の収集の各段階（AIの読み取り直後／固定ロジックを通った最終の登録入力）を同じ構造で表し、段階間の差分を判断履歴にする。
 */
import type { ExtractedFlex, ExtractedLottery } from "@/lib/ai/extraction";
import type { LotteryInput } from "@/lib/lottery-input";
import { CASE_FIELD_KEYS, emptyCase, type Actor, type CaseFile, type CaseFieldKey, type CaseFieldState, type EvidenceRef } from "./types";

export const flexToStr = (f: { precision: string; date: string; time: string } | null | undefined): string | null => {
  if (!f || f.precision === "unknown" || !f.date) return null;
  return f.precision === "date_time" && f.time ? `${f.date} ${f.time}` : f.date;
};

const UNIT_TO_FORM: Record<string, string> = { store_select: "store_select", store_independent: "store_independent", single: "other", per_product: "other" };

function setField(c: CaseFile, k: CaseFieldKey, value: string | null | undefined, by: Actor, state: CaseFieldState, evidence: EvidenceRef[] = [], note?: string): void {
  const v = (value ?? "").trim();
  if (!v) return;
  c.fields[k] = { value: v, state, by, evidence, alternatives: [], ...(note ? { note } : {}) };
}

export interface SourceCtx {
  url: string;
  at: string;
  kind?: string;
  tier?: "primary" | "secondary";
  basis?: "organizer_body" | "platform_meta";
}

/** AIの読み取り直後の案件ファイル（固定ロジックを通る前）。AIの読み取りは「推定」（根拠の抜粋が原文に実在すれば推定、しなければ未確認） */
export function caseFromExtraction(ex: ExtractedLottery, id: string, src: SourceCtx): CaseFile {
  const c = emptyCase(id, src.at);
  c.sources.push({ url: src.url, kind: src.kind ?? "unknown", tier: src.tier ?? "secondary", status: "used", fetchedAt: src.at });
  const ev = (k: keyof ExtractedLottery["evidence"]): EvidenceRef[] => {
    const e = ex.evidence[k];
    return e?.quote ? [{ url: src.url, quote: e.quote.slice(0, 200), kind: src.kind, tier: src.tier, basis: src.basis, at: src.at }] : [];
  };
  const st = (k: keyof ExtractedLottery["evidence"], value: string | null): CaseFieldState => (value ? (ex.evidence[k]?.verified === false ? "unverified" : "inferred") : "missing");
  const put = (k: CaseFieldKey, value: string | null, ek?: keyof ExtractedLottery["evidence"]) => setField(c, k, value, "ai", ek ? st(ek, value) : value ? "inferred" : "missing", ek ? ev(ek) : []);
  put("chain", ex.chainName, "chain");
  put("store", ex.storeName, "store");
  put("form", ex.applyUnit ? (UNIT_TO_FORM[ex.applyUnit] ?? null) : null);
  put("selectableStores", (ex.selectableStoreNames ?? []).join(" / "));
  put("items", ex.items.map((i) => i.name).join(" / "), "items");
  put("applyStart", flexToStr(ex.applyStart), "applyStart");
  put("applyDeadline", flexToStr(ex.applyDeadline), "applyDeadline");
  put("resultStart", flexToStr(ex.resultDate), "resultDate");
  put("resultEnd", ex.resultEndDate || null, "resultDate");
  put("applyMethod", ex.applyMethod === "unknown" ? null : ex.applyMethod, "applyMethod");
  put("conditions", ex.conditionsText, "conditions");
  put("applyUrl", ex.applyUrl);
  put("receiveMethod", ex.receiveMethod === "unknown" ? null : ex.receiveMethod, "receiveMethod");
  return c;
}

/** 固定ロジックを通った最終の登録入力 → 案件ファイル（登録候補の内容）。by は値を決めた段階（既定は固定） */
export function caseFromInput(input: LotteryInput, id: string, at: string, by: Actor = "fixed", applyUrlHint?: string): CaseFile {
  const c = emptyCase(id, at);
  const put = (k: CaseFieldKey, v: string | null) => setField(c, k, v, by, v ? "inferred" : "missing");
  put("chain", input.chain.name);
  const selectMode = input.storeMode === "select_on_apply";
  put("store", selectMode ? null : input.store.name);
  put("form", selectMode ? "store_select" : null);
  put("selectableStores", (input.selectableStores ?? []).map((s) => s.name).join(" / "));
  put("items", input.items.map((i) => i.product.name).join(" / "));
  put("applyStart", flexToStr(input.applyStart));
  put("applyDeadline", flexToStr(input.applyDeadline));
  put("resultStart", flexToStr(input.resultDate));
  put("resultEnd", input.resultEndDate || null);
  put("applyMethod", input.applyMethod && input.applyMethod !== "unknown" ? String(input.applyMethod) : null);
  put("conditions", input.conditionsText ?? null);
  // 応募URLは登録入力では情報元URLの一覧（sourceUrls）に入る。AIが読み取った応募URLが一覧に残っていれば反映されたとみなす
  put("applyUrl", applyUrlHint && (input.sourceUrls ?? []).includes(applyUrlHint) ? applyUrlHint : null);
  put("receiveMethod", input.receiveMethod && input.receiveMethod !== "unknown" ? String(input.receiveMethod) : null);
  return c;
}

export { CASE_FIELD_KEYS };
export type { ExtractedFlex };
