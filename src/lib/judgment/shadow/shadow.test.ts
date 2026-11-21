// @vitest-environment node
/**
 * Stage 10F シャドーモードの検査。**無課金・架空データ・モックの新方式のみ**。本番DB・実原文・外部AI・課金APIには接続しない。
 * 目的: 旧方式への影響ゼロ（副作用なし・失敗しても旧方式が継続）、初期OFF、緊急停止、上限、重複防止、記録の非機微性。
 */
import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import type { JudgmentInput } from "../contract";
import { mockAnswer } from "../eval/mock-answers";
import { mockHoldout } from "../eval/mock-answers-holdout";
import { mockUnseen } from "../eval/mock-answers-unseen";
import { inputFor, legacyStructure, loadCases, type ReplayCase } from "../eval/replay";
import { ScriptedModel } from "../model";
import { shadowConfig, type ShadowConfig } from "./config";
import { ShadowController } from "./controller";
import { assertSafeRecord, compareLegacyNew, LocalFileSink, MemorySink, summarizeShadow, type LegacySummary } from "./record";

const ON = { TOREMANE_ENV: "local", SHADOW_JUDGMENT: "on" };
const cfgOn = (over: Partial<ShadowConfig> = {}): ShadowConfig => ({ ...shadowConfig(ON), ...over });

const sets = (["main", "unseen", "holdout"] as const).map((s) => ({ s, ...loadCases(s) }));
const answerFor = (s: string, c: ReplayCase, input: JudgmentInput): unknown => (s === "main" ? mockAnswer(c.id, input) : s === "unseen" ? mockUnseen(c.id) : mockHoldout(c.id));
const legacyOf = (c: ReplayCase): LegacySummary => ({ structure: legacyStructure(c), opportunityCount: null, duplicateCount: null });

describe("設定: 初期OFF。明示的な条件がすべて揃ったときだけ有効", () => {
  it("既定・未設定・off はすべて無効（シャドーを呼ばない）", () => {
    expect(shadowConfig({}).enabled).toBe(false);
    expect(shadowConfig({}).reason).toBe("off");
    expect(shadowConfig({ TOREMANE_ENV: "local" }).enabled).toBe(false);
    expect(shadowConfig({ TOREMANE_ENV: "local", SHADOW_JUDGMENT: "off" }).enabled).toBe(false);
    expect(shadowConfig({ TOREMANE_ENV: "local", SHADOW_JUDGMENT: "true" }).enabled).toBe(false); // on 以外は無効
  });
  it("開発環境以外・本番/Vercel・緊急停止・実AIモードでは、フラグがonでも無効", () => {
    expect(shadowConfig({ SHADOW_JUDGMENT: "on" }).reason).toBe("not_local");
    expect(shadowConfig({ ...ON, NODE_ENV: "production" }).reason).toBe("production_env");
    expect(shadowConfig({ ...ON, VERCEL: "1" }).reason).toBe("production_env");
    expect(shadowConfig({ ...ON, VERCEL_ENV: "production" }).reason).toBe("production_env");
    expect(shadowConfig({ ...ON, SHADOW_JUDGMENT_KILL: "1" }).reason).toBe("killed");
    expect(shadowConfig({ ...ON, SHADOW_JUDGMENT_MODE: "real" })).toMatchObject({ enabled: false, reason: "real_mode_unapproved" });
    expect(shadowConfig(ON)).toMatchObject({ enabled: true, mode: "mock" });
  });
  it("上限値は範囲に丸められ、不正な値は既定に戻る", () => {
    const c = shadowConfig({ ...ON, SHADOW_JUDGMENT_MAX_PER_HOUR: "99999", SHADOW_JUDGMENT_BUDGET_JPY: "9999", SHADOW_JUDGMENT_TIMEOUT_MS: "abc", SHADOW_JUDGMENT_MAX_CONCURRENT: "50" });
    expect([c.maxPerWindow, c.budgetCapJpy, c.timeoutMs, c.maxConcurrent]).toEqual([200, 50, 20000, 3]);
  });
});

describe("無効のとき: 何もしない（新方式を呼ばない・何も書かない）", () => {
  it("フラグOFFならモデルは1回も呼ばれず、記録もされない", async () => {
    const model = new ScriptedModel(() => ({ raw: {}, costJpy: 0 }));
    const sink = new MemorySink();
    const sc = new ShadowController({ model, sink, config: () => shadowConfig({}) });
    const { cases, now } = sets[0];
    const r = await sc.observe({ caseKey: "k", input: await inputFor(cases[0], now), legacy: legacyOf(cases[0]) });
    expect(r).toEqual({ ran: false, skipped: "off" });
    expect(model.calls).toBe(0);
    expect(sink.records).toEqual([]);
  });
});

describe("ローカルシャドー（モックの新方式）: 旧19件・K12件・H6件", () => {
  it("全37件を実行でき、記録は非機微（原文・URL・ID・名前を含まない）で、旧方式の要約と新方式の要約が残る", async () => {
    const sink = new MemorySink();
    let mock: (i: JudgmentInput) => unknown = () => null;
    const model = new ScriptedModel((i) => ({ raw: mock(i), costJpy: 0.1 }));
    const sc = new ShadowController({ model, sink, config: () => cfgOn({ maxPerWindow: 100, budgetCapJpy: 50 }) });
    let n = 0;
    const texts: string[] = [];
    for (const { s, cases, now } of sets) {
      for (const c of cases) {
        const input = await inputFor(c, now);
        for (const e of input.evidence) if (e.text) texts.push(e.text);
        for (const r of input.related) texts.push(r.lotteryId);
        mock = (i) => answerFor(s, c, i);
        const out = await sc.observe({ caseKey: `${s}:${c.id}`, input, legacy: legacyOf(c) });
        if (out.ran) n++;
      }
    }
    expect(n).toBe(sink.records.length);
    expect(n).toBeGreaterThanOrEqual(30); // J04/J05 等、台本が無い事例は error/unresolved になりうるが記録は残る
    const all = JSON.stringify(sink.records);
    for (const t of texts) expect(all, t.slice(0, 20)).not.toContain(t.slice(0, 20));
    expect(all).not.toMatch(/https?:|example\.invalid|L-[A-Z]\d/);
    for (const r of sink.records) assertSafeRecord(r);
    const sum = summarizeShadow(sink.records);
    expect(sum.total).toBe(n);
    expect(sum.notice).toContain("正解率ではありません");
    expect(sum.suspectedFalseMerge + sum.suspectedFalseSplit).toBeLessThanOrEqual(n);
  });
});

describe("比較: 旧方式が表現できない構造を不正解と混同しない", () => {
  const legacy: LegacySummary = { structure: "unknown", opportunityCount: 1, duplicateCount: 0 };
  const out = (kind: string, n: number, rel: string[] = []) =>
    ({
      structure: { kind },
      opportunities: Array.from({ length: n }, (_, i) => ({ key: `O${i}` })),
      relations: rel.map((r) => ({ relation: r })),
      unresolved: [],
    }) as never;
  it("商品別・開催回別・1送信複数独立は legacy_unexpressible で、機会が増えても誤分割の疑いにしない", () => {
    const c = compareLegacyNew(legacy, out("per_product", 3));
    expect(c).toMatchObject({ structure: "legacy_unexpressible", count: "new_more", suspectedFalseSplit: false });
  });
  it("旧が表現できる構造で新方式が機会を増やせば誤分割の疑い、減らせば誤統合の疑い。同一の件数差も疑いとして出る", () => {
    expect(compareLegacyNew({ ...legacy, structure: "store_select" }, out("per_store", 3))).toMatchObject({ structure: "mismatch", suspectedFalseSplit: true });
    expect(compareLegacyNew({ ...legacy, opportunityCount: 3 }, out("store_select", 1))).toMatchObject({ count: "new_fewer", suspectedFalseMerge: true });
    expect(compareLegacyNew({ ...legacy, duplicateCount: 0 }, out("one_form_one", 1, ["same"]))).toMatchObject({ suspectedFalseMerge: true });
    expect(compareLegacyNew({ ...legacy, duplicateCount: 2 }, out("one_form_one", 1, ["same"]))).toMatchObject({ suspectedFalseSplit: true });
  });
  it("新方式の保留は不正解ではなく hold。旧 unknown と新 one_form_one は一致、出力なしは比較不能", () => {
    expect(compareLegacyNew(legacy, out("unknown", 1))).toMatchObject({ structure: "new_hold", hold: true });
    expect(compareLegacyNew(legacy, out("one_form_one", 1)).structure).toBe("match");
    expect(compareLegacyNew(legacy, null).structure).toBe("not_comparable");
  });
});

describe("旧方式への影響ゼロ: 副作用なし・失敗してもシャドーは例外を出さない", () => {
  const { cases, now } = sets[0];
  const j01 = cases.find((c) => c.id === "J01")!;
  const good = (i: JudgmentInput) => mockAnswer("J01", i);
  it("入力・旧方式の要約を変更しない（深く凍結しても例外にならず、同一の内容のまま）", async () => {
    const input = await inputFor(j01, now);
    const snap = JSON.stringify(input);
    const legacy = Object.freeze(legacyOf(j01));
    const deepFreeze = (o: unknown): void => {
      if (o && typeof o === "object") for (const v of Object.values(o)) { deepFreeze(v); Object.freeze(v); }
    };
    deepFreeze(input);
    const sc = new ShadowController({ model: new ScriptedModel((i) => ({ raw: good(i), costJpy: 0.1 })), sink: new MemorySink(), config: () => cfgOn() });
    const r = await sc.observe({ caseKey: "x", input, legacy });
    expect(r.ran).toBe(true);
    expect(JSON.stringify(input)).toBe(snap);
  });
  it("モデルが例外・不正な出力・ハングしても、シャドーは例外を出さずに結果を返す（旧方式は継続）", async () => {
    const input = await inputFor(j01, now);
    const boom = new ShadowController({ model: new ScriptedModel(() => { throw new Error("boom"); }), sink: new MemorySink(), config: () => cfgOn() });
    await expect(boom.observe({ caseKey: "a", input, legacy: legacyOf(j01) })).resolves.toMatchObject({ ran: true });
    const bad = new ShadowController({ model: new ScriptedModel(() => ({ raw: { nonsense: true }, costJpy: 0.1 })), sink: new MemorySink(), config: () => cfgOn() });
    const rb = await bad.observe({ caseKey: "a", input, legacy: legacyOf(j01) });
    expect(rb.ran).toBe(true);
    expect(rb.record?.status).toBe("unresolved");
    const hang = new ShadowController({ model: new ScriptedModel(() => new Promise(() => undefined)), sink: new MemorySink(), config: () => cfgOn({ timeoutMs: 50 }) });
    const t0 = Date.now();
    const rh = await hang.observe({ caseKey: "a", input, legacy: legacyOf(j01) });
    expect(Date.now() - t0).toBeLessThan(2000);
    expect(rh.record?.status).toBe("timeout");
    expect(rh.record?.costJpy).toBeNull();
  });
  it("保存先の失敗でも例外を出さず、失敗件数を数える。安全でない記録は保存しない", async () => {
    const input = await inputFor(j01, now);
    const failing = { write: async () => { throw new Error("disk"); } };
    const sc = new ShadowController({ model: new ScriptedModel((i) => ({ raw: good(i), costJpy: 0.1 })), sink: failing, config: () => cfgOn() });
    const r = await sc.observe({ caseKey: "a", input, legacy: legacyOf(j01) });
    expect(r.ran).toBe(true);
    expect(sc.sinkFailures).toBe(1);
    expect(() => assertSafeRecord({ note: "お名前: 山田太郎 https://x.invalid/a" })).toThrow();
    expect(() => assertSafeRecord({ "お名前": 1 })).toThrow();
  });
  it("実装は、DB・サーバー・ネットワーク・実AIのモジュールを読み込まない（静的検査）。通常の収集経路（run.ts）はシャドーを呼ばない", () => {
    for (const f of ["config.ts", "controller.ts", "record.ts"]) {
      const src = readFileSync(`src/lib/judgment/shadow/${f}`, "utf8");
      expect(src, f).not.toMatch(/from "@\/lib\/server|supabase|anthropic|\bfetch\(|from "@\/lib\/ai|collection_candidates|case_judgments/i);
    }
    expect(readFileSync("src/lib/server/collector/run.ts", "utf8")).not.toContain("judgment/shadow");
  });
  it("ネットワークを使わない（fetch が呼ばれない）", async () => {
    const spy = vi.spyOn(globalThis, "fetch").mockImplementation(() => { throw new Error("network"); });
    const input = await inputFor(j01, now);
    const sc = new ShadowController({ model: new ScriptedModel((i) => ({ raw: good(i), costJpy: 0.1 })), sink: new MemorySink(), config: () => cfgOn() });
    await sc.observe({ caseKey: "a", input, legacy: legacyOf(j01) });
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });
});

describe("上限・重複防止・緊急停止", () => {
  const { cases, now } = sets[0];
  const j01 = cases.find((c) => c.id === "J01")!;
  const j02 = cases.find((c) => c.id === "J02")!;
  const mk = (cfg: () => ShadowConfig, nowFn?: () => number, cost = 0.1) => {
    const model = new ScriptedModel((i) => ({ raw: mockAnswer("J01", i), costJpy: cost }), undefined, 0.5);
    return { model, sc: new ShadowController({ model, sink: new MemorySink(), config: cfg, now: nowFn }) };
  };
  it("同じ入力は2回目をスキップ（重複防止）。同時の重複もスキップ", async () => {
    const input = await inputFor(j01, now);
    const { model, sc } = mk(() => cfgOn({ maxConcurrent: 3 }));
    const [a, b] = await Promise.all([sc.observe({ caseKey: "a", input, legacy: legacyOf(j01) }), sc.observe({ caseKey: "a", input, legacy: legacyOf(j01) })]);
    expect([a.ran, b.ran].sort()).toEqual([false, true]);
    const c = await sc.observe({ caseKey: "a", input, legacy: legacyOf(j01) });
    expect(c).toEqual({ ran: false, skipped: "duplicate" });
    expect(model.calls).toBe(1);
  });
  it("回数上限（時間窓）を超えるとスキップし、窓が過ぎれば再開する", async () => {
    let t = 1_000_000;
    const { sc } = mk(() => cfgOn({ maxPerWindow: 1, windowMs: 1000, maxConcurrent: 3 }), () => t);
    const i1 = await inputFor(j01, now);
    const i2 = await inputFor(j02, now);
    expect((await sc.observe({ caseKey: "1", input: i1, legacy: legacyOf(j01) })).ran).toBe(true);
    expect(await sc.observe({ caseKey: "2", input: i2, legacy: legacyOf(j02) })).toEqual({ ran: false, skipped: "rate_limited" });
    t += 2000;
    expect((await sc.observe({ caseKey: "2", input: i2, legacy: legacyOf(j02) })).ran).toBe(true);
  });
  it("費用上限: 予約が残額を超える見込みなら呼ばない。実行した分は計上される", async () => {
    const { model, sc } = mk(() => cfgOn({ budgetCapJpy: 0.6, perCaseCapJpy: 0.5 }));
    const i1 = await inputFor(j01, now);
    const i2 = await inputFor(j02, now);
    expect((await sc.observe({ caseKey: "1", input: i1, legacy: legacyOf(j01) })).ran).toBe(true);
    const s2 = await sc.observe({ caseKey: "2", input: i2, legacy: legacyOf(j02) });
    expect(model.calls).toBeGreaterThanOrEqual(1);
    expect(sc.spentJpy()).toBeLessThanOrEqual(0.6);
    if (!s2.ran) expect(s2.skipped).toBe("budget_exhausted");
  });
  it("緊急停止: 実行中でも、環境変数を変えるだけで次の呼び出しから停止（再起動不要）", async () => {
    const env: Record<string, string> = { ...ON };
    const { model, sc } = mk(() => shadowConfig(env));
    const i1 = await inputFor(j01, now);
    const i2 = await inputFor(j02, now);
    expect((await sc.observe({ caseKey: "1", input: i1, legacy: legacyOf(j01) })).ran).toBe(true);
    env.SHADOW_JUDGMENT_KILL = "1";
    expect(await sc.observe({ caseKey: "2", input: i2, legacy: legacyOf(j02) })).toEqual({ ran: false, skipped: "killed" });
    expect(model.calls).toBe(1);
    env.SHADOW_JUDGMENT = "off"; // 旧方式のみに戻す
    expect((await sc.observe({ caseKey: "2", input: i2, legacy: legacyOf(j02) })).ran).toBe(false);
  });
});

describe("保存先: ローカルの eval/runs/shadow/ 配下のみ（DBに書かない）", () => {
  it("ファイル名の検査（パス区切り・拡張子違いは拒否）", () => {
    expect(() => new LocalFileSink("../x.jsonl")).toThrow();
    expect(() => new LocalFileSink("a/b.jsonl")).toThrow();
    expect(() => new LocalFileSink("x.txt")).toThrow();
    expect(() => new LocalFileSink("ok-1.jsonl")).not.toThrow();
  });
  it("eval/runs/ は .gitignore に含まれる（記録をコミットしない）", () => {
    expect(readFileSync(".gitignore", "utf8").split(/\r?\n/)).toContain("eval/runs/");
  });
});
