/**
 * 自律型の情報収集の実行（Stage 9D）。調査計画（9C）を、実際の調査ツールの実行につなぐ。
 *   1. 手がかりを分析 → 2. AIが調査対象・方法を選ぶ → 3. 許可された読み取り専用ツールで取得・解析 → 4. 既存抽選と照合
 *   → 5. 不足があればAIが追加調査を選ぶ → 6. 検証層が提出を確認 → 7. 結果を自己評価して次回の調査に反映
 * すべてのツール実行を記録する（目的・調査先・成否・所要時間・費用・発見・次に使える情報）。
 * 実行権限・アクセス範囲・費用上限は、このモジュールの外側（controls.ts）で決まり、AIは変更できない。
 * このモジュールは外部へ書き込まない（登録・補完・監視への追加は、呼び出し側が別の安全条件を確認してから行う）。
 */
import { runAgent, ToolRegistry, type AgentLLM, type AgentRun, type AgentTool } from "@/lib/agent/core";
import { HostThrottle } from "@/lib/agent/collection-planner/throttle";
import { buildPlannerTools } from "@/lib/agent/collection-planner/tools";
import { PLANNER_SYSTEM, reviewPlan, type PlanReview } from "@/lib/agent/collection-planner/plan";
import { evaluateRun, type RunEvaluation, type StepLog } from "@/lib/agent/collection-planner/evaluate";
import type { SourceEvaluation } from "@/lib/agent/collection-planner/discovery";
import type { ResolvedControls } from "@/lib/agent/collection-planner/controls";
import type { AnalysisPreview, PageData, PlanOutput, PlannerWorld } from "@/lib/agent/collection-planner/types";

export interface InvestigationRecord {
  status: "completed" | "limit_reached" | "failed";
  stopReason: string;
  steps: StepLog[];
  /** 検証層を通った提出（AIの自己申告ではなく、取得した根拠のあるものだけ） */
  review: PlanReview | null;
  previews: AnalysisPreview[];
  /** 情報源の評価（取得した根拠による。recommend が auto_add のものだけが自動追加の対象になり得る） */
  monitorEvals: (SourceEvaluation & { chainId: string | null })[];
  /** 取得できたページの要点（全文は保存しない） */
  pages: { url: string; title: string; chars: number }[];
  /** 制限で止めたもの（重複・上限・不許可）の記録 */
  stops: string[];
  injectionFlags: number;
  usage: AgentRun["usage"];
  evaluation: RunEvaluation;
  summary: string;
  totalMs: number;
}

const short = (s: string, n: number): string => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
const LINK_HINT = /応募|抽選|詳細|お知らせ|ニュース|商品|予約|エントリー|公式/;

/** ツールの実行を記録する（実行時間・成否・発見・次に使える情報）。実行内容は変えない */
function instrument(inner: ToolRegistry, steps: StepLog[], now: () => number): ToolRegistry {
  const out = new ToolRegistry();
  for (const name of inner.names()) {
    const t = inner.get(name) as AgentTool;
    out.register({
      ...t,
      async run(input, ctx) {
        const t0 = now();
        const purpose = short(String(input.purpose ?? ""), 200);
        const target = short(String(input.url ?? input.query ?? input.chainName ?? input.productName ?? input.chainId ?? ""), 500);
        const log = (ok: boolean, resultSummary: string, extra: Partial<StepLog> = {}) => steps.push({ seq: steps.length, tool: name, purpose, target, ok, ms: Math.max(0, now() - t0), costJpy: t.costJpy ?? 0, resultSummary: short(resultSummary, 300), found: [], nextInfo: "", ...extra });
        try {
          const r = await t.run(input, ctx);
          const d = (r.data ?? {}) as Record<string, unknown>;
          if (d.failed === true) {
            log(false, String(d.reason ?? "失敗"), { nextInfo: "別の方法・別の情報源を選ぶ（制限は回避しない）" });
            return r;
          }
          if (d.preview) {
            const p = d.preview as AnalysisPreview;
            log(true, `${p.recognized ? "抽選として認識" : "抽選と認識できず"}・判定=${p.disposition.kind}`, {
              found: p.recognized ? [{ kind: "lottery_candidate", title: short(`${p.chainName} ${p.products.join("・")}`.trim(), 100), url: p.url, detail: `${p.disposition.kind}: ${p.disposition.reason}` }] : [],
              nextInfo: p.missing.length ? `不足: ${p.missing.join("・")}` : "不足なし",
              costJpy: p.costJpy,
            });
          } else if (d.evaluation) {
            const e = d.evaluation as SourceEvaluation;
            log(true, `公式性=${e.official}・関連性=${e.relevance}・判定=${e.recommend}`, { found: e.recommend === "reject" ? [] : [{ kind: "monitor_candidate", title: e.name, url: e.url, detail: e.reason }], nextInfo: e.reason });
          } else if (name === "check_official_site" || name === "follow_external_link") {
            const links = ((d.links as { url: string; text: string }[] | undefined) ?? []).filter((l) => LINK_HINT.test(l.text));
            log(true, `取得: ${short(String(d.title ?? ""), 60)}`, { nextInfo: links.length ? `たどれるリンク${links.length}件: ${links.slice(0, 3).map((l) => l.text.slice(0, 20)).join("・")}` : "関連しそうなリンクなし" });
          } else if (name === "match_existing_lotteries") {
            const n = Array.isArray(r.data) ? r.data.length : 0;
            log(true, `登録済みの該当${n}件`, { nextInfo: n ? "既存の抽選の補完・重複の可能性" : "該当なし（新規の可能性）" });
          } else if (name === "get_signals") {
            log(true, "手がかりを取得", { nextInfo: "調査対象を選ぶ" });
          } else log(true, short(r.content, 120));
          return r;
        } catch (e) {
          log(false, (e as Error).message?.slice(0, 160) ?? "失敗");
          throw e;
        }
      },
    } satisfies AgentTool);
  }
  return out;
}

export interface ExecuteInput {
  llm: AgentLLM;
  world: PlannerWorld;
  controls: ResolvedControls;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

/** 調査を1回実行する。例外を投げず、上限（回数・取得・解析・深さ・費用・時間・アクセス頻度）で必ず終了する */
export async function executeInvestigation(i: ExecuteInput): Promise<InvestigationRecord> {
  const now = i.now ?? Date.now;
  const t0 = now();
  const steps: StepLog[] = [];
  const pages = new Map<string, PageData>();
  const throttle = new HostThrottle(i.controls.throttle, now);
  const signals = await i.world.signals();
  const tools = instrument(buildPlannerTools(i.world, throttle, { pages, maxAnalyses: i.controls.maxAnalyses, maxFollowDepth: i.controls.maxFollowDepth, sleep: i.sleep, monitoredUrls: signals.monitors.map((m) => m.url ?? "").filter(Boolean) }), steps, now);
  const run = await runAgent({ llm: i.llm, tools, system: PLANNER_SYSTEM, task: "今日の抽選情報の収集で、調べるべきことを選んで調査し、結果を提出してください。情報が不足しているときは、公式ページなどを追加で調べてください。調べても分からない項目は、不明のまま提出してください。", limits: i.controls.limits, now });
  const fetched = new Set<string>(steps.filter((s) => s.ok && (s.tool === "check_official_site" || s.tool === "follow_external_link")).map((s) => s.target.replace(/#.*$/, "")));
  const out = run.output as PlanOutput | undefined;
  const valid = !!out && Array.isArray(out.tasks) && Array.isArray(out.findings);
  const linked = new Set<string>();
  for (const pg of pages.values()) for (const l of pg.links) linked.add(l.url.replace(/#.*$/, ""));
  const review = valid ? reviewPlan(out, signals, fetched, linked) : null;

  const previews: AnalysisPreview[] = [];
  const monitorEvals: InvestigationRecord["monitorEvals"] = [];
  const stops: string[] = [];
  let injectionFlags = 0;
  for (const e of run.trace) {
    if (e.t === "tool" && e.ok) {
      const d = (e.data ?? {}) as Record<string, unknown>;
      if (d.preview) previews.push(d.preview as AnalysisPreview);
      if (d.evaluation) monitorEvals.push(d.evaluation as InvestigationRecord["monitorEvals"][number]);
      if (e.injection?.length) injectionFlags += 1;
    }
    if (e.t === "duplicate") stops.push(`重複した調査を断った: ${e.name}`);
    if (e.t === "rejected") stops.push(`使えないツールの呼び出しを拒否: ${e.name}`);
    if (e.t === "limit") stops.push(e.detail);
    if (e.t === "error") stops.push(`エラー: ${e.message}`);
  }
  for (const s of steps) if (!s.ok && s.tool !== "get_signals") stops.push(`${s.tool}: ${s.resultSummary}`);

  // 追加調査の効果: 取得ページのリンク先を解析した結果と、リンク元の解析結果の不足項目を比べる（比較できる組だけ）
  const followPairs: { rootMissing: string[]; followMissing: string[] }[] = [];
  for (const p of previews) {
    const parent = [...pages.values()].find((pg) => pg.links.some((l) => l.url.replace(/#.*$/, "") === p.url));
    const root = parent ? previews.find((q) => q.url === parent.url) : undefined;
    if (root) followPairs.push({ rootMissing: root.missing, followMissing: p.missing });
  }
  const totalMs = Math.max(0, now() - t0);
  const evaluation = evaluateRun({ steps, previews, monitorEvals, followPairs, totalMs, totalCostJpy: run.usage.costJpy + previews.reduce((a, p) => a + p.costJpy, 0) });
  const status: InvestigationRecord["status"] = run.status === "error" ? "failed" : run.status === "limit_reached" ? "limit_reached" : "completed";
  return {
    status,
    stopReason: run.stopReason,
    steps,
    review,
    previews,
    monitorEvals,
    pages: [...pages.values()].map((p) => ({ url: p.url, title: short(p.title, 80), chars: p.text.length })),
    stops: [...new Set(stops)].slice(0, 30),
    injectionFlags,
    usage: run.usage,
    evaluation,
    summary: valid ? short(String(out.summary ?? ""), 300) : "調査結果は提出されませんでした",
    totalMs,
  };
}
