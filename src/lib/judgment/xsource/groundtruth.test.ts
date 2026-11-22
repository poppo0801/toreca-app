// @vitest-environment node
/** Stage 10S: 人の確認結果（正解データ）の保存・評価: 人の名義・履歴・未測定・架空の除外・AIの自己強化の禁止。 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
// @ts-expect-error plain JS module
import { appendAnswers, currentOf, evaluate } from "../../../../scripts/lib/groundtruth.mjs";

const T1 = "2026-11-22T10:00:00Z";
const cases = [
  { id: "a", real: true, aiUnit: "store_select", aiTiming: "unknown", aiDecision: "auto_register_preview" },
  { id: "b", real: true, aiUnit: "per_store", aiTiming: "at_apply", aiDecision: "needs_review" },
  { id: "c", real: true, aiUnit: "store_select", aiTiming: "after_win", aiDecision: "tentative_candidate" },
  { id: "f", real: false, aiUnit: "store_select", aiTiming: "unknown", aiDecision: "needs_review" },
];

describe("正解データの保存: 人の名義・履歴の追記・検証", () => {
  it("AI・自動処理の名義、空の名義は拒否。誤りには正しい方式が必須。不正な値は拒否", () => {
    for (const by of ["AI", "claude-bot", "auto", " "]) expect(appendAnswers({ cases: {} }, { a: { verdict: "correct" } }, by, T1)).toEqual({ ok: false, reason: "reviewer_must_be_human" });
    expect(appendAnswers({ cases: {} }, { a: { verdict: "wrong" } }, "山田", T1).ok).toBe(false);
    expect(appendAnswers({ cases: {} }, { a: { verdict: "wrong", correctUnit: "unknown" } }, "山田", T1).ok).toBe(false);
    expect(appendAnswers({ cases: {} }, { a: { verdict: "maybe" } }, "山田", T1).ok).toBe(false);
    expect(appendAnswers({ cases: {} }, { a: { verdict: "wrong", correctUnit: "per_store", correctTiming: "someday" } }, "山田", T1).ok).toBe(false);
  });
  it("回答は履歴に追記され、過去の回答は消えない（訂正履歴）。同じ内容の再送は履歴を増やさない。確認者・日時が残る", () => {
    const r1 = appendAnswers({ cases: {} }, { a: { verdict: "correct", note: "OK" } }, "山田", T1);
    expect(r1.ok && r1.added).toBe(1);
    const s1 = (r1 as { store: never }).store;
    const same = appendAnswers(s1, { a: { verdict: "correct", note: "OK" } }, "山田", "2026-11-23T00:00:00Z");
    expect(same.ok && same.added).toBe(0);
    const r2 = appendAnswers(s1, { a: { verdict: "wrong", correctUnit: "per_store", correctTiming: "at_apply", note: "ページを確認したら店舗別" } }, "山田", "2026-11-23T00:00:00Z");
    const s2 = (r2 as { store: { cases: { a: { history: unknown[] } } } }).store;
    expect(s2.cases.a.history).toHaveLength(2);
    expect(s2.cases.a.history[0]).toMatchObject({ verdict: "correct", by: "山田", at: T1 });
    expect(currentOf(s2, "a")).toMatchObject({ verdict: "wrong", correctUnit: "per_store" });
  });
});

describe("評価: 人の確認だけから。未確認は未測定。架空は含めない", () => {
  it("回答が無ければ未測定（正解率を出さない・人による検証待ち）", () => {
    const r = evaluate(cases, { cases: {} });
    expect(r).toMatchObject({ measured: false, casesReal: 3, casesFictionalExcluded: 1, pending: 3, reviewed: 0 });
    expect(r.note).toContain("未測定");
    expect(r.unitAgreement).toBeUndefined();
  });
  it("判断不能は一致率の分母に入れない。誤りの回答から、取り違え・誤統合・誤分割・false auto-register を数える。架空ケースの回答は無視", () => {
    let s = { cases: {} } as never;
    const add = (a: Record<string, unknown>) => {
      const r = appendAnswers(s, a, "山田", T1);
      expect(r.ok).toBe(true);
      s = (r as { store: never }).store;
    };
    add({ a: { verdict: "wrong", correctUnit: "per_store" }, b: { verdict: "correct" }, c: { verdict: "undecidable" }, f: { verdict: "correct" } });
    const r = evaluate(cases, s);
    expect(r).toMatchObject({ measured: true, reviewed: 3, decided: 2, undecidable: 1, pending: 0, unitAgreement: { ok: 1, of: 2 }, wrongMerge: 1, wrongSplit: 0, falseAutoRegister: 1 });
    expect(r.confusion).toEqual({ "store_select→per_store": 1 });
    expect(r.timingAgreement).toEqual({ ok: 2, of: 2 }); // a は選択時点を unknown と指定（AIも unknown で一致）、b は正しいと確認
  });
});

describe("確認画面・評価スクリプトの安全性（静的検査）", () => {
  const ui = readFileSync("scripts/review-10s-local.mjs", "utf8");
  it("127.0.0.1だけ・トークン・Host検査。外部通信なし。書き込みは保存処理の1か所。AIの判断を正解として記録する経路が無い", () => {
    expect(ui).toContain('listen(0, "127.0.0.1"');
    expect(ui).toContain("randomBytes");
    expect(ui).not.toMatch(/https?\.request|fetch\(["'`]https?:|node:https|api\.anthropic|@supabase/);
    expect(ui.match(/writeFileSync\(/g)?.length).toBe(1);
    expect(ui.indexOf("writeFileSync(")).toBeGreaterThan(ui.indexOf('"/save"'));
    expect(ui).toContain("appendAnswers(");
    expect(ui).toContain("人が確認したものだけが正解");
    expect(ui).toContain("架空例は実データの正解確認に混ぜない");
  });
});
