import { describe, expect, it } from "vitest";
import { isNoteworthy, pickNotice, runTitle, summarizeRun, type RunCandidateLite, type RunLite } from "@/lib/collector/run-summary";

const run = (o: Partial<RunLite> = {}): RunLite => ({ id: "r1", trigger: "cron", status: "done", started_at: "2026-11-04T21:00:00Z", finished_at: "2026-11-04T21:01:00Z", ...o });
const cand = (o: Partial<RunCandidateLite> = {}): RunCandidateLite => ({ status: "pending", job_state: "review", fail_kind: null, ...o });

describe("収集実行単位の集計", () => {
  it("発見・解析完了・自動登録・確認待ち・取得失敗・対象外・重複・解析待ち・AI費用を、その実行で発見した候補だけから数える", () => {
    const s = summarizeRun(run(), [
      cand({ status: "auto_registered", job_state: "completed", cost_jpy: 0.4, ai_calls: 1 }),
      cand({ status: "auto_registered", job_state: "completed", cost_jpy: 0.6 }),
      cand({ job_state: "review" }),
      cand({ status: "failed", job_state: "failed", fail_kind: "robots" }),
      cand({ status: "excluded", job_state: "skipped" }),
      cand({ status: "duplicate", job_state: "completed" }),
    ]);
    expect(s).toMatchObject({ discovered: 6, analyzed: 6, autoRegistered: 2, review: 1, failed: 1, excluded: 1, duplicates: 1, waiting: 0, costJpy: 1, state: "complete", legacy: false });
  });
  it("解析待ちが残っている間は「処理中」。完了前の数字を最終結果として扱わない", () => {
    const s = summarizeRun(run(), [cand({ status: "auto_registered", job_state: "completed" }), cand({ job_state: "pending" }), cand({ job_state: "retry" })]);
    expect(s.state).toBe("processing");
    expect(s.waiting).toBe(2);
    expect(s.analyzed).toBe(1);
    expect(summarizeRun(run({ status: "running" }), []).state).toBe("processing");
    expect(summarizeRun(run({ status: "failed" }), []).state).toBe("failed");
  });
  it("旧形式の実行（候補との紐づけなし）は実行の記録から件数を出し、内訳は出さない", () => {
    const s = summarizeRun(run({ new_count: 12, registered_count: 3 }), []);
    expect(s).toMatchObject({ legacy: true, discovered: 12, autoRegistered: 3, analyzed: 0 });
  });
  it("注目すべき結果: 新規登録・確認が必要な候補・取得エラー。何も無い実行は対象外", () => {
    expect(isNoteworthy(summarizeRun(run(), [cand({ status: "excluded", job_state: "skipped" })]))).toBe(false);
    expect(isNoteworthy(summarizeRun(run(), [cand({ job_state: "review" })]))).toBe(true);
    expect(isNoteworthy(summarizeRun(run(), [cand({ status: "failed", job_state: "failed" })]))).toBe(true);
  });
});

describe("起動時ポップアップの対象", () => {
  const sum = (id: string, startedAt: string, cands: RunCandidateLite[], over: Partial<RunLite> = {}) => summarizeRun(run({ id, started_at: startedAt, ...over }), cands);
  it("確認済みの実行は出さない（同じ結果を繰り返し表示しない）", () => {
    const s = sum("a", "2026-11-04T21:00:00Z", [cand()]);
    expect(pickNotice([s], new Set()).show?.runId).toBe("a");
    expect(pickNotice([s], new Set(["a"])).show).toBeNull();
  });
  it("重要な結果が無ければ出さない", () => {
    expect(pickNotice([sum("a", "2026-11-04T21:00:00Z", [cand({ status: "excluded", job_state: "skipped" })])], new Set()).show).toBeNull();
  });
  it("新しい完了済みの実行を出し、それ以前の確認済みでない実行もまとめて確認済みにできる", () => {
    const old = sum("old", "2026-11-03T21:00:00Z", [cand()]);
    const now = sum("new", "2026-11-04T21:00:00Z", [cand()]);
    const p = pickNotice([old, now], new Set());
    expect(p.show?.runId).toBe("new");
    expect(p.ackIds.sort()).toEqual(["new", "old"]);
  });
  it("最新の定期収集の解析が途中なら出さず、確認済みにもしない（完了を待つ）。3時間を過ぎたら最終結果として扱う", () => {
    const proc = sum("p", "2026-11-04T21:00:00Z", [cand({ status: "auto_registered", job_state: "completed" }), cand({ job_state: "pending" })]);
    const t0 = Date.parse("2026-11-04T21:30:00Z");
    expect(pickNotice([proc], new Set(), t0)).toEqual({ show: null, ackIds: [] });
    expect(pickNotice([proc], new Set(), t0 + 3 * 3600_000).show?.runId).toBe("p");
  });
  it("対象は定期収集の最新の1回だけ。以前の結果・手動収集・旧形式は出さず、以前の未確認は確認済みにする", () => {
    const old = sum("old", "2026-11-04T09:00:00Z", [cand()]);
    const manual = sum("man", "2026-11-05T05:00:00Z", [cand()], { trigger: "manual" });
    const latest = sum("new", "2026-11-04T21:00:00Z", [cand({ status: "excluded", job_state: "skipped" })]);
    const p = pickNotice([old, manual, latest], new Set());
    expect(p.show).toBeNull(); // 最新が注目すべき結果でなければ、古い結果にさかのぼって出さない
    expect(p.ackIds.sort()).toEqual(["new", "old"]);
    expect(pickNotice([summarizeRun(run({ new_count: 5, registered_count: 1 }), [])], new Set()).show).toBeNull();
  });
  it("6時と18時の収集: 18時の収集後は、6時の結果が確認済みでも18時の結果を1回出す。確認済みなら出さない", () => {
    const am = sum("am", "2026-11-06T21:00:00Z", [cand()]);
    const pm = sum("pm", "2026-11-07T09:00:00Z", [cand()]);
    expect(pickNotice([am, pm], new Set(["am"])).show?.runId).toBe("pm");
    expect(pickNotice([am, pm], new Set(["am", "pm"])).show).toBeNull();
  });
  it("タイトルは日本時間の日時と実行の種類", () => {
    expect(runTitle({ trigger: "cron", startedAt: "2026-11-04T21:00:00Z" })).toBe("11/5 6:00の定期収集");
    expect(runTitle({ trigger: "manual", startedAt: "2026-11-04T06:30:00Z" })).toContain("手動収集");
  });
});
