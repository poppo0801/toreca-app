/**
 * Stage 9E の評価データの読み込み・整合性の検査・採点（テスト・評価スクリプト専用。アプリ本体からは使わない）。
 *  - 入力（凍結したページ）と正解（gold-*.json）は別ファイル。正解をAIに渡さない・AIの出力に合わせて変えない。
 *  - 凍結: ページ本文のハッシュ（frozen-hashes.json）と一致しなければ評価を止める（評価データの整合性が崩れた状態で採点しない）。
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import type { PageKind } from "@/lib/ai/page-kind";
import type { PageData } from "@/lib/agent/collection-planner/types";

const read = <T>(f: string): T => JSON.parse(readFileSync(f, "utf8")) as T;
const DIR = "eval/investigation-9e";

export interface GoldPage {
  url: string;
  set: "real" | "live1" | "live2" | "live3";
  kind: PageKind | null;
  actionable: boolean | null;
  ambiguous?: boolean;
  basis: string;
}

export function loadGoldPages(file = `${DIR}/gold-pages.json`): GoldPage[] {
  return read<{ pages: GoldPage[] }>(file).pages;
}

type RawLink = { url?: string; href?: string; text: string };
const normLinks = (ls: (RawLink | string)[] | undefined): PageData["links"] => (ls ?? []).map((l) => (typeof l === "string" ? { url: l, text: "" } : { url: String(l.url ?? l.href ?? ""), text: l.text ?? "" })).filter((l) => l.url);

/** 凍結したページ（実在の抽選の情報源・取得した公開ページ）。URL → ページ */
export function loadFrozenPages(): Map<string, PageData> {
  const m = new Map<string, PageData>();
  const add = (url: string, v: { title: string; text: string; links?: (RawLink | string)[] }) => {
    if (!m.has(url)) m.set(url, { url, title: v.title ?? "", text: v.text ?? "", links: normLinks(v.links) });
  };
  for (const f of ["pages", "pages-8f3", "pages-8f4"]) for (const v of read<{ pages: { url: string; title: string; text: string; links?: (RawLink | string)[] }[] }>(`eval/lottery-grouping-real/${f}.json`).pages) add(v.url, v);
  for (const f of ["pages-live.json", "pages-live-2.json", "pages-live-3.json"]) {
    try {
      for (const v of read<{ pages: { url: string; title: string; text: string; links?: (RawLink | string)[] }[] }>(`${DIR}/${f}`).pages) add(v.url, v);
    } catch {
      /* 3 は任意 */
    }
  }
  return m;
}

const sha = (s: string): string => createHash("sha256").update(s).digest("hex");
/** 凍結したページの本文のハッシュを検査する。不一致（改変・欠落）の URL を返す。空なら整合 */
export function verifyFrozen(pages: Map<string, PageData>, hashesFile = `${DIR}/frozen-hashes.json`): string[] {
  const { hashes } = read<{ hashes: Record<string, string> }>(hashesFile);
  const bad: string[] = [];
  for (const [url, h] of Object.entries(hashes)) {
    const p = pages.get(url);
    if (!p || sha(`${p.title}\n${p.text}`) !== h) bad.push(url);
  }
  return bad;
}

export interface ClassScore {
  total: number;
  scored: number;
  ambiguousExcluded: number;
  /** 抽選の告知（登録の対象）の判定: 正解が告知で、告知と判定 */
  tp: number;
  /** 正解が告知でないのに、告知と判定（誤認識） */
  fp: number;
  /** 正解が告知なのに、告知でないと判定（見落とし） */
  fn: number;
  tn: number;
  kindCorrect: number;
  errors: { url: string; set: string; gold: string; predicted: string; basis: string }[];
}

export function scoreClassification(gold: GoldPage[], predict: (url: string) => { kind: string; actionable: boolean }): ClassScore {
  const s: ClassScore = { total: gold.length, scored: 0, ambiguousExcluded: 0, tp: 0, fp: 0, fn: 0, tn: 0, kindCorrect: 0, errors: [] };
  for (const g of gold) {
    if (g.ambiguous || g.actionable === null) {
      s.ambiguousExcluded += 1;
      continue;
    }
    const p = predict(g.url);
    s.scored += 1;
    if (g.actionable && p.actionable) s.tp += 1;
    else if (!g.actionable && p.actionable) s.fp += 1;
    else if (g.actionable && !p.actionable) s.fn += 1;
    else s.tn += 1;
    if (g.kind === p.kind) s.kindCorrect += 1;
    if (g.actionable !== p.actionable || g.kind !== p.kind) s.errors.push({ url: g.url, set: g.set, gold: `${g.kind}`, predicted: `${p.kind}${p.actionable ? "(登録対象)" : ""}`, basis: g.basis });
  }
  return s;
}

// ---------------------------------------------------------------- シナリオ（自律調査）の採点
import type { InvestigationRecord } from "@/lib/agent/collection-planner/executor";

export interface UrlGold {
  chain: string;
  store: string | null;
  product: string;
  deadline: string | null;
}
export interface ScenarioGold {
  reachable: string[];
  disposition: Record<string, string>;
  shouldFindLottery: boolean;
  maxFetches?: number;
}
export interface ScenarioGoldFile {
  urls: Record<string, UrlGold>;
  notLottery: string[];
  scenarios: Record<string, ScenarioGold>;
}
export const loadScenarioGold = (): ScenarioGoldFile => read<ScenarioGoldFile>(`${DIR}/gold-scenarios.json`);

export interface ScenarioScore {
  scenario: string;
  fetchedUrls: string[];
  analyzedUrls: string[];
  /** 到達すべきURLのうち、取得できたもの */
  reached: { target: number; reached: number };
  /** 抽選の告知を見つけたか（見つけるべきシナリオ）／見つけない（見つけるべきでないシナリオ）の正否 */
  findLotteryOk: boolean;
  perUrl: { url: string; recognized: boolean; chainOk: boolean; storeOk: boolean | null; productOk: boolean; dispositionOk: boolean | null; deadlineOk: boolean | null; disposition: string; registrable: boolean }[];
  /** 抽選ではないページを抽選と認識した（誤認識） */
  nonLotteryRecognized: string[];
  /** 登録の対象にしてはいけないものを登録可能としたもの（誤登録・二重登録・誤補完になるもの） */
  misRegistrations: { url: string; reason: string }[];
  /** 抽選の告知でないページへの解析（不要だった解析） */
  wastedAnalyses: string[];
  withinFetchLimit: boolean | null;
  steps: number;
  fetches: number;
  analyses: number;
  costJpy: number;
  ms: number;
  decidedBy: Record<string, number>;
  followUps: number;
  stopReason: string;
}

const eqName = (a: string, b: string): boolean => a.replace(/\s+/g, "").toLowerCase() === b.replace(/\s+/g, "").toLowerCase();
const normUrl = (u: string): string => u.replace(/#.*$/, "");

export function scoreScenario(id: string, rec: InvestigationRecord, gold: ScenarioGoldFile): ScenarioScore {
  const sg = gold.scenarios[id];
  const fetched = rec.steps.filter((s) => s.ok && (s.tool === "check_official_site" || s.tool === "follow_external_link")).map((s) => normUrl(s.target));
  const analyzed = rec.steps.filter((s) => s.ok && s.tool === "analyze_page_for_lottery").map((s) => normUrl(s.target));
  const mis: ScenarioScore["misRegistrations"] = [];
  const perUrl: ScenarioScore["perUrl"] = [];
  const notLottery = new Set(gold.notLottery.map(normUrl));
  const nonLotteryRecognized: string[] = [];
  for (const p of rec.previews) {
    const url = normUrl(p.url);
    const g = gold.urls[url] ?? gold.urls[`${url}/`] ?? gold.urls[url.replace(/\/$/, "")];
    const expected = sg.disposition[url] ?? sg.disposition[`${url}/`] ?? sg.disposition[url.replace(/\/$/, "")] ?? sg.disposition.default;
    if (notLottery.has(url) || notLottery.has(`${url}/`)) {
      if (p.recognized) nonLotteryRecognized.push(url);
      if (p.registrable) mis.push({ url, reason: "抽選の告知ではないページを登録可能と判定" });
      continue;
    }
    if (!g) continue;
    const chainOk = eqName(p.chainName, g.chain);
    const storeOk = g.store ? eqName(p.storeName, g.store) : null;
    const productOk = p.products.some((x) => x.includes(g.product) || g.product.includes(x));
    const dispositionOk = expected ? p.disposition.kind === expected : null;
    const deadlineOk = g.deadline ? p.applyDeadline === g.deadline : null;
    perUrl.push({ url, recognized: p.recognized, chainOk, storeOk, productOk, dispositionOk, deadlineOk, disposition: p.disposition.kind, registrable: p.registrable });
    if (p.registrable) {
      if (!chainOk) mis.push({ url, reason: `系列が違う（${p.chainName}≠${g.chain}）` });
      if (storeOk === false) mis.push({ url, reason: `店舗が違う（${p.storeName}≠${g.store}）` });
      if (!productOk) mis.push({ url, reason: `商品が違う（${p.products.join("・")}≠${g.product}）` });
      if (expected && expected !== "new" && p.disposition.kind === "new") mis.push({ url, reason: `既存の抽選と同じ（${expected}）なのに新規として登録可能と判定` });
    }
    if (expected === "complete" && p.disposition.kind === "complete" && !p.disposition.targetLotteryId) mis.push({ url, reason: "補完の対象が不明" });
  }
  const recognizedGold = rec.previews.some((p) => p.recognized && (gold.urls[normUrl(p.url)] || gold.urls[`${normUrl(p.url)}/`]));
  const fetchCount = rec.steps.filter((s) => s.tool === "check_official_site" || s.tool === "follow_external_link").length;
  const decidedBy: Record<string, number> = {};
  for (const s of rec.steps) decidedBy[s.decidedBy ?? "unknown"] = (decidedBy[s.decidedBy ?? "unknown"] ?? 0) + 1;
  return {
    scenario: id,
    fetchedUrls: fetched,
    analyzedUrls: analyzed,
    reached: { target: sg.reachable.length, reached: sg.reachable.filter((u) => fetched.includes(normUrl(u)) || fetched.includes(normUrl(u).replace(/\/$/, ""))).length },
    findLotteryOk: sg.shouldFindLottery ? recognizedGold : !rec.previews.some((p) => p.recognized),
    perUrl,
    nonLotteryRecognized,
    misRegistrations: mis,
    wastedAnalyses: analyzed.filter((u) => notLottery.has(u) || notLottery.has(`${u}/`)),
    withinFetchLimit: sg.maxFetches === undefined ? null : fetchCount <= sg.maxFetches,
    steps: rec.steps.length,
    fetches: fetchCount,
    analyses: analyzed.length,
    costJpy: rec.usage.costJpy,
    ms: rec.totalMs,
    decidedBy,
    followUps: rec.followUps,
    stopReason: rec.stopReason,
  };
}
