/**
 * AIが当選発表日を読み取れなかったとき、告知の本文に当選発表の日付表現があれば固定ロジックで補う（Stage 9G・純関数）。
 * AIが読み取った値は上書きしない（不明のときだけ補う）。補った内容は warnings に記録し、確定した日とは区別する。
 */
import type { ExtractedLottery } from "@/lib/ai/extraction";
import { parseResultPhrase } from "./date-phrases";

export function supplementResultDate(e: ExtractedLottery, text: string | null | undefined, refDate: string): { extraction: ExtractedLottery; applied: string | null } {
  if (!text || e.resultDate.precision !== "unknown") return { extraction: e, applied: null };
  // 「販売開始日までに」の販売開始日は応募開始とは別の日付。本文から確実に取れない限り使わない（end_only は「○月○日までに」の形だけ）
  const p = parseResultPhrase(text, refDate);
  if (!p) return { extraction: e, applied: null };
  const flex = (date: string) => ({ precision: "date_only" as const, date, time: "", yearAssumed: true, yearUncertain: false });
  const w = [...e.warnings];
  if (p.kind === "range") {
    w.push(`当選発表日を本文の記載（${p.quote}）から補いました。確認してください`);
    return { extraction: { ...e, resultDate: flex(p.start), resultEndDate: p.end, warnings: w }, applied: "range" };
  }
  if (p.kind === "end_only") {
    w.push(`当選発表は${p.end.slice(5).replace("-", "/")}までの連絡です（開始日は不明）。本文の記載「${p.quote}」から補いました`);
    return { extraction: { ...e, resultDate: flex(p.end), warnings: w }, applied: "end_only" };
  }
  w.push(`当選発表日は目途・予定です（${p.quote}）。確定した日ではありません`);
  return { extraction: { ...e, resultDate: flex(p.end), warnings: w }, applied: "approx" };
}
