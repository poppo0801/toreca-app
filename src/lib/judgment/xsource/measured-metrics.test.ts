// @vitest-environment node
import { describe, expect, it } from "vitest";
import { buildMetricsSnapshot, renderMetrics } from "./measured-metrics";

const get = (ms: ReturnType<typeof buildMetricsSnapshot>, k: string) => ms.find((m) => m.key === k)!;

describe("実測指標（主観の点数を使わない・未測定を値に見せない）", () => {
  it("何も測っていなければ、全て未測定（null）。実AIの試験は0件", () => {
    const ms = buildMetricsSnapshot({});
    expect(ms).toHaveLength(12);
    for (const k of ["discovery_links", "recall", "misregistration", "cost_per_opp", "evidence_read", "gold_targets", "unverified_share", "recheck_recovery"]) expect(get(ms, k).value, k).toBeNull();
    expect(get(ms, "real_eval_runs").value).toBe(0);
    expect(renderMetrics(ms)).toContain("未測定");
  });
  it("実投稿の取得・gold確認・再調査の実測は、実AIが無くても測定済みとして出る（収集の発見率など）", () => {
    const ms = buildMetricsSnapshot({ capture: { shortTotal: 85, shortResolved: 80, casesBuilt: 14 }, gold: { cases: 5, opportunities: 12 }, review: { total: 68, unreviewed: 68 }, recheck: { done: 3, gaveUp: 1, pending: 1 }, historyViolations: 0 });
    expect(get(ms, "discovery_links")).toMatchObject({ state: "measured", n: 85 });
    expect(get(ms, "discovery_links").value).toBeCloseTo(80 / 85);
    expect(get(ms, "unverified_share").value).toBe(1);
    expect(get(ms, "recheck_recovery").value).toBeCloseTo(0.6);
    expect(get(ms, "history_protection").value).toBe(0);
    expect(get(ms, "recall").value).toBeNull();
  });
  it("モック・合成の結果は、再現率・誤登録率・費用に入れない（精度として扱わない）。実AIの結果（accuracy）だけが入る", () => {
    const mock = { dataset: "synthetic_lp" as const, claim: "structure_check_only" as const, oppRecall: { k: 9, n: 10 }, falseRegister: { k: 0, n: 10 }, mismerge: 0, costJpy: 5, opps: 10, seenOk: 9, inInput: 10, repeatedErrors: 0 };
    const a = buildMetricsSnapshot({ experiments: [mock] });
    expect(get(a, "recall").value).toBeNull();
    expect(get(a, "recall").note).toContain("synthetic_only");
    const real = { ...mock, dataset: "real_post" as const, claim: "accuracy" as const, oppRecall: { k: 6, n: 10 }, falseRegister: { k: 1, n: 10 }, mismerge: 1, costJpy: 4, opps: 10 };
    const b = buildMetricsSnapshot({ experiments: [mock, real] });
    expect(get(b, "recall").value).toBeCloseTo(0.6);
    expect(get(b, "misregistration").value).toBeCloseTo(0.1);
    expect(get(b, "cost_per_opp").value).toBeCloseTo(0.4);
    expect(get(b, "real_eval_runs").value).toBe(1);
  });
});
