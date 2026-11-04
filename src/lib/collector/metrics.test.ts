import { describe, expect, it } from "vitest";
import { computeMetrics, type MetricRow } from "@/lib/collector/metrics";

const NOW = new Date("2026-11-04T06:00:00Z");
const row = (o: Partial<MetricRow>): MetricRow => ({ status: "pending", job_state: "review", created_at: "2026-11-04T00:00:00Z", completed_at: null, due_at: null, fail_kind: null, ...o });

describe("収集の品質指標", () => {
  it("登録成功率・所要時間・締切前の割合・重複率・滞留を計算する", () => {
    const m = computeMetrics(
      [
        row({ status: "auto_registered", job_state: "completed", completed_at: "2026-11-04T02:00:00Z", due_at: "2026-11-10T00:00:00Z", cost_jpy: 0.5, ai_calls: 1 }),
        row({ status: "auto_registered", job_state: "completed", completed_at: "2026-11-04T04:00:00Z", due_at: "2026-11-04T01:00:00Z" }),
        row({ status: "duplicate", job_state: "completed" }),
        row({ job_state: "review", created_at: "2026-11-03T06:00:00Z" }),
        row({ status: "failed", job_state: "failed", fail_kind: "robots" }),
        row({ status: "failed", job_state: "failed", fail_kind: "robots" }),
        row({ status: "excluded", job_state: "skipped" }),
        row({ job_state: "pending", created_at: "2026-11-02T06:00:00Z" }),
      ],
      NOW,
    );
    expect(m.stages).toEqual({ waiting: 1, review: 1, autoRegistered: 2, duplicate: 1, excluded: 1, failed: 2 });
    expect(m.registrationRate).toBeCloseTo(2 / 5);
    expect(m.avgHoursToRegister).toBeCloseTo(3);
    expect(m.registeredBeforeDeadlineRate).toBeCloseTo(0.5);
    expect(m.duplicateRate).toBeCloseTo(1 / 3);
    expect(m.reviewAvgHours).toBeCloseTo(24);
    expect(m.oldestWaitingHours).toBeCloseTo(48);
    expect(m.aiCostJpy).toBe(0.5);
    expect(m.failedByKind).toEqual([{ kind: "robots", label: "取得制限（ロボット・アクセス制限）", count: 2 }]);
  });
  it("対象がなければ割合は null（0%と区別する）", () => {
    const m = computeMetrics([], NOW);
    expect(m.registrationRate).toBeNull();
    expect(m.oldestWaitingHours).toBeNull();
  });
});
