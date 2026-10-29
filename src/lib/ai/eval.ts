import { normalizeExtraction, type ExtractedLottery } from "@/lib/ai/extraction";
import { validateExtraction } from "@/lib/ai/validate";

/**
 * AI解析の回帰評価。固定のAI応答（raw）を、正規化と検証に通した結果が期待どおりかを確かめる（APIは呼ばない）。
 * 実AIでの評価は e2e/ai-live.spec.ts 側で明示的に実行する（費用が発生するため通常のテストでは動かさない）。
 * 期待値は「あるべき出力」の一部だけを書く（expect の項目だけ比べる）。
 */
export interface EvalCase {
  id: string;
  /** 何を確かめるケースか */
  title: string;
  /** 告知の原文（根拠の照合に使う。画像などで原文がないケースは null） */
  source: string | null;
  /** AIが返したと想定する生の出力（スネークケース） */
  raw: Record<string, unknown>;
  now: string;
  postedOn?: string;
  expect: {
    applyStart?: string;
    applyDeadline?: string;
    resultDate?: string;
    /** 時刻が空（日付のみ）であるべき項目 */
    noTime?: Array<"applyStart" | "applyDeadline" | "resultDate" | "procedureDeadline">;
    itemNames?: string[];
    multiMode?: ExtractedLottery["multiMode"];
    /** 検証で issue が付いているべき項目 */
    issues?: string[];
    /** issue が付いていてはならない項目 */
    noIssues?: string[];
    /** 要確認の注意（warnings）が出ないこと */
    noWarnings?: boolean;
    applyUrl?: string;
  };
}

export interface EvalResult {
  id: string;
  ok: boolean;
  failures: string[];
}

export function runEvalCase(c: EvalCase): EvalResult {
  const failures: string[] = [];
  const e = validateExtraction(normalizeExtraction(c.raw, new Date(c.now), { postedOn: c.postedOn }), c.source);
  const x = c.expect;
  const eq = (label: string, got: unknown, want: unknown) => {
    if (JSON.stringify(got) !== JSON.stringify(want)) failures.push(`${label}: 期待 ${JSON.stringify(want)} / 実際 ${JSON.stringify(got)}`);
  };
  if (x.applyStart !== undefined) eq("applyStart", e.applyStart.date, x.applyStart);
  if (x.applyDeadline !== undefined) eq("applyDeadline", e.applyDeadline.date, x.applyDeadline);
  if (x.resultDate !== undefined) eq("resultDate", e.resultDate.date, x.resultDate);
  for (const k of x.noTime ?? []) eq(`${k}.time`, e[k].time, "");
  if (x.itemNames) eq("itemNames", e.items.map((i) => i.name), x.itemNames);
  if (x.multiMode) eq("multiMode", e.multiMode, x.multiMode);
  if (x.applyUrl !== undefined) eq("applyUrl", e.applyUrl, x.applyUrl);
  const codes = e.issues.map((i) => i.field as string);
  for (const code of x.issues ?? []) if (!codes.includes(code)) failures.push(`${code} の issue が出ていない（実際: ${codes.join(",") || "なし"}）`);
  for (const code of x.noIssues ?? []) if (codes.includes(code)) failures.push(`${code} の issue が出てはならない`);
  if (x.noWarnings && e.warnings.length > 0) failures.push(`warnings が出てはならない: ${e.warnings.join(" / ")}`);
  return { id: c.id, ok: failures.length === 0, failures };
}

export function runEval(cases: EvalCase[]): { passed: number; total: number; results: EvalResult[] } {
  const results = cases.map(runEvalCase);
  return { passed: results.filter((r) => r.ok).length, total: results.length, results };
}
