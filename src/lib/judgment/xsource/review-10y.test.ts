// @vitest-environment node
/**
 * Stage 10Y: 人が確認できる比較資料の生成（ローカル資料がある場合のみ。AI・Web・課金なし）。出力は eval/real-data/xsource-10y-review.{json,md}（Git管理外）。
 * 入力: Stage 10T の保存ページ12件＋Stage 10X の A 再試験の結果／10S の人の回答から確定した独立 gold（C）と、その事例の AI 結果。
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
// @ts-expect-error plain JS module
import { classifyGold } from "../../../../scripts/lib/gold-c.mjs";
// @ts-expect-error plain JS module
import { currentOf } from "../../../../scripts/lib/groundtruth.mjs";
import { pageText } from "./html-text";
import { parseApplyPage } from "./page-structure";
import { buildReviewRows, reviewMarkdown, reviewSummary, type ReviewInput } from "./review-sheet";

const DIR = "eval/real-data/10t-html";
const A = "eval/real-data/xsource-10u-real.json";
const C = "eval/real-data/xsource-10w-c.json";
const REVIEW = "eval/real-data/human-review-10s.json";
const ANSWERS = "eval/real-data/human-review-10s-answers.json";

describe.skipIf(!existsSync(`${DIR}/index.json`) || !existsSync(A))("10Y 人が確認できる比較資料（ローカル資料のみ）", () => {
  it("A 12件（保存ページの受付枠・AIの結果）と C の gold 事例を、1事例1行で書き出す。gold が無い事例は採点しない", () => {
    const idx = JSON.parse(readFileSync(`${DIR}/index.json`, "utf8")) as { n: number; url: string; ok: boolean }[];
    const a = JSON.parse(readFileSync(A, "utf8")) as { cases: { id: string; decision: string; verified: boolean; held: string[] | null; end: string; fields: { field: string; basis: string; valueInText: boolean | null; value?: string | null; quote?: string | null }[]; quoteAudit?: { rows: { kind: string }[] }[]; oldMethod?: { slots: number | null } }[] };
    const inputs: ReviewInput[] = [];
    for (const x of idx.filter((i) => i.ok)) {
      const html = readFileSync(`${DIR}/lp-${x.n}.html`, "utf8");
      const st = parseApplyPage(html);
      const res = a.cases.find((c) => c.id === `lp-${x.n}`);
      inputs.push({ id: `A:lp-${x.n}`, host: new URL(x.url).hostname, structure: st, sourceText: `告知: ${st.title ?? ""}（応募ページのURLを種に含める条件）`, ai: res ? { decision: res.decision, verified: res.verified, held: res.held, end: res.end, fields: res.fields, quoteKinds: res.quoteAudit?.[res.quoteAudit.length - 1]?.rows.map((r) => r.kind) } : null, gold: null, oldMethodSlots: res?.oldMethod?.slots ?? st.slots.length });
      void pageText;
    }
    if (existsSync(C) && existsSync(REVIEW) && existsSync(ANSWERS)) {
      const c = JSON.parse(readFileSync(C, "utf8")) as { results: { id: string; decision: string; verified: boolean; held: string[] | null; end: string; aiUnit: string | null; aiUnitBasis: string | null }[] };
      const cases = (JSON.parse(readFileSync(REVIEW, "utf8")) as { cases: { id: string; real: boolean; aiUnit?: string; sourceText: string[] }[] }).cases;
      const gold = classifyGold(cases, JSON.parse(readFileSync(ANSWERS, "utf8")), currentOf);
      for (const g of gold.rows as { id: string; category: string; gold: { unit: string; basis: string | null } | null }[]) {
        if (g.category !== "gold") continue;
        const res = c.results.find((r) => r.id === g.id);
        const src = cases.find((k) => k.id === g.id);
        inputs.push({ id: `C:${g.id}`, host: "（応募ページ未取得）", structure: null, sourceText: (src?.sourceText ?? []).join(" "), ai: res ? { decision: res.decision, verified: res.verified, held: res.held, end: res.end, fields: [{ field: "apply_unit", basis: res.aiUnitBasis ?? "unknown", value: res.aiUnit }] } : null, gold: g.gold, oldMethodSlots: null });
      }
    }
    const rows = buildReviewRows(inputs);
    writeFileSync("eval/real-data/xsource-10y-review.json", JSON.stringify({ summary: reviewSummary(rows), rows }, null, 1));
    writeFileSync("eval/real-data/xsource-10y-review.md", reviewMarkdown(rows));
    expect(rows.length).toBe(inputs.length);
  });
});

describe("比較資料の組み立て（合成データ）", () => {
  it("1事例＝1行（重複は数えない）。gold が無い事例は採点せず『正解なし』を明記。検証通過は正しさの根拠にしない", () => {
    const base: ReviewInput = { id: "x", host: "h", structure: null, sourceText: "原文", ai: { decision: "register", verified: true, held: null, fields: [{ field: "store", basis: "observed", valueInText: false }] }, gold: null, oldMethodSlots: 1 };
    const rows = buildReviewRows([base, { ...base }, { ...base, id: "y", gold: { unit: "per_store", basis: "公開ページで確認" } }]);
    expect(rows).toHaveLength(2);
    expect(rows[0].scored).toBe(false);
    expect(rows[0].toCheck.join("\n")).toMatch(/独立した正解なし/);
    expect(rows[0].toCheck.join("\n")).toMatch(/引用が原文に実在するだけ/);
    expect(rows[0].toCheck.join("\n")).toMatch(/値が本文にそのまま現れない/);
    expect(rows[1].scored).toBe(true);
    expect(reviewSummary(rows)).toEqual({ cases: 2, withGold: 1, scored: 1, withoutGold: 1, verifiedWithoutGold: 1 });
    expect(reviewMarkdown(rows)).toContain("正しさ未確認");
  });
});
