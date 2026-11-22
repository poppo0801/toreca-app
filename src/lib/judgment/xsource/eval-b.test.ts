// @vitest-environment node
/** Stage 10W: 条件B（B1/B2の分離）と条件C（独立した正解）の評価基盤。架空の例（実AI・実データではない。基盤の動作確認）。 */
import { describe, expect, it } from "vitest";
import { CallBudget } from "../call-budget";
// @ts-expect-error plain JS module
import { classifyGold, scoreAgainstGold } from "../../../../scripts/lib/gold-c.mjs";
// @ts-expect-error plain JS module
import { appendAnswers, currentOf } from "../../../../scripts/lib/groundtruth.mjs";
import { buildB2Seed, evaluateB1, evaluateB2, type BExample } from "./eval-b";
import { planXPost } from "./x-origin";
import type { AgentTurnOutput, JudgeOutput, RegistrationJudge, ResearchAgent } from "./research-loop";

const TEXT = "《新宿本店（東京）- 1件》 ・拡張パック 抽選 11/22(日)23:59 https://t.co/aaa111 《渋谷西口店（東京）- 1件》 ・拡張パック 抽選 11/22(日)23:59 https://t.co/bbb222";
const card = (t: string) => `<section class="event-detail-ticket-card"><h4 class="event-detail-ticket-card__title">${t}</h4></section>`;
const page = (t: string) => `<html><h1 class="heading01">${t}</h1><h2>受付・チケット情報</h2>${card(t)}</html>`;
const ex = (linkMap?: { short: string; url: string }[]): BExample => ({
  id: "fx1",
  post: { postId: "x1", text: TEXT, links: [], linkMap, recordedAt: "2026-11-22T00:00:00Z" },
  // 渋谷の項目に割り当てられた展開先が、実は新宿のページ（取り違え）
  pages: { "https://shop.example/a": page("【新宿本店】拡張パック 抽選"), "https://shop.example/b": page("【新宿本店】拡張パック 抽選"), "https://shop.example/c": page("【渋谷西口店】拡張パック 抽選") },
  gold: [{ itemNo: 1, store: "新宿本店", source: "人が公開ページで確認" }, { itemNo: 2, store: "渋谷西口店", source: "人が公開ページで確認" }],
});
const map = [{ short: "https://t.co/aaa111", url: "https://shop.example/a" }, { short: "https://t.co/bbb222", url: "https://shop.example/b" }];

describe("B1（展開・項目スコープ）: AIを使わない。展開結果を入力として与える評価（発見力ではない）", () => {
  it("例が無ければ評価不能（全て0）。展開結果が無い例は URL を取り出せない", () => {
    expect(evaluateB1([])).toMatchObject({ examples: 0, items: 0, urlExtracted: 0 });
    expect(evaluateB1([ex(undefined)])).toMatchObject({ items: 2, urlExtracted: 0, goldScored: 0 });
  });
  it("項目別の展開済みリンクを取り出し、ページの対応の検査が正解と一致するかを数える（取り違えたリンクを mismatch で防げる）", () => {
    const r = evaluateB1([ex(map)]);
    expect(r).toMatchObject({ items: 2, urlExtracted: 2, pageAvailable: 2, goldScored: 2, goldAgree: 2, goldDisagree: 0, unscored: 0 });
    expect(r.scope.mismatch).toBe(1); // 渋谷の項目に割り当てられた新宿のページ
    expect(r.scope.confirmed + r.scope.candidate).toBe(1);
  });
  it("gold が無い項目は採点しない（精度に含めない）", () => {
    const e = ex(map);
    e.gold = [];
    expect(evaluateB1([e])).toMatchObject({ goldScored: 0, unscored: 2 });
  });
});

describe("B2（AI自律発見）: 応募URLを与えない。B1の成功とは別", () => {
  it("種にURL・短縮URL・リンクの出所の行が含まれない（URLが与えられない条件）。B1の種（seedText）にはURLが含まれる＝条件が違う", () => {
    const plan = planXPost(ex(map).post).items[0];
    expect(buildB2Seed(plan)).not.toMatch(/https?:|t\.co|リンクの出所/);
    expect(plan.seedText).toContain("https://shop.example/a"); // 入力既知（A/B1）の種
  });
  it("AIが応募先に到達・対応付けできた項目だけ success。別の店舗のページに着いた項目は wrongPage（成功にしない）", async () => {
    const turn = (url: string | null): AgentTurnOutput => ({ observed: [], inferred: [], unknown: [], counterHypotheses: [], next: url ? { kind: "fetch", url, why: "" } : { kind: "stop", reason: "sufficient", why: "" }, costJpy: 1 });
    const done = new Set<string>();
    const agent: ResearchAgent = async (i) => {
      const k = i.caseId;
      if (done.has(k)) return turn(null);
      done.add(k);
      return turn(k.endsWith("#1") ? "https://shop.example/a" : "https://shop.example/a"); // 項目2（渋谷）でも新宿のページへ（誤り）
    };
    const judge: RegistrationJudge = async () => ({ decision: "tentative", fields: {}, rationale: "", unresolvedImpact: "minor", monitor: { continue: true, why: "" }, costJpy: 1 }) as JudgeOutput;
    const r = await evaluateB2({ examples: [ex(undefined)], agent, judge, budget: new CallBudget({ maxCalls: 50, maxCostJpy: 100 }), now: new Date("2026-11-22T00:00:00Z") });
    expect(r).toMatchObject({ items: 2, attempted: 2, reachedPage: 2, success: 1, wrongPage: 1, noGold: 0 });
  });
});

describe("条件C: 独立した正解（gold）の確定と採点", () => {
  const T = "2026-11-22T00:00:00Z";
  const store = () => {
    let s: unknown = { cases: {} };
    const add = (a: object) => {
      const r = appendAnswers(s, a, "山田", T);
      expect(r.ok).toBe(true);
      s = r.store;
    };
    add({
      a: { verdict: "wrong", correctUnit: "per_store", note: "掲載URLを確認すると1店舗だけの専用ページ" }, // gold
      b: { verdict: "wrong", correctUnit: "per_store" }, // 方式の明示あり・根拠の記録なし
      c: { verdict: "correct", note: "OK" }, // 以前のAIへの評価のみ
      d: { verdict: "undecidable" },
    });
    return s;
  };
  const cases = [{ id: "a", real: true, aiUnit: "store_select" }, { id: "b", real: true, aiUnit: "store_select" }, { id: "c", real: true, aiUnit: "per_store" }, { id: "d", real: true }, { id: "e", real: true }, { id: "f", real: false, aiUnit: "x" }];
  it("『誤り』から反対の方式を自動導出しない。方式の明示＋根拠の記録がある事例だけ gold。『正しい』は以前のAIへの評価のみ。架空は含めない", () => {
    const g = classifyGold(cases, store(), currentOf);
    expect(g.counts).toEqual({ gold: 1, human_unit_no_basis: 1, evaluation_of_prior_only: 1, undecidable: 1, pending: 1 });
    expect(g.rows.find((r: { id: string }) => r.id === "a").gold).toMatchObject({ unit: "per_store", basis: expect.stringContaining("1店舗だけ") });
    expect(g.rows.find((r: { id: string }) => r.id === "c").gold).toBeNull(); // 「正しい」から方式を導出しない
    expect(g.rows.map((r: { id: string }) => r.id)).not.toContain("f"); // 架空は対象外
  });
  it("gold が最小数（10）に満たない間は正答率を出さない。過剰保留・根拠なしの断定・取得欠落の未出力を別々に数える。gold でない事例は採点しない", () => {
    const g = classifyGold(cases, store(), currentOf);
    const s = scoreAgainstGold(g, [
      { id: "a", aiUnit: "per_store", aiUnitBasis: "inferred", decision: "register" }, // gold と一致だが、根拠（観察）が無いのに本登録
      { id: "b", aiUnit: "store_select", decision: "register" }, // gold ではない（採点しない）
    ]);
    expect(s).toMatchObject({ scored: 1, match: 1, mismatch: 0, unsupportedAssertion: 1, rate: null });
    expect(s.note).toContain("正答率は出さない");
    const s2 = scoreAgainstGold(g, [{ id: "a", aiUnit: null, decision: "tentative" }]);
    expect(s2).toMatchObject({ overHold: 1, match: 0 });
  });
});
