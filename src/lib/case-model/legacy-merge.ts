/**
 * 調査結果の合流（Stage 9H-3B/3C の規則。**3方式の比較のB方式「AI調査＋従来の統合処理」のために保持**。9H-3Eの統合処理には使わない）。
 *  - 人間が確定した項目は触らない
 *  - 既存の読み取りが空の項目は、調査の値で補う（確定以外は「未確認」の注意つき）
 *  - 既存の読み取りと違う値は、調査が「確定」のときだけ置き換える。それ以外は置き換えず、食い違いを注意と未反映情報に残す
 *  - 矛盾の項目・取り込めない値は採用せず、未反映情報に残す
 *  - 日時の境界表現（1〜2分差）・日付のみと時刻つきは、安全側（早い方・時刻つき）に揃える
 * 同じ調査結果を、この方式（B）と統合処理（C）に渡し、統合処理による差分だけを測るために使う。複数の候補の統合・根拠の強さの比較・文面の詳しさの比較は行わない。
 */
import type { ExtractedLottery } from "@/lib/ai/extraction";
import { relateDateTimes } from "@/lib/collector/date-phrases";
import { curOf, setOn, type MergeResult } from "./merge";
import { parseDt, sameMeaning } from "./judgment";
import { CASE_FIELD_LABEL, isSet, type CaseFieldKey, type CaseFile, type DecisionRecord, type UnreflectedInfo } from "./types";

const srcOf = (c: CaseFile, k: CaseFieldKey): string => c.fields[k].evidence.map((e) => e.url).filter(Boolean)[0] ?? "調査";

export function applyCaseFileLegacy(ex: ExtractedLottery, inv: CaseFile, opts: { humanLocked?: CaseFieldKey[] } = {}): MergeResult {
  const locked = new Set<CaseFieldKey>([...(opts.humanLocked ?? []), ...inv.humanLocked]);
  const out: ExtractedLottery = { ...ex, warnings: [...ex.warnings] };
  const decisions: DecisionRecord[] = [];
  const unreflected: UnreflectedInfo[] = [...inv.unreflected];
  let applied = 0;
  let held = 0;
  for (const k of Object.keys(inv.fields) as CaseFieldKey[]) {
    const f = inv.fields[k];
    const label = CASE_FIELD_LABEL[k];
    if (f.state === "conflict") {
      for (const a of f.alternatives) unreflected.push({ key: k, value: a.value, reason: `情報源間で食い違う別の値（${label}）`, evidence: a.evidence });
      if (f.value) unreflected.push({ key: k, value: f.value, reason: `情報源間で食い違う値（${label}）`, evidence: f.evidence });
      decisions.push({ stage: "merge", field: k, kind: "held", before: curOf(out, k), after: f.value, by: "investigation", reason: "調査で情報源どうしが矛盾したため採用しない" });
      out.warnings.push(`調査で${label}が情報源どうしで食い違っています（${[f.value, ...f.alternatives.map((a) => a.value)].filter(Boolean).join(" / ")}）`);
      held++;
      continue;
    }
    if (!isSet(f) || f.value === null) continue;
    const before = curOf(out, k);
    if (locked.has(k)) {
      if (!sameMeaning(k, before, f.value)) decisions.push({ stage: "merge", field: k, kind: "rejected", before, after: f.value, by: "fixed", reason: "人間が確定した項目のため上書きしない" });
      continue;
    }
    const src = srcOf(inv, k);
    if ((k === "applyStart" || k === "applyDeadline" || k === "resultStart") && before !== null && sameMeaning(k, before, f.value)) {
      const x = parseDt(before);
      const y = parseDt(f.value);
      const adopt = x && y ? relateDateTimes(x, y).adopt : undefined;
      const adopted = adopt ? `${adopt.date}${adopt.time ? ` ${adopt.time}` : ""}` : null;
      if (adopted && adopted !== before) {
        setOn(out, k, adopted);
        applied++;
        decisions.push({ stage: "merge", field: k, kind: "changed", before, after: adopted, by: "investigation", reason: `同じ日時の表記差（境界表現・詳しさ）を、安全側（早い方・時刻つき）に統一（出典: ${src}）` });
      }
      continue;
    }
    if (sameMeaning(k, before, f.value)) continue;
    if (before === null) {
      if (setOn(out, k, f.value)) {
        applied++;
        decisions.push({ stage: "merge", field: k, kind: "adopted", before, after: f.value, by: "investigation", reason: `調査で補った（${f.state === "confirmed" ? "確定" : "未確認"}・出典: ${src}）` });
        if (f.state !== "confirmed") out.warnings.push(`調査で${label}を補いました（未確認・出典: ${src}）`);
      } else {
        unreflected.push({ key: k, value: f.value, reason: `登録候補に反映できない値（${label}）`, evidence: f.evidence });
        decisions.push({ stage: "merge", field: k, kind: "held", before, after: f.value, by: "fixed", reason: "登録候補の形式に変換できないため未反映情報として保持" });
        held++;
      }
      continue;
    }
    if (f.state === "confirmed" && k !== "items" && setOn(out, k, f.value)) {
      applied++;
      decisions.push({ stage: "merge", field: k, kind: "changed", before, after: f.value, by: "investigation", reason: `調査で確定した値に更新（出典: ${src}）` });
      out.warnings.push(`調査により${label}を更新しました（${before} → ${f.value}。出典: ${src}）`);
    } else {
      unreflected.push({ key: k, value: f.value, reason: `既存の読み取り（${before}）と異なる調査結果（${label}）`, evidence: f.evidence });
      decisions.push({ stage: "merge", field: k, kind: "held", before, after: f.value, by: "fixed", reason: "確定していない調査結果は既存の読み取りを置き換えない（食い違いを確認待ちの理由にする）" });
      out.warnings.push(`調査結果の${label}（${f.value}）が読み取り（${before}）と食い違います。確認してください`);
      held++;
    }
  }
  if (out.resultEndDate && out.resultDate.precision !== "unknown" && out.resultEndDate < out.resultDate.date) {
    decisions.push({ stage: "merge", field: "resultEnd", kind: "rejected", before: out.resultEndDate, after: null, by: "fixed", reason: "当選発表の終了が開始より前のため採用しない" });
    out.resultEndDate = "";
  }
  return { extraction: out, decisions, unreflected, applied, held };
}
