// @vitest-environment node
/**
 * Stage 10X: 実AI評価の前の**無課金の監査**（条件A・Cの評価対象・根拠・原文とgoldの分離・古い事例の取得不能状態・入力サイズ→費用見積）。AIは呼ばない。
 * 出力: eval/real-data/xsource-10x-audit.json（集計のみ・Git管理外）。ローカルの資料が無ければスキップ。
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
// @ts-expect-error plain JS module
import { classifyGold } from "../../../../scripts/lib/gold-c.mjs";
// @ts-expect-error plain JS module
import { currentOf } from "../../../../scripts/lib/groundtruth.mjs";
import { parseApplyPage } from "./page-structure";
import { RESEARCH_SYSTEM, renderTurnInput } from "./research-ai";
import { seedEvidence, toAgentView } from "./research-loop";

vi.mock("server-only", () => ({}));
const HTML = "eval/real-data/10t-html";
const REVIEW = "eval/real-data/human-review-10s.json";
const ANSWERS = "eval/real-data/human-review-10s-answers.json";
/** トークン数の保守的な概算: 日本語は1文字≒1トークンと見て上限側に置く（実測は実行前のトークン数の確認で置き換える） */
const tokens = (s: string): number => Math.ceil(s.length * 1.0);

describe.skipIf(!existsSync(`${HTML}/index.json`) || !existsSync(REVIEW) || !existsSync(ANSWERS))("10X 条件A・Cの無課金監査", () => {
  it("A: 評価対象（保存済みLivePocket）の構造・種・入力サイズ。C: gold・原文とgoldの分離・取得不能の状態", () => {
    const index = JSON.parse(readFileSync(`${HTML}/index.json`, "utf8")) as { n: number; url: string; ok: boolean }[];
    const aRows = index.filter((x) => x.ok).map((x) => {
      const html = readFileSync(`${HTML}/lp-${x.n}.html`, "utf8");
      const st = parseApplyPage(html);
      const title = st.title ?? "";
      const seed = seedEvidence("s1", `告知: ${title}\n応募ページ: ${x.url}`, new Date("2026-11-22T00:00:00Z"));
      const ev = { ...seedEvidence("p1", html.replace(/<[^>]+>/g, " ").slice(0, 3000), new Date()), kind: "page" as const, structure: st };
      const input = renderTurnInput({ caseId: `lp-${x.n}`, evidence: [toAgentView(seed), toAgentView(ev)], history: [], remaining: { turns: 4, fetches: 3, costJpy: 30, elapsedMs: 180000, searches: 0 }, searchAvailable: false });
      return { n: x.n, recognized: st.recognized, slots: st.slots.length, seedHasUrl: seed.text.includes("http"), seedHasGold: false, inputChars: input.length, inputTokensEst: tokens(input) + tokens(RESEARCH_SYSTEM) };
    });
    const cases = (JSON.parse(readFileSync(REVIEW, "utf8")) as { cases: { id: string; real: boolean; aiUnit?: string; sourceText: string[]; linkOrigin?: string; fetchOutcome?: string }[] }).cases;
    const gold = classifyGold(cases, JSON.parse(readFileSync(ANSWERS, "utf8")), currentOf);
    const goldIds = new Set(gold.rows.filter((r: { category: string }) => r.category === "gold").map((r: { id: string }) => r.id));
    const cRows = cases.filter((c) => goldIds.has(c.id)).map((c) => {
      const input = c.sourceText.join("\n");
      const goldRow = gold.rows.find((r: { id: string }) => r.id === c.id);
      const leak = [goldRow.gold.unit, goldRow.gold.basis].filter(Boolean).some((g: string) => input.includes(g));
      return { id: c.id, inputChars: input.length, goldLeakedIntoInput: leak, linkOrigin: c.linkOrigin ?? null, pageAvailable: false, reason: "保存データに項目別の展開結果が無く、応募ページを取得できない（古い事例）" };
    });
    const maxA = Math.max(0, ...aRows.map((r) => r.inputTokensEst));
    writeFileSync("eval/real-data/xsource-10x-audit.json", JSON.stringify({ A: { cases: aRows.length, recognized: aRows.filter((r) => r.recognized).length, maxInputTokensEst: maxA, seedIncludesUrl: aRows.every((r) => r.seedHasUrl) }, C: { gold: cRows.length, counts: gold.counts, goldLeakedIntoInput: cRows.some((r) => r.goldLeakedIntoInput), allPagesUnavailable: cRows.every((r) => !r.pageAvailable), rows: cRows }, rows: aRows }, null, 1));
    expect(aRows.every((r) => r.seedHasUrl)).toBe(true); // 条件A: URL既知
    expect(cRows.some((r) => r.goldLeakedIntoInput)).toBe(false); // 原文に正解（gold）が混ざっていない
  });
});
