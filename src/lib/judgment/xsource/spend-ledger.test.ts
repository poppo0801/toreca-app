// @vitest-environment node
import { describe, expect, it } from "vitest";
import { checkLedger, committedOf, finishRun, startRun, stageKeyOf, type Ledger } from "./spend-ledger";

const empty: Ledger = { runs: [] };
const base = { id: "r1", stageKey: "synthetic_lp|links|from=0|limit=4", startedAt: "2026-11-24T00:00:00Z", approvedTotalJpy: 20, approvedPerCaseJpy: 5 };

describe("費用の通算台帳（プロセスごとにリセットされる関門の上限を、通算で束ねる）", () => {
  it("通算上限を超える承認額は拒否。上限が未指定でも拒否（既定値なし）", () => {
    expect(checkLedger({ ledger: empty, programCapJpy: 60, approvedTotalJpy: 20, stageKey: "a" }).ok).toBe(true);
    expect(checkLedger({ ledger: empty, programCapJpy: 60, approvedTotalJpy: 61, stageKey: "a" }).ok).toBe(false);
    expect(checkLedger({ ledger: empty, programCapJpy: 0, approvedTotalJpy: 20, stageKey: "a" }).errors.join()).toContain("program_cap_missing");
  });
  it("終了した実行は実費、未終了は承認額の満額を使ったものとして数える（保守的）", () => {
    let l = startRun(empty, base);
    expect(committedOf(l)).toEqual({ committedJpy: 20, unfinished: ["r1"] });
    l = finishRun(l, "r1", 12.46, "2026-11-24T00:10:00Z");
    expect(committedOf(l)).toEqual({ committedJpy: 12.46, unfinished: [] });
  });
  it("段階をまたぐ通算: 20+20+20+15=75円の承認は、通算上限60円では最後の段階が残額不足で拒否される（実費が少なければ通る）", () => {
    let l = empty;
    // 実費が承認額いっぱい（最悪）の場合
    for (const [i, a] of [20, 20, 20].entries()) {
      expect(checkLedger({ ledger: l, programCapJpy: 60, approvedTotalJpy: a, stageKey: `s${i}` }).ok, `s${i}`).toBe(true);
      l = finishRun(startRun(l, { ...base, id: `r${i}`, stageKey: `s${i}`, approvedTotalJpy: a }), `r${i}`, a, "t");
    }
    const last = checkLedger({ ledger: l, programCapJpy: 60, approvedTotalJpy: 15, stageKey: "real" });
    expect(last.ok).toBe(false);
    expect(last.errors.join()).toContain("exceeds_remaining");
    // 実費が期待どおり（約12.5円×3）なら、残りで実投稿（15円）も通る
    let l2 = empty;
    for (let i = 0; i < 3; i++) l2 = finishRun(startRun(l2, { ...base, id: `q${i}`, stageKey: `s${i}` }), `q${i}`, 12.5, "t");
    expect(checkLedger({ ledger: l2, programCapJpy: 60, approvedTotalJpy: 15, stageKey: "real" })).toMatchObject({ ok: true, remainingJpy: 22.5 });
  });
  it("同じ段階の二重実行は拒否（意図した再実行は明示し、費用は通算に加算される）。未終了の実行があると新しい実行を止める", () => {
    const l = finishRun(startRun(empty, base), "r1", 10, "t");
    expect(checkLedger({ ledger: l, programCapJpy: 60, approvedTotalJpy: 20, stageKey: base.stageKey }).errors.join()).toContain("stage_already_run");
    expect(checkLedger({ ledger: l, programCapJpy: 60, approvedTotalJpy: 20, stageKey: base.stageKey, allowRerun: true }).ok).toBe(true);
    const u = startRun(empty, base);
    expect(checkLedger({ ledger: u, programCapJpy: 60, approvedTotalJpy: 20, stageKey: "other" }).errors.join()).toContain("unfinished_runs");
  });
  it("段階の識別子は、データセット・実験・案件範囲で決まる（実験の順序は無関係）", () => {
    expect(stageKeyOf({ dataset: "synthetic_lp", experiments: ["links", "image"], from: 0, limit: 4 })).toBe(stageKeyOf({ dataset: "synthetic_lp", experiments: ["image", "links"], from: 0, limit: 4 }));
    expect(stageKeyOf({ dataset: "real_post", experiments: ["links"], from: 0, limit: null })).toContain("limit=all");
  });
});
