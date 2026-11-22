// @vitest-environment node
import { describe, expect, it } from "vitest";
import { CallBudget, CaseBudget } from "../call-budget";
import { finalCategory, summarizeFinal } from "./final-states";
import { auditQuotes, toAgentView, type Evidence } from "./research-loop";
import { pageText } from "./html-text";
import { parseApplyPage } from "./page-structure";

describe("最終状態の集計（重複なし）", () => {
  it("1事例＝1行。重複IDは数えず報告する。分類は検証の通過・判断失敗・引用・対応の検査・予算", () => {
    const rows = [
      { id: "a", decision: "tentative", verified: true, held: null },
      { id: "b", decision: "none", verified: false, held: ["judge_failed"] },
      { id: "c", decision: "tentative", verified: false, held: ["quote_not_found:store"] },
      { id: "d", decision: "tentative", verified: false, held: ["scope_mismatch:store"] },
      { id: "e", decision: "none", verified: false, held: ["budget_cost"] },
      { id: "a", decision: "tentative", verified: false, held: ["quote_not_found:x"] },
    ];
    const s = summarizeFinal(rows);
    expect(s.duplicates).toEqual(["a"]);
    expect(s.total).toBe(5);
    expect(s.byCategory).toMatchObject({ verified: 1, judge_failed: 1, held_quote: 1, held_scope: 1, held_budget: 1 });
    expect(Object.values(s.byCategory).reduce((x, y) => x + y, 0)).toBe(s.total);
    expect(finalCategory({ id: "z", decision: "none", verified: false, held: null })).toBe("no_judgment");
  });
});

describe("1件あたりの費用上限（CaseBudget）", () => {
  it("1件の上限を超える呼び出しは開始しない。全体の上限・回数も親に積まれる。次の案件の上限は別", () => {
    const parent = new CallBudget({ maxCalls: 50, maxCostJpy: 10 });
    const c1 = new CaseBudget(parent, 1);
    const a = c1.start("x", 0.6);
    expect(a.ok).toBe(true);
    expect(c1.start("x", 0.6)).toEqual({ ok: false, reason: "cost" }); // 予約0.6＋0.6 > 1
    if (a.ok) a.finish(0.5);
    expect(c1.start("x", 0.6)).toEqual({ ok: false, reason: "cost" }); // 実費0.5＋予約0.6 > 1
    expect(c1.start("x", 0.5).ok).toBe(true); // 実費0.5＋予約0.5 = 1 は可
  });
  it("実費が計上されると残りが減る。親の全体上限にも達する", () => {
    const parent = new CallBudget({ maxCalls: 50, maxCostJpy: 1 });
    const c1 = new CaseBudget(parent, 5);
    const s = c1.start("x", 0.6);
    if (s.ok) s.finish(0.6);
    expect(parent.costJpy).toBeCloseTo(0.6);
    expect(c1.start("x", 0.6)).toEqual({ ok: false, reason: "cost" }); // 全体の残りが足りない
    const c2 = new CaseBudget(parent, 0.3);
    expect(c2.start("x", 0.35)).toEqual({ ok: false, reason: "cost" }); // 1件の上限
    expect(c1.caseCostJpy).toBeCloseTo(0.6);
  });
});

describe("本文の整形と引用の分類（Stage 10X）", () => {
  it("スクリプト・head・エンティティを除き、本文だけにする", () => {
    const t = pageText(`<html><head><title>T</title><script>var gtm=1;</script></head><body><h1>店舗A &amp; 店舗B</h1><style>.a{}</style><p>拡張パック&nbsp;抽選</p></body></html>`);
    expect(t).toContain("店舗A & 店舗B");
    expect(t).toContain("拡張パック 抽選");
    expect(t).not.toMatch(/gtm|\.a\{|<title>/);
  });
  const ev = (text: string, structure: Evidence["structure"] = null): Evidence => ({ id: "p0", kind: "page", url: "https://a.example/x", fetchedAt: "2026-11-22T00:00:00Z", contentHash: "h", text, structure, independent: true });
  it("引用の分類: 原文に実在／観察の要約だけ／言い換え（一部一致）／見つからない", () => {
    const html = `<html><h1 class="heading01">観察だけにある見出しです</h1><h2>受付・チケット情報</h2><section class="event-detail-ticket-card"><h4 class="event-detail-ticket-card__title">観察だけにある受付枠名です</h4><p class="event-detail-ticket-card__text">受付</p></section></html>`;
    const e = ev("拡張パック 抽選受付 店舗Aで11月27日まで応募できます", parseApplyPage(html));
    const out = (quote: string) => ({ decision: "tentative" as const, fields: { f: { value: "x", basis: "observed" as const, evidenceId: "p0", quote } }, rationale: "", unresolvedImpact: "none" as const, monitor: { continue: true, why: "" }, costJpy: 0 });
    const kind = (q: string) => auditQuotes(out(q), [e])[0].kind;
    expect(kind("店舗Aで11月27日まで応募")).toBe("ok");
    expect(kind("拡張パック 抽選受付 店舗Aで11月26日まで応募できます")).toBe("partial_overlap");
    expect(kind("全く関係のない別の長い文章です")).toBe("not_found");
    expect(kind("観察だけにある受付枠名です")).toBe("in_observations_only");
    expect(toAgentView(e).excerpt).toContain("拡張パック");
  });
});
