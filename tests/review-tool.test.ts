// @vitest-environment node
import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";
// @ts-expect-error -- 型宣言のない JS モジュール（スクリプト用）
import { buildCase, classifyExclusion, extractAi, htmlToText, isFetchableSourceUrl, pickCandidates } from "../scripts/lib/review-set-build.mjs";

/** Stage 9F-2: 正誤チェックツールの共通ロジックと、事例集の組み立て。架空データのみ */
const require = createRequire(import.meta.url);
const C = require("../tools/review/review-core.js");
const sample = require("../tools/review/sample/sample-set.json");

describe("事例集の検証（入力と正解の分離）", () => {
  it("見本の事例集は有効", () => expect(C.validateSet(sample).ok).toBe(true));
  it("人間の評価が混ざった事例集・format違い・caseId重複は拒否する", () => {
    const withAnswer = { ...sample, cases: [{ ...sample.cases[0], human: { verdict: "correct" } }] };
    expect(C.validateSet(withAnswer).ok).toBe(false);
    expect(C.validateSet({ ...sample, format: "x" }).ok).toBe(false);
    expect(C.validateSet({ ...sample, cases: [sample.cases[0], sample.cases[0]] }).errors.join()).toContain("重複");
  });
});

describe("評価の検証（正解データに混ぜてよいか）", () => {
  const ev = (verdict: string | null, patch: Record<string, unknown> = {}) => ({ ...C.emptyEvaluation("c"), verdict, ...patch });
  it("一部修正は誤りの項目が必須。間違いは処理判断の正しい値かコメントが必須", () => {
    expect(C.validateEvaluation(ev("partial")).length).toBe(1);
    const e = ev("partial");
    e.fields.chain = { state: "wrong", value: "A" };
    expect(C.validateEvaluation(e)).toEqual([]);
    expect(C.validateEvaluation(ev("wrong")).length).toBe(1);
    const w = ev("wrong");
    w.fields.decision = { state: "wrong", value: "" };
    expect(C.validateEvaluation(w).join()).toContain("正しい値");
    w.fields.decision.value = "register";
    expect(C.validateEvaluation(w)).toEqual([]);
  });
  it("判断できない・未評価・矛盾した入力は正解データに使わない", () => {
    expect(C.usableAsGold(ev("unknown"))).toBe(false);
    expect(C.usableAsGold(ev(null))).toBe(false);
    const c = ev("correct");
    c.fields.store = { state: "wrong", value: "x" };
    expect(C.usableAsGold(c)).toBe(false);
    expect(C.usableAsGold(ev("correct"))).toBe(true);
  });
  it("「不明なだけ」は誤りと区別して保存される", () => {
    const e = ev("correct");
    e.fields.resultDate.state = "unknown_only";
    const out = C.buildExport(sample, { [sample.cases[0].caseId]: e }, new Date("2026-11-14T00:00:00Z"));
    expect(out.results[0].human.unknownOnlyFields).toEqual(["resultDate"]);
    expect(out.results[0].human.corrections).toEqual([]);
    expect(out.results[0].human.usableAsGold).toBe(true);
  });
});

describe("書き出しと再読み込み", () => {
  const now = new Date("2026-11-14T01:00:00Z");
  const e1 = { ...C.emptyEvaluation("c01"), verdict: "partial", comment: "日本語 \"引用\" <b>&</b>\n改行", evaluatedAt: now.toISOString() };
  e1.fields.store = { state: "wrong", value: "新潟店" };
  const out = C.buildExport(sample, { c01: e1 }, now);
  it("AIの元の判定はそのまま・人間の評価は別に保存・未入力の事例は書き出さない", () => {
    expect(out.results).toHaveLength(1);
    expect(out.results[0].aiOriginal).toEqual(sample.cases[0].ai);
    expect(out.results[0].human.corrections).toEqual([{ field: "store", correctValue: "新潟店" }]);
    expect(out.results[0].evaluationId).toContain("c01");
    expect(JSON.stringify(sample)).not.toContain("corrections");
  });
  it("書き出し→再読み込みで内容が一致する（往復）", () => {
    const p = C.parseExport(JSON.parse(JSON.stringify(out)), sample);
    expect(p.ok).toBe(true);
    expect(p.evals.c01.verdict).toBe("partial");
    expect(p.evals.c01.fields.store).toEqual({ state: "wrong", value: "新潟店" });
    expect(p.evals.c01.comment).toBe(e1.comment);
    expect(C.buildExport(sample, p.evals, now).results[0].human).toEqual(out.results[0].human);
  });
  it("別の事例集・内容が変わった事例は取り込まない", () => {
    expect(C.parseExport({ ...out, setId: "other" }, sample).ok).toBe(false);
    const changed = JSON.parse(JSON.stringify(sample));
    changed.cases[0].ai.reasons = ["変更"];
    const p = C.parseExport(out, changed);
    expect(Object.keys(p.evals)).toHaveLength(0);
    expect(p.warnings.join()).toContain("変わっている");
  });
  it("保存データの欠損・不正値は安全な既定値になる", () => {
    const n = C.normalizeEvaluation({ verdict: "zzz", fields: { chain: { state: "bad", value: 5 } }, comment: 3 }, "c");
    expect(n.verdict).toBeNull();
    expect(n.fields.chain).toEqual({ state: "unset", value: "" });
    expect(n.comment).toBe("");
  });
});

describe("集計・絞り込み・URLの安全性", () => {
  const evals = { c01: { ...C.emptyEvaluation("c01"), verdict: "correct" }, c02: { ...C.emptyEvaluation("c02"), verdict: "unknown" } };
  it("評価済み・残件数と絞り込み", () => {
    const s = C.summarize(sample, evals);
    expect([s.total, s.evaluated, s.remaining]).toEqual([5, 2, 3]);
    expect(C.filterCases(sample, evals, { onlyUnevaluated: true }).map((c: { caseId: string }) => c.caseId)).toEqual(["c03", "c04", "c05"]);
    expect(C.filterCases(sample, evals, { verdict: "correct" })).toHaveLength(1);
    expect(C.filterCases(sample, evals, { category: "excluded" })).toHaveLength(1);
  });
  it("リンクは http(s) だけ", () => {
    expect(C.safeHttpUrl("javascript:alert(1)")).toBeNull();
    expect(C.safeHttpUrl("data:text/html,x")).toBeNull();
    expect(C.safeHttpUrl("https://example.com/a")).toBe("https://example.com/a");
  });
});

describe("事例集の組み立て（書き出しスクリプトの純粋な部分）", () => {
  const draft = { input: { chain: { name: "テスト玩具" }, store: { name: "本店" }, storeMode: "fixed", items: [{ product: { name: "ハドウシーカー" } }], applyStart: { precision: "date", date: "2026-11-16", time: "" }, applyDeadline: { precision: "unknown", date: "", time: "" }, resultDate: { precision: "unknown" }, conditionsText: "会員限定", receiveMethod: "store", applications: [{ profileId: "SECRET-PROFILE", status: "applied" }], memo: "SECRET-MEMO", household_id: "SECRET-HH" }, evidence: { applyStart: { quote: "11/16から" } }, notices: ["n"], warnings: ["w"] };
  it("草稿から表示項目だけを取り出し、応募の記録・プロフィールID・メモ・世帯IDは含めない", () => {
    const c = buildCase({ id: "abcdef12-0000", status: "pending", reasons: ["理由"], title: "題", source_url: "https://example.com/", draft, kind: "web", fetched_at: "2026-11-14T00:00:00Z", created_at: "2026-11-14T00:00:00Z", household_id: "SECRET-HH" }, { category: "pending" });
    const json = JSON.stringify(c);
    for (const s of ["SECRET-PROFILE", "SECRET-MEMO", "SECRET-HH"]) expect(json).not.toContain(s);
    expect(c.ai.extracted.applyDeadline).toBeNull();
    expect(c.ai.extracted.applyStart).toBe("2026-11-16");
    expect(c.ai.evidence).toEqual([{ field: "applyStart", quote: "11/16から" }]);
    expect(C.validateSet({ format: "toremane-review-set", version: 1, setId: "s", cases: [c] }).ok).toBe(true);
  });
  it("草稿がない候補（解析前の除外）は抽出結果なしで表現される", () => {
    expect(extractAi(null)).toBeNull();
    expect(buildCase({ id: "x1", status: "excluded", reasons: [] }, { category: "excluded" }).ai.extracted).toBeNull();
  });
  it("除外理由の分類: 収集条件・期間外・統合・分類不能を区別", () => {
    expect(classifyExclusion(["対象外の地域です（北海道）"])).toBe("user_condition_region");
    expect(classifyExclusion(["応募締切を過ぎています"])).toBe("ended_or_before");
    expect(classifyExclusion(["同じ抽選の候補へ統合しました"])).toBe("merged");
    expect(classifyExclusion(["抽選の告知とは判断できませんでした"])).toBe("other_unclassified");
  });
  it("選定: 区分ごとの目安・重複なし・分類不能の除外を優先・同じ入力なら同じ結果", () => {
    const rows = [];
    for (let i = 0; i < 40; i++) rows.push({ id: `e${i}`, status: "excluded", reasons: [i % 2 ? "応募締切を過ぎています" : "抽選の告知とは判断できませんでした"], dedupe_key: `ke${i}`, origin_host: `h${i % 5}` });
    for (let i = 0; i < 10; i++) rows.push({ id: `p${i}`, status: "pending", reasons: [], dedupe_key: `kp${i}` }, { id: `a${i}`, status: "auto_registered", reasons: [], dedupe_key: `ka${i}` }, { id: `d${i}`, status: "duplicate", reasons: [], dedupe_key: `kd${i}` });
    const a = pickCandidates(rows, 30, new Set(["p0", "a0"]));
    expect(pickCandidates(rows, 30, new Set(["p0", "a0"]))).toEqual(a);
    expect(new Set(a.map((x: { id: string }) => x.id)).size).toBe(a.length);
    const ex = a.filter((x: { category: string }) => x.category === "excluded");
    expect(ex).toHaveLength(7);
    expect(ex.every((x: { tags: string[] }) => x.tags.includes("分類不能の除外"))).toBe(true);
    expect(a.filter((x: { category: string }) => x.category === "special")).toHaveLength(2);
  });
  it("本文の取得対象は https の公開ページだけ（X・ローカル・プライベート宛は不可）／HTMLの本文化", () => {
    expect(isFetchableSourceUrl("https://example.com/a")).toBe(true);
    for (const u of ["http://example.com/", "https://x.com/a/status/1", "https://localhost/", "https://192.168.1.1/", "https://10.0.0.5/", "https://[::1]/", "file:///etc/passwd"]) expect(isFetchableSourceUrl(u)).toBe(false);
    expect(htmlToText("<script>x()</script><p>応募期間&nbsp;11/16</p><style>a{}</style>")).toBe("応募期間 11/16");
  });
});
