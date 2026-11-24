/**
 * 自律AIの性能・完成度の**実測指標**（Phase 2・純関数）。主観的な点数（例: 「40点」「72%」）を実測値として使わない。
 * 各指標は「測れたか」を明示する（値・分母・状態）。測れていないものは null＋not_measured（0や良い値に見せない）。モック・合成の結果は measured ではなく mock/synthetic として別に扱う。
 *
 * 指標（利用者が長期的に追う12項目）:
 *   discovery        発見率: 短縮リンクを展開できた割合（収集）／応募機会を見つけた割合（再現率）
 *   recall           応募機会の再現率（独立gold）
 *   misregistration  誤登録率（登録すべきでないものを登録）
 *   mismerge         誤統合・誤分割（機会の取り違え）の件数
 *   costPerOpp       1応募機会あたりの実費（円。実AIの実費だけ）
 *   goldTargets      独立goldの対象数（案件・機会）
 *   unverified       未確認の割合（人の確認が済んでいないページの割合）
 *   recheckRecovery  再調査の回収率（再取得できた／（できた＋諦めた＋待ち））
 *   evidenceRead     AIの根拠参照率（重要条件が入力に届いたもののうち、読まれて判断に使えた割合）
 *   repeatedErrors   繰り返し誤り（同じ項目の誤りが複数案件で出た数）
 *   historyProtection 既存履歴・人の確認の保護（保護違反の件数。0であること）
 *   realEvalRuns     実AIの試験の実施回数（accuracy として主張できる結果の数）
 */
export type MetricState = "measured" | "not_measured" | "mock_only" | "synthetic_only";
export interface Metric {
  key: string;
  label: string;
  value: number | null;
  /** 分母（件数）。値の信頼性の目安 */
  n: number;
  state: MetricState;
  unit: "rate" | "count" | "jpy";
  note?: string;
}

export interface MetricsInput {
  capture?: { shortTotal: number; shortResolved: number; casesBuilt: number } | null;
  /** 比較試験の結果（アームごとの集計。claim が accuracy のものだけ measured として扱う） */
  experiments?: { dataset: "synthetic_lp" | "real_post"; claim: "accuracy" | "pipeline_check_only" | "structure_check_only"; oppRecall: { k: number; n: number } | null; falseRegister: { k: number; n: number } | null; mismerge: number | null; costJpy: number | null; opps: number; seenOk: number; inInput: number; repeatedErrors: number | null }[];
  gold?: { cases: number; opportunities: number } | null;
  review?: { total: number; unreviewed: number } | null;
  recheck?: { done: number; gaveUp: number; pending: number } | null;
  historyViolations?: number | null;
}

const rate = (k: number, n: number): number | null => (n > 0 ? k / n : null);

export function buildMetricsSnapshot(i: MetricsInput): Metric[] {
  const exps = i.experiments ?? [];
  const real = exps.filter((e) => e.claim === "accuracy");
  const m = (key: string, label: string, unit: Metric["unit"], value: number | null, n: number, state: MetricState, note?: string): Metric => ({ key, label, unit, value, n, state: value === null ? "not_measured" : state, ...(note ? { note } : {}) });
  const sumK = (f: (e: (typeof exps)[number]) => { k: number; n: number } | null) => real.reduce((a, e) => ({ k: a.k + (f(e)?.k ?? 0), n: a.n + (f(e)?.n ?? 0) }), { k: 0, n: 0 });
  const rec = sumK((e) => e.oppRecall);
  const mis = sumK((e) => e.falseRegister);
  const cost = real.reduce((a, e) => ({ c: a.c + (e.costJpy ?? 0), o: a.o + e.opps }), { c: 0, o: 0 });
  const read = real.reduce((a, e) => ({ k: a.k + e.seenOk, n: a.n + e.inInput }), { k: 0, n: 0 });
  const rc = i.recheck ?? null;
  const onlyNonReal = exps.length > 0 && real.length === 0;
  const stateOfEval: MetricState = "measured";
  const nm = onlyNonReal ? (exps.some((e) => e.dataset === "synthetic_lp" && e.claim === "structure_check_only") ? "synthetic_only" : "mock_only") : "not_measured";
  return [
    m("discovery_links", "短縮リンクの展開率（収集）", "rate", i.capture ? rate(i.capture.shortResolved, i.capture.shortTotal) : null, i.capture?.shortTotal ?? 0, "measured", "実投稿の公開URL取得の実測（無課金）"),
    m("recall", "応募機会の再現率（独立gold）", "rate", real.length ? rate(rec.k, rec.n) : null, rec.n, stateOfEval, real.length ? undefined : `実AIの結果が無い（${nm}）`),
    m("misregistration", "誤登録率", "rate", real.length ? rate(mis.k, mis.n) : null, mis.n, stateOfEval),
    m("mismerge", "誤統合・誤分割（機会の取り違え）", "count", real.length ? real.reduce((n, e) => n + (e.mismerge ?? 0), 0) : null, real.length, stateOfEval),
    m("cost_per_opp", "1応募機会あたりの実費", "jpy", real.length && cost.o > 0 ? cost.c / cost.o : null, cost.o, stateOfEval),
    m("gold_targets", "独立goldの対象（案件）", "count", i.gold ? i.gold.cases : null, i.gold?.opportunities ?? 0, "measured", i.gold ? `応募機会 ${i.gold.opportunities} 件` : "gold未確定"),
    m("unverified_share", "未確認の割合（人の確認待ち）", "rate", i.review ? rate(i.review.unreviewed, i.review.total) : null, i.review?.total ?? 0, "measured"),
    m("recheck_recovery", "再調査の回収率", "rate", rc ? rate(rc.done, rc.done + rc.gaveUp + rc.pending) : null, rc ? rc.done + rc.gaveUp + rc.pending : 0, "measured"),
    m("evidence_read", "AIの根拠参照率（入力に届いた重要条件のうち読めた割合）", "rate", real.length ? rate(read.k, read.n) : null, read.n, stateOfEval),
    m("repeated_errors", "繰り返し誤り（同じ項目の誤りが複数案件）", "count", real.length ? real.reduce((n, e) => n + (e.repeatedErrors ?? 0), 0) : null, real.length, stateOfEval),
    m("history_protection", "既存履歴・人の確認の保護違反", "count", i.historyViolations ?? null, 0, "measured", "0であること（回帰テストの結果）"),
    m("real_eval_runs", "実AIの試験（accuracyとして主張できる結果）の数", "count", real.length, real.length, "measured", real.length ? undefined : "未実施"),
  ];
}

/** 一覧表示用（報告・ダッシュボード）。未測定は「未測定」と書き、値を出さない */
export function renderMetrics(ms: readonly Metric[]): string {
  return ms.map((x) => `- ${x.label}: ${x.value === null ? `未測定${x.note ? `（${x.note}）` : ""}` : `${x.unit === "rate" ? `${(x.value * 100).toFixed(1)}%` : x.unit === "jpy" ? `${x.value.toFixed(2)}円` : x.value}（n=${x.n}）${x.note ? ` ${x.note}` : ""}`}`).join("\n");
}
