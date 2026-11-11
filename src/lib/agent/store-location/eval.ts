/**
 * 店舗所在地エージェントの評価（Stage 8D-2）。eval/store-location/ の入力（cases・world）と正解（gold）を使い、方式ごとに採点して比較する。
 * 正解（gold）はシステム側に渡さない（runEngine は cases と world だけを受け取り、採点（score）だけが gold を読む）。
 *
 * 比較する方式（公平性のための注記）:
 *  - existing-none … 既存の固定処理。現行のアプリには「系列名・店舗名から住所を調べる」処理が**存在しない**
 *    （住所は手入力・Excel取込・別の手段で入れ、座標だけを国土地理院で変換する）。そのため「取得しない」を基準にする。能力の比較ではなく、現状の基準線。
 *  - naive-fixed … 参考の固定手順（検索1回→先頭ページ→最初の住所を採用。検証なし）。既存機能ではなく、「検証なしの固定手順」の危険を示す比較用。
 *  - agent-mock … 新しいエージェント基盤＋疑似AI（MockStoreBrain）＋検証層。モックなので、AIの判断力ではなく基盤（ツール選択・上限・検証）の評価。
 * 数値はモック・架空のWebでの結果で、実際のAIや実際のWebでの精度ではない。
 */
import type { AgentLimits } from "@/lib/agent/core";
import { MockFetcher, MockSearch, MockStoreBrain, mockGeocode, type MockWorldData } from "@/lib/agent/store-location/mock";
import { researchStoreLocation } from "@/lib/agent/store-location/run";
import type { SearchHit, SearchProvider } from "@/lib/agent/store-location/tools";
import type { ResearchStatus, StoreTarget } from "@/lib/agent/store-location/verify";
import { normalizeForMatch } from "@/lib/geocode";
import casesJson from "../../../../eval/store-location/cases.json";
import goldJson from "../../../../eval/store-location/gold.json";
import { EVAL_WORLD } from "@/lib/agent/store-location/world";

export interface EvalCase {
  id: string;
  category: string;
  store: StoreTarget;
  fault?: "search_down";
  limits?: Partial<AgentLimits>;
}
export interface EvalGold {
  id: string;
  expectedAddress: string | null;
  acceptableStatuses: ResearchStatus[];
  mustNotConfirm?: boolean;
  mustNotAdopt?: string[];
  improvedByAdditionalSearch?: boolean;
  conditions: string[];
}
export const EVAL_CASES = casesJson.cases as unknown as EvalCase[];
export const EVAL_GOLD = goldJson.gold as unknown as EvalGold[];
export { EVAL_WORLD };

export type EngineName = "existing-none" | "naive-fixed" | "agent-mock" | "agent-mock-1search";
export interface EvalResult {
  caseId: string;
  status: ResearchStatus;
  address: string | null;
  confidence: number;
  searches: number;
  fetches: number;
  steps: number;
  costJpy: number;
  ms: number;
  injectionFlags: number;
}

class DownSearch implements SearchProvider {
  readonly name = "down";
  async search(): Promise<SearchHit[]> {
    throw new Error("検索サービスが停止しています");
  }
}
const SEARCH_JPY = 1.5;
const ADDR = /((?:東京都|北海道|(?:京都|大阪)府|[^\s。、「」（）()]{2,3}県)[^\s。、「」（）()]{2,30}?[市区町村郡][^\s。、「」（）()]{0,30}?\d+[-‐－ー丁目番地]+\d*[-‐－ー号]*\d*)/;

/** システム側の実行。入力は case と world だけ（gold は渡さない） */
export async function runEngine(engine: EngineName, c: EvalCase, world: MockWorldData = EVAL_WORLD): Promise<EvalResult> {
  const t0 = Date.now();
  const empty = { caseId: c.id, status: "not_found" as ResearchStatus, address: null, confidence: 0, searches: 0, fetches: 0, steps: 0, costJpy: 0, injectionFlags: 0 };
  if (engine === "existing-none") return { ...empty, ms: 0 };

  const search = c.fault === "search_down" ? new DownSearch() : new MockSearch(world);
  const fetcher = new MockFetcher(world);

  if (engine === "naive-fixed") {
    let hits: SearchHit[] = [];
    try {
      hits = await search.search(`${c.store.chain} ${c.store.name} 住所`);
    } catch {
      return { ...empty, searches: 1, costJpy: SEARCH_JPY, ms: Date.now() - t0 };
    }
    const top = hits[0];
    const page = top ? await fetcher.fetchPage(top.url) : null;
    const m = page && page.ok ? ADDR.exec(page.text) : null;
    return { ...empty, status: m ? "confirmed" : "not_found", address: m ? m[1] : null, confidence: m ? 100 : 0, searches: 1, fetches: top ? 1 : 0, steps: 0, costJpy: SEARCH_JPY, ms: Date.now() - t0 };
  }

  const limits: Partial<AgentLimits> = { ...(c.limits ?? {}), ...(engine === "agent-mock-1search" ? { maxSearches: 1 } : {}) };
  const out = await researchStoreLocation(c.store, null, { llm: new MockStoreBrain(c.store), search, fetcher, geocode: mockGeocode(world), limits, searchCostJpy: SEARCH_JPY });
  const u = out.usage;
  return { caseId: c.id, status: out.result.status, address: out.result.address, confidence: out.result.confidence, searches: u.searches, fetches: u.fetches, steps: u.steps, costJpy: u.costJpy, ms: Date.now() - t0, injectionFlags: u.injectionFlags };
}

export async function runAll(engine: EngineName): Promise<EvalResult[]> {
  const out: EvalResult[] = [];
  for (const c of EVAL_CASES) out.push(await runEngine(engine, c));
  return out;
}

const same = (a: string | null, b: string | null) => !!a && !!b && normalizeForMatch(a) === normalizeForMatch(b);

export interface EvalScore {
  engine: string;
  cases: number;
  withExpected: number;
  /** 正しい住所を（確認済み・候補として）得られた率 */
  foundRate: number | null;
  /** 正しい住所を確認済みとして確定できた率 */
  confirmedRate: number | null;
  /** 採用した住所（確認済み・候補）のうち、誤っていた割合（誤情報の採用率） */
  wrongAdoptionRate: number | null;
  adopted: number;
  wrongAdopted: number;
  /** 確認済みにした誤り（最重要。0であるべき） */
  wrongConfirmed: number;
  /** 確認済みにしてはいけない場合の確認済み */
  forbiddenConfirmed: number;
  /** ステータスが許容範囲だった率 */
  statusOkRate: number;
  /** 人手の確認が要る（確認済みでない）割合 */
  humanReviewRate: number;
  searches: number;
  fetches: number;
  steps: number;
  costJpy: number;
  ms: number;
  perCase: { caseId: string; status: ResearchStatus; address: string | null; ok: boolean; wrong: boolean }[];
}
const ratio = (a: number, b: number) => (b === 0 ? null : a / b);

export function scoreEval(engine: string, results: EvalResult[], gold: EvalGold[] = EVAL_GOLD): EvalScore {
  let found = 0, confirmedOk = 0, adopted = 0, wrongAdopted = 0, wrongConfirmed = 0, forbidden = 0, statusOk = 0, human = 0;
  const withExpected = gold.filter((g) => g.expectedAddress).length;
  const perCase: EvalScore["perCase"] = [];
  const sum = { searches: 0, fetches: 0, steps: 0, costJpy: 0, ms: 0 };
  for (const g of gold) {
    const r = results.find((x) => x.caseId === g.id) ?? { caseId: g.id, status: "not_found" as ResearchStatus, address: null, confidence: 0, searches: 0, fetches: 0, steps: 0, costJpy: 0, ms: 0, injectionFlags: 0 };
    const adoptedHere = (r.status === "confirmed" || r.status === "candidate") && !!r.address;
    const correct = same(r.address, g.expectedAddress);
    const wrong = adoptedHere && (!correct || (g.mustNotAdopt ?? []).some((a) => same(r.address, a)));
    if (g.expectedAddress && adoptedHere && correct) found++;
    if (g.expectedAddress && r.status === "confirmed" && correct) confirmedOk++;
    if (adoptedHere) adopted++;
    if (wrong) wrongAdopted++;
    if (r.status === "confirmed" && wrong) wrongConfirmed++;
    if (r.status === "confirmed" && g.mustNotConfirm) forbidden++;
    const ok = g.acceptableStatuses.includes(r.status) && !wrong;
    if (ok) statusOk++;
    if (r.status !== "confirmed") human++;
    perCase.push({ caseId: g.id, status: r.status, address: r.address, ok, wrong });
    sum.searches += r.searches; sum.fetches += r.fetches; sum.steps += r.steps; sum.costJpy += r.costJpy; sum.ms += r.ms;
  }
  return { engine, cases: gold.length, withExpected, foundRate: ratio(found, withExpected), confirmedRate: ratio(confirmedOk, withExpected), wrongAdoptionRate: ratio(wrongAdopted, adopted), adopted, wrongAdopted, wrongConfirmed, forbiddenConfirmed: forbidden, statusOkRate: statusOk / gold.length, humanReviewRate: human / gold.length, ...sum, perCase };
}

/** 追加調査による改善: 検索1回に制限した場合（1search）と通常（full）を比べ、通常でだけ「正しい住所を確認済みにできた」件数 */
export function additionalSearchImprovement(full: EvalResult[], limited: EvalResult[], gold: EvalGold[] = EVAL_GOLD): { improved: number; targets: number; rate: number | null } {
  const targets = gold.filter((g) => g.expectedAddress);
  let improved = 0;
  for (const g of targets) {
    const f = full.find((r) => r.caseId === g.id);
    const l = limited.find((r) => r.caseId === g.id);
    if (f?.status === "confirmed" && same(f.address, g.expectedAddress) && !(l?.status === "confirmed" && same(l.address, g.expectedAddress))) improved++;
  }
  return { improved, targets: targets.length, rate: ratio(improved, targets.length) };
}

const pct = (x: number | null) => (x == null ? "—" : `${(x * 100).toFixed(0)}%`);
export function renderReport(scores: EvalScore[], improvement: ReturnType<typeof additionalSearchImprovement>): string {
  const rows: [string, (s: EvalScore) => string][] = [
    ["正確性: 正しい住所を得られた率（確認済み＋候補）", (s) => pct(s.foundRate)],
    ["情報取得: 正しい住所を確認済みにできた率", (s) => pct(s.confirmedRate)],
    ["誤情報の採用率（採用した住所のうち誤り）", (s) => `${pct(s.wrongAdoptionRate)}（${s.wrongAdopted}/${s.adopted}）`],
    ["確認済みにした誤り（最重要・0が必須）", (s) => String(s.wrongConfirmed)],
    ["確認済みにしてはいけない場合の確認済み", (s) => String(s.forbiddenConfirmed)],
    ["ステータスが期待の範囲だった率", (s) => pct(s.statusOkRate)],
    ["人手の確認が要る割合（確認済み以外）", (s) => pct(s.humanReviewRate)],
    ["検索回数 / 取得回数 / AI呼び出し", (s) => `${s.searches} / ${s.fetches} / ${s.steps}`],
    ["推定費用（円・検索の概算のみ。モックのAIは0円）", (s) => s.costJpy.toFixed(1)],
    ["処理時間（ms・モック）", (s) => String(s.ms)],
  ];
  const head = `| 項目 | ${scores.map((s) => s.engine).join(" | ")} |\n|---|${scores.map(() => "---").join("|")}|`;
  const body = rows.map(([label, f]) => `| ${label} | ${scores.map(f).join(" | ")} |`).join("\n");
  const detail = EVAL_GOLD.map((g) => `| ${g.id} | ${EVAL_CASES.find((c) => c.id === g.id)?.category} | ${scores.map((s) => { const p = s.perCase.find((x) => x.caseId === g.id)!; return `${p.status}${p.wrong ? "（誤）" : ""}`; }).join(" | ")} |`).join("\n");
  return [
    "# 店舗所在地エージェントの評価（モック・架空のWeb）",
    "",
    "数値は、疑似AI（モック）と架空のWebでの結果。実際のAI・実際のWebでの精度ではない。既存の固定処理には住所を調べる機能が無いため、existing-none は「現状の基準線」であり能力の比較ではない。naive-fixed は既存機能ではなく、検証なしの固定手順の参考。",
    "",
    head,
    body,
    "",
    `追加調査による改善: 検索1回に制限した場合に比べ、通常（追加検索あり）でだけ正しい住所を確認済みにできた件数 ${improvement.improved}/${improvement.targets}（${pct(improvement.rate)}）`,
    "",
    `| ケース | 種類 | ${scores.map((s) => s.engine).join(" | ")} |\n|---|---|${scores.map(() => "---").join("|")}|`,
    detail,
    "",
  ].join("\n");
}
