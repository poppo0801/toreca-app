/**
 * 調査結果・同じ抽選の別の候補（案件ファイル）→ 既存の抽出形式（ExtractedLottery）への反映（Stage 9H-3B/3E）。
 * 登録候補の組み立て（buildDraft → 固定ロジックの連鎖 → 登録判定）は既存の経路をそのまま使い、統合の結果はその入口で合流させる。
 *
 * 9H-3E: どの値を採用するかの選択は、統合処理（integrate.ts）に一本化した（以前は、ここに別の規則があった）。
 *  - 収集AIの読み取り（基準）・調査結果・同じ抽選の別の候補を、同一抽選と確認できたものだけ統合し、項目ごとに根拠を比べて採用する
 *  - 人間が確定した項目は上書きしない／矛盾は未確認として保持／採用しなかった値・取り込めない値は、捨てずに未反映情報へ残す
 * ここは、統合の結果を抽出形式へ反映し、注意（確認待ちの理由）と判断の記録を作るだけ。
 */
import type { ExtractedFlex, ExtractedLottery } from "@/lib/ai/extraction";
import { productKey } from "@/lib/lottery-match";
import { caseFromExtraction, flexToStr } from "./from-extraction";
import { integrateCandidates, type IntegrationInput, type IntegrationResult } from "./integrate";
import { sameMeaning } from "./judgment";
import { CASE_FIELD_LABEL, splitList, type CaseFieldKey, type CaseFile, type DecisionRecord, type UnreflectedInfo } from "./types";

export const strToFlex = (v: string | null): ExtractedFlex => {
  const m = v ? /^(\d{4}-\d{2}-\d{2})(?:[ T](\d{2}:\d{2}))?/.exec(v.trim()) : null;
  if (!m) return { precision: "unknown", date: "", time: "", yearAssumed: false, yearUncertain: false };
  return { precision: m[2] ? "date_time" : "date_only", date: m[1], time: m[2] ?? "", yearAssumed: false, yearUncertain: false };
};

const FORM_TO_UNIT: Record<string, ExtractedLottery["applyUnit"]> = { store_select: "store_select", store_independent: "store_independent", other: "single" };

export interface MergeResult {
  extraction: ExtractedLottery;
  decisions: DecisionRecord[];
  unreflected: UnreflectedInfo[];
  applied: number;
  held: number;
}

const curOf = (out: ExtractedLottery, k: CaseFieldKey): string | null => {
  switch (k) {
    case "chain": return out.chainName || null;
    case "store": return out.storeName || null;
    case "form": return out.applyUnit && out.applyUnit !== "unknown" ? (out.applyUnit === "single" || out.applyUnit === "per_product" ? "other" : out.applyUnit) : null;
    case "selectableStores": return (out.selectableStoreNames ?? []).join(" / ") || null;
    case "items": return out.items.map((i) => i.name).join(" / ") || null;
    case "applyStart": return flexToStr(out.applyStart);
    case "applyDeadline": return flexToStr(out.applyDeadline);
    case "resultStart": return flexToStr(out.resultDate);
    case "resultEnd": return out.resultEndDate || null;
    case "applyMethod": return out.applyMethod === "unknown" ? null : out.applyMethod;
    case "conditions": return out.conditionsText || null;
    case "applyUrl": return out.applyUrl || null;
    case "receiveMethod": return out.receiveMethod === "unknown" ? null : out.receiveMethod;
  }
};

/** 抽出形式へ値を設定する。形式に変換できない値は false（呼び出し側が未反映情報へ残す） */
const setOn = (out: ExtractedLottery, k: CaseFieldKey, v: string): boolean => {
  switch (k) {
    case "chain": out.chainName = v; return true;
    case "store": out.storeName = v; return true;
    case "form": out.applyUnit = FORM_TO_UNIT[v] ?? "unknown"; return !!FORM_TO_UNIT[v];
    case "selectableStores": out.selectableStoreNames = splitList(v); return true;
    case "items": {
      // 商品名は、統合で選んだ名前にする（同じ商品の装飾付きの名前を、短い名前に）。数量・単位は既存の読み取りを保つ
      const old = out.items;
      out.items = splitList(v).map((name) => {
        const same = old.find((x) => productKey(x.name) === productKey(name) && !!productKey(name)) ?? old.find((x) => x.name === name);
        return { ...(same ?? { code: "", quantity: 1, unit: "box" as const, unitAssumed: true }), name };
      });
      return true;
    }
    case "applyStart": out.applyStart = strToFlex(v); return true;
    case "applyDeadline": out.applyDeadline = strToFlex(v); return true;
    case "resultStart": out.resultDate = strToFlex(v); return true;
    case "resultEnd": out.resultEndDate = v.slice(0, 10); return true;
    case "applyMethod": if (v === "web" || v === "store" || v === "app") { out.applyMethod = v; return true; } return false;
    case "conditions": out.conditionsText = v; return true;
    case "applyUrl": out.applyUrl = v; return true;
    case "receiveMethod": if (v === "store" || v === "shipping" || v === "either") { out.receiveMethod = v; return true; } return false;
  }
};

/** 統合の結果を、抽出形式へ反映する。取り込めない値・矛盾して決められない別の値・採用しなかった値は、捨てずに未反映情報へ残す */
export function overlayIntegration(ex: ExtractedLottery, r: IntegrationResult, opts: { humanLocked?: CaseFieldKey[] } = {}): MergeResult {
  const out: ExtractedLottery = { ...ex, warnings: [...ex.warnings] };
  const decisions: DecisionRecord[] = [];
  const unreflected: UnreflectedInfo[] = [...r.caseFile.unreflected];
  let applied = 0;
  let held = 0;
  const locked = new Set<CaseFieldKey>(opts.humanLocked ?? []);
  for (const a of r.adoptions) {
    const k = a.field;
    const label = CASE_FIELD_LABEL[k];
    const before = curOf(out, k);
    const f = r.caseFile.fields[k];
    const url = f.evidence.map((e) => e.url).find((u) => !!u && !u.startsWith("("));
    const src = `${a.from.join("・") || "固定ロジックの推定"}${url ? ` ${url}` : ""}`;
    if (locked.has(k)) {
      if (a.rejected.length) decisions.push({ stage: "merge", field: k, kind: "rejected", before: a.rejected[0].value, after: before, by: "fixed", reason: "人間が確定した項目のため上書きしない" });
      continue;
    }
    // 矛盾: 根拠の強さが近く決められない。暫定値（読み取りの値、応募締切は早い方）を保ち、別の値は未反映情報へ。確認が必要な注意を出す
    if (a.state === "conflict") {
      const all = [a.value, ...f.alternatives.map((x) => x.value)].filter(Boolean).join(" / ");
      for (const alt of f.alternatives) unreflected.push({ key: k, value: alt.value, reason: `情報源間で食い違う別の値（${label}）`, evidence: alt.evidence });
      decisions.push({ stage: "merge", field: k, kind: "held", before, after: a.value, by: "fixed", reason: `情報源どうしで食い違い、根拠の強さが近いため決められない（${all}）` });
      out.warnings.push(`調査で${label}が情報源どうしで食い違っています（${all}）`);
      held++;
      if (a.value && before === null && setOn(out, k, a.value)) applied++;
      continue;
    }
    if (a.value === null || before === a.value) continue;
    // 同じ意味で、表現が変わらない項目は触らない（日時・文面・商品・系列は、より良い表現への統一があるため下へ進む）
    if (before !== null && sameMeaning(k, before, a.value) && !["applyStart", "applyDeadline", "resultStart", "conditions", "items", "chain"].includes(k)) continue;
    if (!setOn(out, k, a.value)) {
      unreflected.push({ key: k, value: a.value, reason: `登録候補に反映できない値（${label}）`, evidence: f.evidence });
      decisions.push({ stage: "merge", field: k, kind: "held", before, after: a.value, by: "fixed", reason: "登録候補の形式に変換できないため未反映情報として保持" });
      held++;
      continue;
    }
    applied++;
    decisions.push({ stage: "merge", field: k, kind: before === null ? "adopted" : "changed", before, after: a.value, by: a.from.length ? "investigation" : "fixed", reason: `統合: ${a.reason}（出典: ${src}）` });
    if (before === null && a.state !== "confirmed") out.warnings.push(`調査で${label}を補いました（未確認・出典: ${src}）`);
    else if (before !== null && !sameMeaning(k, before, a.value)) out.warnings.push(`調査により${label}を更新しました（${before} → ${a.value}。出典: ${src}）`);
  }
  // 採用しなかった値（根拠が弱い）は、確認の手がかりとして未反映情報へ残す
  for (const a of r.adoptions) for (const x of a.rejected) if (x.from && a.state !== "conflict" && !locked.has(a.field) && a.field !== "store") unreflected.push({ key: a.field, value: x.value, reason: `採用しなかった値（${x.from}。${x.reason}）` });
  for (const e of r.excluded) decisions.push({ stage: "merge", field: "general", kind: "rejected", before: e.label, after: null, by: "fixed", reason: `統合しない: ${e.reason}` });
  // 当選発表の終了が開始より前になる値は採用しない（期間の取り違えを防ぐ）
  if (out.resultEndDate && out.resultDate.precision !== "unknown" && out.resultEndDate < out.resultDate.date) {
    decisions.push({ stage: "merge", field: "resultEnd", kind: "rejected", before: out.resultEndDate, after: null, by: "fixed", reason: "当選発表の終了が開始より前のため採用しない" });
    out.resultEndDate = "";
  }
  return { extraction: out, decisions, unreflected, applied, held };
}

/** 収集AIの読み取り（基準）＋ 調査結果 ＋ 同じ抽選の別の候補 → 統合 → 抽出形式へ反映。選択は integrateCandidates が行う */
export function applyCaseFileToExtraction(ex: ExtractedLottery, inv: CaseFile, opts: { humanLocked?: CaseFieldKey[]; siblings?: IntegrationInput[]; sourceUrl?: string } = {}): MergeResult & { integration: IntegrationResult } {
  const locked = [...new Set<CaseFieldKey>([...(opts.humanLocked ?? []), ...inv.humanLocked])];
  const anchor = caseFromExtraction(ex, "anchor", { url: opts.sourceUrl ?? "(収集AIの読み取り)", at: inv.createdAt });
  anchor.humanLocked = locked;
  const integration = integrateCandidates([{ id: "0-anchor", label: "収集AIの読み取り", caseFile: anchor }, { id: "1-investigation", label: "調査結果", caseFile: inv, sameVerified: true }, ...(opts.siblings ?? [])], { humanLocked: locked, at: inv.createdAt });
  const m = overlayIntegration(ex, integration, { humanLocked: locked });
  // 調査側で既に決まっていた保持情報（未反映・矛盾の別の値）も引き継ぐ
  return { ...m, unreflected: [...inv.unreflected, ...m.unreflected].filter((u, i, a) => a.findIndex((x) => x.key === u.key && x.value === u.value) === i), integration };
}
