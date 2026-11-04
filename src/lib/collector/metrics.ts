import { FAIL_KIND_LABEL, type FailKind } from "@/lib/collector/queue";

/** 収集パイプラインの品質指標（件数だけでなく、登録成功率・所要時間・締切前の登録割合・重複・滞留・AI費用） */
export interface MetricRow {
  status: string;
  job_state: string;
  created_at: string;
  completed_at: string | null;
  due_at: string | null;
  fail_kind: string | null;
  cost_jpy?: number | string | null;
  ai_calls?: number | null;
}

export interface PipelineMetrics {
  total: number;
  /** 段階別の件数 */
  stages: { waiting: number; review: number; autoRegistered: number; duplicate: number; excluded: number; failed: number };
  /** 受付中抽選の登録成功率 = 自動登録 ÷（自動登録＋確認待ち＋失敗）。除外・重複・受付終了は含めない */
  registrationRate: number | null;
  /** 発見から登録までの平均時間（時間） */
  avgHoursToRegister: number | null;
  /** 締切前に登録できた割合（締切が分かっているもののみ） */
  registeredBeforeDeadlineRate: number | null;
  /** 重複登録率 = 重複 ÷（重複＋自動登録） */
  duplicateRate: number | null;
  /** 現在の確認待ちの平均滞留時間（時間）と最古の待機（時間） */
  reviewAvgHours: number | null;
  oldestWaitingHours: number | null;
  aiCostJpy: number;
  aiCalls: number;
  failedByKind: { kind: FailKind; label: string; count: number }[];
}

const hours = (a: number, b: number) => Math.max(0, (b - a) / 3600_000);
const avg = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);

export function computeMetrics(rows: MetricRow[], now: Date): PipelineMetrics {
  const t = now.getTime();
  const waiting = rows.filter((r) => ["pending", "retry", "processing"].includes(r.job_state));
  const review = rows.filter((r) => r.job_state === "review");
  const reg = rows.filter((r) => r.status === "auto_registered");
  const dup = rows.filter((r) => r.status === "duplicate");
  const failed = rows.filter((r) => r.job_state === "failed");
  const excluded = rows.filter((r) => r.job_state === "skipped");
  const denom = reg.length + review.length + failed.length;
  const withDue = reg.filter((r) => r.due_at && r.completed_at);
  const kinds = new Map<FailKind, number>();
  for (const r of failed) {
    const k = ((r.fail_kind as FailKind | null) ?? "other") as FailKind;
    kinds.set(k, (kinds.get(k) ?? 0) + 1);
  }
  return {
    total: rows.length,
    stages: { waiting: waiting.length, review: review.length, autoRegistered: reg.length, duplicate: dup.length, excluded: excluded.length, failed: failed.length },
    registrationRate: denom > 0 ? reg.length / denom : null,
    avgHoursToRegister: avg(reg.filter((r) => r.completed_at).map((r) => hours(new Date(r.created_at).getTime(), new Date(r.completed_at!).getTime()))),
    registeredBeforeDeadlineRate: withDue.length > 0 ? withDue.filter((r) => new Date(r.completed_at!).getTime() <= new Date(r.due_at!).getTime()).length / withDue.length : null,
    duplicateRate: dup.length + reg.length > 0 ? dup.length / (dup.length + reg.length) : null,
    reviewAvgHours: avg(review.map((r) => hours(new Date(r.created_at).getTime(), t))),
    oldestWaitingHours: waiting.length ? Math.max(...waiting.map((r) => hours(new Date(r.created_at).getTime(), t))) : null,
    aiCostJpy: Math.round(rows.reduce((a, r) => a + (Number(r.cost_jpy) || 0), 0) * 100) / 100,
    aiCalls: rows.reduce((a, r) => a + (r.ai_calls ?? 0), 0),
    failedByKind: [...kinds.entries()].map(([kind, count]) => ({ kind, label: FAIL_KIND_LABEL[kind], count })).sort((a, b) => b.count - a.count),
  };
}
