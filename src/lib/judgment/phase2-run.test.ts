// @vitest-environment node
/**
 * 実データ新旧比較ランナーの検査（Stage 10F）。**架空データ・台本モデルのみ。実AI・実原文・本番DBには触れない**。
 * 未承認・未確認・漏洩・費用超過では、外部（モデル）へ何も渡らないこと、記録が非機微であることを確認する。
 */
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { JudgmentInput } from "./contract";
import { assertMaySendShadow, prepareForExternal, type StoredRow } from "./eval/phase2";
import { legacyFromText, runPhase2Comparison, type Phase2RunDeps } from "./eval/phase2-run";
import { ScriptedModel } from "./model";
import { MemorySink } from "./shadow/record";

const CLEAN = (n: number) => `サンプルゲーム 北店 抽選販売 第${n}弾。応募期間 2099-04-01〜2099-04-08。当選発表 2099-04-12。`;
const row = (id: string, text: string | null): StoredRow => ({ id, stratum: "unlabeled", text, fetchedAt: "2099-01-01T00:00:00Z" });
const okGate = { ok: true, missing: [] as string[] };
const answer = (i: JudgmentInput): unknown => ({
  version: "10e.2",
  caseType: { value: "lottery_announcement", basis: "fact", citations: [{ evidenceId: "E1", quote: (i.evidence[0].text ?? "").slice(0, 8) }] },
  structure: { kind: "one_form_one", basis: "inference", rationale: "テスト", citations: [] },
  opportunities: [{ key: "O1", label: "テスト", applyDeadline: { value: "2099-04-08", basis: "fact", citations: [{ evidenceId: "E1", quote: "2099-04-01〜2099-04-08" }] } }],
  relations: [],
  plannedChanges: [],
  unresolved: [],
  nextActions: [{ kind: "none", reason: "テスト" }],
});
const mk = (over: Partial<Phase2RunDeps> = {}, cost = 0.2) => {
  const seen: JudgmentInput[] = [];
  const model = new ScriptedModel((i) => { seen.push(i); return { raw: answer(i), costJpy: cost }; }, undefined, 0.5);
  const sink = new MemorySink();
  const deps: Phase2RunDeps = { model, sink, gates: okGate, reviewedIds: new Set(["r1", "r2", "r3"]), totalCapJpy: 5, perCaseCapJpy: 2, now: new Date("2099-01-20T00:00:00Z"), ...over };
  return { model, sink, seen, deps };
};
const rows = () => [row("r1", CLEAN(1)), row("r2", CLEAN(2)), row("r3", CLEAN(3))];

describe("実データ新旧比較ランナー: 事前確認に失敗したら、モデルに何も渡さない", () => {
  it("承認ゲート未承認・人の全件目視の記録なし・漏洩検出・原文なし・費用上限の不正は、モデルを1回も呼ばず例外", async () => {
    const cases: [string, Partial<Phase2RunDeps>, StoredRow[]][] = [
      ["gate", { gates: { ok: false, missing: ["C", "E"] } }, rows()],
      ["unreviewed", { reviewedIds: new Set(["r1", "r2"]) }, rows()],
      ["leak", { reviewedIds: new Set(["r1", "r2", "r3"]) }, [...rows(), row("r4", `${CLEAN(4)} お名前: ダミー太郎`)]],
      ["notext", {}, [...rows(), row("r5", null)]],
      ["cap0", { totalCapJpy: 0 }, rows()],
      ["per>total", { perCaseCapJpy: 9 }, rows()],
    ];
    for (const [name, over, rs] of cases) {
      const t = mk({ ...over, reviewedIds: over.reviewedIds ?? new Set(["r1", "r2", "r3", "r4", "r5"]) });
      await expect(runPhase2Comparison(rs, t.deps), name).rejects.toThrow();
      expect(t.model.calls, name).toBe(0);
      expect(t.sink.records, name).toEqual([]);
    }
  });
  it("gold（D）は要求しない（承認A・B・C・E相当のゲート判定と全件目視だけで実行できる）", async () => {
    const t = mk();
    expect(() => assertMaySendShadow(okGate, prepareForExternal(rows(), new Set(["r1", "r2", "r3"])))).not.toThrow();
    const r = await runPhase2Comparison(rows(), t.deps);
    expect(r.sent).toBe(3);
  });
});

describe("実データ新旧比較ランナー: 外部に渡す内容・記録・費用", () => {
  it("新方式に渡す入力は、伏せ字後の本文と無効なプレースホルダーURLだけ（元のID・URL・取得日時・ハッシュ・既存抽選を含まない）。正解の項目も含まれない", async () => {
    const t = mk();
    const rs = [{ ...row("secret-id-1", `${CLEAN(1)} 連絡先 dummy@example.invalid`), fetchedAt: "2098-12-31T23:59:59Z" }, row("secret-id-2", CLEAN(2))];
    t.deps.reviewedIds = new Set(["secret-id-1", "secret-id-2"]);
    const r = await runPhase2Comparison(rs, t.deps);
    expect(r.sent).toBe(2);
    const all = JSON.stringify(t.seen);
    for (const bad of ["secret-id", "dummy@example.invalid", "2098-12-31", "opportunityCount", "gold"]) expect(all).not.toContain(bad);
    expect(t.seen.every((i) => i.evidence.length === 1 && i.evidence[0].url.startsWith("https://evidence.invalid/") && i.evidence[0].hash === null && i.related.length === 0)).toBe(true);
    // 記録は非機微（原文・ID・URLなし）。連番↔行の対応は戻り値だけ（記録・サマリーに出ない）
    const rec = JSON.stringify(t.sink.records) + JSON.stringify(r.summary);
    for (const bad of ["secret-id", "サンプルゲーム", "evidence.invalid", "dummy"]) expect(rec).not.toContain(bad);
    expect(r.seqOf.get(1)).toBe("secret-id-1");
    expect(r.records.every((x) => x.legacySource === "fixed_form_judge")).toBe(true);
  });
  it("旧方式は固定の形態判定のみ。応募機会数・重複件数・商品数は null（架空の数値を補わない）。注意書きは『正解率ではない』", async () => {
    const l = legacyFromText(CLEAN(1));
    expect([l.opportunityCount, l.itemCount, l.duplicateCount, l.duplicateHighCount]).toEqual([null, null, null, null]);
    const r = await runPhase2Comparison(rows(), mk().deps);
    expect(r.notice).toContain("正解率ではありません");
    expect(r.summary.total).toBe(3);
    expect(r.records.every((x) => x.legacy.opportunityCount === null && x.compare.count === "not_comparable")).toBe(true);
  });
  it("費用上限: 事前予約が残額を超える見込みになったら、以降は実行せず（未実行として数える）、上限を超えない。重複した原文は二重に送らない", async () => {
    const t = mk({ totalCapJpy: 0.6, perCaseCapJpy: 0.5 }, 0.3);
    const r = await runPhase2Comparison(rows(), t.deps);
    expect(r.sent).toBeLessThan(3);
    expect(r.skipped.budget).toBeGreaterThanOrEqual(1);
    expect(r.spentJpy).toBeLessThanOrEqual(0.6);
    const d = mk();
    const dup = await runPhase2Comparison([row("r1", CLEAN(1)), row("r2", CLEAN(1)), row("r3", CLEAN(3))], d.deps);
    expect(dup.skipped.duplicate).toBe(1);
    expect(d.model.calls).toBe(2);
  });
  it("新方式の失敗（例外）でも例外を出さず、状態が記録される", async () => {
    const t = mk();
    const bad = new ScriptedModel(() => { throw new Error("boom"); }, undefined, 0.5);
    const r = await runPhase2Comparison(rows(), { ...t.deps, model: bad });
    expect(r.records.length).toBe(3);
    expect(r.summary.byStatus.unresolved ?? r.summary.byStatus.model_error ?? 0).toBeGreaterThan(0);
  });
});

describe("評価スクリプト: 未承認では実行できない（実AI・外部送信・課金なし）", () => {
  it("--confirm=yes や承認額がなければ終了コード2。承認記録がなければ（確認付きでも）関門で停止し、終了コードは0以外。承認記録ファイルは作られない", () => {
    const approvalsBefore = existsSync("eval/real-data/approvals.json") ? readFileSync("eval/real-data/approvals.json", "utf8") : null; // ローカルの承認記録（あれば）をテストが変更しないこと
    const base = { encoding: "utf8" as const, env: { ...process.env, TOREMANE_ENV: "local", JUDGMENT_REAL_EVAL: "allow", NEXT_PUBLIC_SUPABASE_URL: "" } };
    expect(spawnSync("node", ["scripts/eval-judgment-phase2.mjs", "run", "--approved-total-jpy=5", "--approved-per-case-jpy=2"], base).status).toBe(2);
    expect(spawnSync("node", ["scripts/eval-judgment-phase2.mjs", "bogus"], base).status).toBe(2);
    const r = spawnSync("node", ["scripts/eval-judgment-phase2.mjs", "run", "--approved-total-jpy=5", "--approved-per-case-jpy=2", "--confirm=yes"], base);
    expect(r.status).not.toBe(0);
    expect(`${r.stdout}${r.stderr}`).toMatch(/未承認|承認ゲート/);
    expect(existsSync("eval/real-data/approvals.json") ? readFileSync("eval/real-data/approvals.json", "utf8") : null).toBe(approvalsBefore);
  }, 120_000);
});
