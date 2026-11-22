/**
 * 実AIの通し試験（P: 収集候補経路）の入力づくり（Phase 2・開発専用・純関数）。**保存済みの実在の公開投稿・公開ページ（ローカルのみ・Git管理外）から、収集が保存するのと同じ構造（StoredEvidence）の候補を作る**。
 *  - r10s: 10Sのレビュー資料の原文（短縮URLが未展開の投稿）→ 項目ごとにURLが無い／未展開。AIが自分で調べて応募先を探す条件（B2に近い。検索を許可したときだけ検索する）。
 *  - lp: 10Tで保存した LivePocket の応募ページ → 収集時と同じ「投稿本文＋短縮URL→展開URL（linkMap）＋リンク先ページ本文（linkedPages・最大3,000字）」。項目自身のリンクがあり、保存ページを再生する（A: URL既知に近い）。
 * **正解（gold）・人の回答・旧AIの出力は含めない**（原文とURLだけ）。ID・原文・URLは Git に入れない（呼び出し側がローカルの eval/real-data/ から読む）。
 */
import { buildEvidence, type StoredEvidence } from "@/lib/collector/evidence";
import { pageText } from "@/lib/judgment/xsource/html-text";
import { parseApplyPage } from "@/lib/judgment/xsource/page-structure";

export const EVAL_HOST = "https://eval-p.invalid";

export interface EvalCandidate {
  dedupeKey: string;
  title: string;
  kind: "r10s" | "lp";
  /** 評価側の参照ID（10SのケースID・LPの番号）。採点側だけが使う（AIの入力に含めない） */
  ref: string;
  evidence: StoredEvidence;
}

export function buildEvalCandidates(a: { review: { id: string; real: boolean; sourceText: string[] }[]; lp: { n: number; url: string; html: string }[]; now: string }): EvalCandidate[] {
  const out: EvalCandidate[] = [];
  for (const c of a.review) {
    if (!c.real || !c.sourceText?.length) continue; // 架空は対象外
    const key = `${EVAL_HOST}/r10s/${c.id}`;
    const ev = buildEvidence({ url: key, kind: "x_post", post: { text: c.sourceText.join(" "), links: [] } }, a.now);
    if (ev) out.push({ dedupeKey: key, title: `eval r10s ${c.id}`, kind: "r10s", ref: c.id, evidence: ev });
  }
  for (const p of a.lp) {
    const key = `${EVAL_HOST}/lp/${p.n}`;
    const st = parseApplyPage(p.html);
    const short = `https://t.co/lp${p.n}x`;
    const ev = buildEvidence({ url: key, kind: "x_post", post: { text: `${st.title ?? "応募ページ"} ${short}`, links: [], linkMap: [{ short, url: p.url }] }, linkedPages: [{ url: p.url, text: pageText(p.html).slice(0, 3000) }] }, a.now);
    if (ev) out.push({ dedupeKey: key, title: `eval lp ${p.n}`, kind: "lp", ref: String(p.n), evidence: ev });
  }
  return out;
}

/** 実測に基づく平均（Stage 10X/10Y の実AI評価・Haiku 5.5・2026-11-22 時点。**単価は承認の直前に再確認する**）。見積であり、請求額の保証ではない */
export const COST_AVERAGES_JPY = { agentTurn: 0.163, judge: 0.148, search: 1.76 } as const;

/**
 * 項目数から費用を見積もる（円）。expected＝平均（調査ターン数: URLあり2・なし2、判断1.3回、検索はURLなしの項目で1回）、
 * reservedWorst＝全項目で予約を使い切った場合（`preflightRun` の最大予約）。実費は expected 付近、承認の上限は総額/1件の CallBudget/CaseBudget で止まる。
 */
export function estimateRunCost(a: { itemsWithUrl: number; itemsWithoutUrl: number; search: boolean; maxReservedPerItemJpy: number }): { expectedJpy: number; reservedWorstJpy: number } {
  const per = (turns: number, searches: number) => turns * COST_AVERAGES_JPY.agentTurn + 1.3 * COST_AVERAGES_JPY.judge + searches * COST_AVERAGES_JPY.search;
  const expected = a.itemsWithUrl * per(2, 0) + a.itemsWithoutUrl * per(2, a.search ? 1 : 0);
  const items = a.itemsWithUrl + a.itemsWithoutUrl;
  return { expectedJpy: Math.round(expected * 100) / 100, reservedWorstJpy: Math.round(items * a.maxReservedPerItemJpy * 100) / 100 };
}
