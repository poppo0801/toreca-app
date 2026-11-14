/**
 * 調査の自己評価（Stage 9D・純関数）。エージェントが自分の調査の成果を数えて、次回の調査対象・方法の調整に使う。
 * **AI自身の判断を正解として扱わない**: すべての値に根拠の種類（basis）を付ける。
 *   measured    : 実行の記録から数えた事実（取得の成否・件数・所要時間・費用）
 *   ai_estimate : 解析（AI/固定ロジック）が出した判定。人が確認するまで正解ではない（新規/補完/重複の判定の件数など）
 *   unverified  : 正解の確認が必要で、現時点では測れない（誤登録の件数など。人の確認結果が入るまで未確認）
 */
import type { AnalysisPreview } from "@/lib/agent/collection-planner/types";
import type { SourceEvaluation } from "@/lib/agent/collection-planner/discovery";

export type Basis = "measured" | "ai_estimate" | "unverified";
export interface Metric {
  value: number | null;
  basis: Basis;
  note?: string;
}

export interface StepLog {
  seq: number;
  tool: string;
  purpose: string;
  target: string;
  ok: boolean;
  ms: number;
  costJpy: number;
  resultSummary: string;
  found: { kind: "lottery_candidate" | "monitor_candidate"; title: string; url?: string; detail?: string }[];
  nextInfo: string;
}

export interface SourceOutcome {
  host: string;
  attempts: number;
  failures: number;
  failReason?: string;
  /** その情報源から見つかった抽選候補（解析できたもの）の数 */
  yielded: number;
}

export interface RunEvaluation {
  metrics: Record<string, Metric>;
  /** 情報源（ホスト）ごとの成果 */
  sources: SourceOutcome[];
  /** 次回の調査への反映（情報。上限・権限は変えない） */
  adjustments: string[];
}

const host = (u: string): string => {
  try {
    return new URL(u).hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return "";
  }
};

/** 追加調査（リンクをたどった解析）が、不足項目をどれだけ減らしたか（同じ調査対象の最初の解析と、追跡後の解析の比較。測定できるものだけ） */
export function followUpGain(pairs: { rootMissing: string[]; followMissing: string[] }[]): number {
  return pairs.reduce((a, p) => a + Math.max(0, p.rootMissing.length - p.followMissing.length), 0);
}

export function evaluateRun(input: {
  steps: StepLog[];
  previews: AnalysisPreview[];
  monitorEvals: SourceEvaluation[];
  followPairs: { rootMissing: string[]; followMissing: string[] }[];
  totalMs: number;
  totalCostJpy: number;
}): RunEvaluation {
  const fetches = input.steps.filter((s) => s.tool === "check_official_site" || s.tool === "follow_external_link");
  const ok = fetches.filter((s) => s.ok).length;
  const kinds = (k: AnalysisPreview["disposition"]["kind"]) => input.previews.filter((p) => p.disposition.kind === k).length;
  const byHost = new Map<string, SourceOutcome>();
  for (const s of fetches) {
    const h = host(s.target);
    if (!h) continue;
    const o = byHost.get(h) ?? { host: h, attempts: 0, failures: 0, yielded: 0 };
    o.attempts += 1;
    if (!s.ok) {
      o.failures += 1;
      o.failReason = s.resultSummary.slice(0, 100);
    }
    byHost.set(h, o);
  }
  for (const p of input.previews) {
    const o = byHost.get(host(p.url));
    if (o && p.recognized) o.yielded += 1;
  }
  const sources = [...byHost.values()];
  const adjustments: string[] = [];
  for (const s of sources) {
    if (s.failures > 0 && s.failures === s.attempts) adjustments.push(`${s.host}: 取得に失敗（${s.failReason ?? "理由不明"}）。制限は回避せず、続く場合はしばらく避ける`);
    else if (s.yielded > 0) adjustments.push(`${s.host}: 抽選候補を${s.yielded}件発見。次回も優先して確認する`);
    else if (s.attempts >= 2 && s.yielded === 0) adjustments.push(`${s.host}: 複数回確認して抽選候補なし。優先度を下げる`);
  }
  if (input.followPairs.length > 0 && followUpGain(input.followPairs) === 0) adjustments.push("追加調査（リンクの追跡）では不足項目が減らなかった。同種の追跡の優先度を下げる");

  const metrics: Record<string, Metric> = {
    candidatesFound: { value: input.previews.filter((p) => p.recognized).length, basis: "measured", note: "抽選として認識された解析の数" },
    registrable: { value: input.previews.filter((p) => p.registrable).length, basis: "ai_estimate", note: "登録の安全条件を満たしたプレビューの数（人の確認前）" },
    completions: { value: kinds("complete"), basis: "ai_estimate", note: "既存抽選の補完と判定された数" },
    updates: { value: kinds("update"), basis: "ai_estimate" },
    duplicates: { value: kinds("duplicate"), basis: "ai_estimate", note: "重複と判定された数（新規カードを作らない）" },
    investigate: { value: kinds("investigate"), basis: "ai_estimate", note: "追加調査・保留と判定された数" },
    misregistrations: { value: null, basis: "unverified", note: "誤登録の件数は、人の確認結果が入るまで未確認" },
    fetchSuccessRate: { value: fetches.length ? ok / fetches.length : null, basis: "measured", note: `${ok}/${fetches.length}` },
    monitorCandidates: { value: input.monitorEvals.filter((e) => e.recommend !== "reject").length, basis: "measured", note: "公式性・関連性・取得可能性の評価で候補以上になった情報源" },
    autoAddable: { value: input.monitorEvals.filter((e) => e.recommend === "auto_add").length, basis: "measured" },
    followUpGain: { value: input.followPairs.length ? followUpGain(input.followPairs) : null, basis: input.followPairs.length ? "measured" : "unverified", note: "追加調査で減った不足項目の数（比較できた組のみ）" },
    totalMs: { value: input.totalMs, basis: "measured" },
    totalCostJpy: { value: input.totalCostJpy, basis: "measured" },
  };
  return { metrics, sources, adjustments };
}

/** 保存済みの過去の成果から、次回の get_signals に渡す「前回までの調査の成果」を作る（ホストごとの累計） */
export function mergeOutcomes(history: SourceOutcome[][]): { host: string; attempts: number; failures: number; lastFailKind?: string; yielded: number }[] {
  const m = new Map<string, { host: string; attempts: number; failures: number; lastFailKind?: string; yielded: number }>();
  for (const run of history)
    for (const s of run) {
      const o = m.get(s.host) ?? { host: s.host, attempts: 0, failures: 0, yielded: 0 };
      o.attempts += s.attempts;
      o.failures += s.failures;
      o.yielded += s.yielded;
      if (s.failReason) o.lastFailKind = /robots/i.test(s.failReason) ? "robots" : "error";
      m.set(s.host, o);
    }
  return [...m.values()];
}
