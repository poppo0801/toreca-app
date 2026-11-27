import "server-only";
import type { ApplyPageStructure } from "@/lib/judgment/xsource/page-structure";
import { pageEvidenceFromFetch } from "@/lib/judgment/xsource/research-loop";

/**
 * 収集時に取得したページの、新AIの調査と同じ整形（EVIDENCE_UTILIZATION）。
 *  - 以前は収集時の全文を収集用の整形（extractPageText）だけで保存し、ページの構造（受付枠・見出し・ページ内リンク・フォーム）を保存していなかった（structure: null）。
 *    そのため新AIは、保存済みの全文があっても構造が無いことを理由に再取得し、取得時点の構造と時刻を失っていた。
 *  - ここでは、新AIが実取得したときと同じ関数（pageEvidenceFromFetch）で、本文・構造・本文の取り出しの欠落（textLoss）を作る。原HTMLは保存しない。
 *  - 失敗しても収集は止めない（undefined を返し、従来の本文だけを保存する）。
 */
export interface PageView {
  text: string;
  structure: ApplyPageStructure | null;
  textLoss?: string[];
}

export function researchViewOf(html: string, finalUrl: string, fallbackText: string, at: Date): PageView | undefined {
  try {
    if (!html) return undefined;
    // 保存は提示の方式に関係なく原文（共通部分を含む全文と、その位置）。共通部分を不可逆に削除しない
    const e = pageEvidenceFromFetch(0, finalUrl, { ok: true, finalUrl, html, text: fallbackText }, at, "full");
    if (!e.text || e.text.length < 20) return undefined;
    return { text: e.text, structure: e.structure ?? null, ...(e.textLoss?.length ? { textLoss: e.textLoss } : {}) };
  } catch {
    return undefined;
  }
}
