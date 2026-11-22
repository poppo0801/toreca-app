// @vitest-environment node
/**
 * Stage 10U: AIへ渡る入力の実測（**AIは呼ばない・無料**）。保存済みの実在の公開ページ（Stage 10T で取得したLivePocket 12ページ・Googleフォーム3ページ。Git管理外）が、
 * 構造として取得され、AIの入力（観察の文）にどこまで載るかを測る。取得の欠落（入力に無い）と、AIの解釈誤り（入力にはある）を切り分けるための材料。
 * 出力: eval/real-data/xsource-10u-input-audit.json（集計のみ・Git管理外）。ファイルが無ければスキップ。
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { describe, it } from "vitest";
import { observeRelated, parseApplyPage, structureToObservations } from "./page-structure";
import { toAgentView, seedEvidence } from "./research-loop";
import { renderTurnInput } from "./research-ai";
import { vi } from "vitest";

vi.mock("server-only", () => ({}));
const DIR = "eval/real-data/10t-html";
describe.skipIf(!existsSync(`${DIR}/index.json`))("AI入力の実測（実在ページ・AI呼び出しなし）", () => {
  it("各ページの 取得した構造 → AIへ渡す観察 の欠落を集計する", () => {
    const rows: Record<string, unknown>[] = [];
    const add = (kind: string, file: string) => {
      const html = readFileSync(`${DIR}/${file}`, "utf8");
      const st = parseApplyPage(html);
      const obs = structureToObservations(st);
      const ev = { ...seedEvidence("p1", html.replace(/<[^>]+>/g, " ").slice(0, 3000), new Date("2026-11-22T00:00:00Z")), kind: "page" as const, structure: st };
      const input = renderTurnInput({ caseId: "audit", evidence: [toAgentView(ev)], history: [], remaining: { turns: 6, fetches: 6, costJpy: 30, elapsedMs: 180000 } });
      rows.push({ kind, file, siteKind: st.siteKind, recognized: st.recognized, slots: st.slots.length, related: observeRelated(st).length, formQuestions: st.formQuestions.length, formChoices: st.formChoices.length, pageNotes: st.pageNotes.length, gaps: st.gaps, observationLines: obs.length, aiInputChars: input.length, relatedLinksForAi: st.relatedEvents.filter((r) => r.href).length });
    };
    for (let n = 1; n <= 12; n++) if (existsSync(`${DIR}/lp-${n}.html`)) add("livepocket", `lp-${n}.html`);
    for (let n = 1; n <= 3; n++) if (existsSync(`${DIR}/gf-${n}.html`)) add("google_form", `gf-${n}.html`);
    const lp = rows.filter((r) => r.kind === "livepocket");
    const gf = rows.filter((r) => r.kind === "google_form");
    writeFileSync("eval/real-data/xsource-10u-input-audit.json", JSON.stringify({ note: "AIを呼ばない入力の実測（Git管理外）", livepocket: { pages: lp.length, recognized: lp.filter((r) => r.recognized).length, withRelated: lp.filter((r) => (r.related as number) > 0).length, withNotes: lp.filter((r) => (r.pageNotes as number) > 0).length, maxInputChars: Math.max(0, ...lp.map((r) => r.aiInputChars as number)) }, googleForm: { pages: gf.length, recognized: gf.filter((r) => r.recognized).length, maxInputChars: Math.max(0, ...gf.map((r) => r.aiInputChars as number)) }, rows }, null, 1));
  });
});
