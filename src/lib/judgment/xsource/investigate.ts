/**
 * 応募構造の自律調査（Stage 10N）: 情報源（応募先・公式告知の**公開ページ**）を必要なときだけ安全に取得し、応募単位（店舗選択式・店舗別・同一応募で複数商品・商品別・開催回）を判定する。
 *  - 取得・判定は注入（`fetchPage`＝既存の取得部品: SSRF防御・robots尊重・認証/ログイン回避なし。`judge`＝AI）。このモジュールは**計画・上限・検証・履歴**を担う。
 *  - **上限**: ページ数・深さ・総時間・取得回数・AI呼び出し（CallBudget。回数と費用の合算）。再帰探索はしない（深さ1: 応募先ページの中の、同じホストの「応募」リンク1件まで）。
 *  - 取得できない・不明・根拠が原文に無い（引用の検証に失敗）なら**保留**。推測で確定しない。調査の履歴（取得先のホストと状態・費用）を残す。X・短縮URL・汎用ページは調査しない。
 */
import { createHash } from "node:crypto";
import type { CallBudget } from "../call-budget";
import { canonUrl } from "./normalize";
import { SOURCE_RELIABILITY, type ApplyUnitName, type SourceFact } from "./types";

export interface InvestigationLimits {
  maxPages: number;
  maxDepth: 0 | 1;
  /** 取得の最大回数（この調査） */
  maxFetches: number;
  /** この調査の総時間の上限（ミリ秒） */
  timeMs: number;
}
export const DEFAULT_INVESTIGATION_LIMITS: InvestigationLimits = { maxPages: 3, maxDepth: 1, maxFetches: 4, timeMs: 60_000 };

export type StepStatus = "ok" | "failed" | "blocked" | "not_public" | "duplicate" | "limit_pages" | "limit_time" | "limit_calls" | "judged" | "no_answer" | "quote_not_found";
export interface InvestigationStep {
  kind: "fetch" | "judge";
  /** 取得先のホスト名（公開のドメイン）。URLの全体は残さない */
  host: string | null;
  urlKey: string;
  status: StepStatus;
  chars?: number;
  costJpy?: number | null;
}

export interface FetchedPage {
  text: string;
  /** ページ内のリンク（応募リンクの探索用）。同じホストのものだけ使う */
  links: { url: string; text: string }[];
}
export type FetchPageFn = (url: string) => Promise<({ ok: true } & FetchedPage) | { ok: false; reason: "blocked" | "failed" | "robots" | "not_public" }>;

export interface StructureAnswer {
  applyUnit: ApplyUnitName;
  selectableStores: string[];
  products: string[];
  /** 判断の根拠の抜粋（ページ本文からそのまま） */
  quote: string;
  /** 根拠のページ（渡した順の番号。1始まり） */
  page: number;
}
export type StructureJudgeFn = (pages: { n: number; text: string }[]) => Promise<{ answer: StructureAnswer | null; costJpy: number | null }>;

export interface StructureFinding {
  applyUnit: ApplyUnitName;
  selectableStores: string[];
  products: string[];
  quoteVerified: boolean;
  urlKey: string;
  host: string | null;
}
export interface InvestigationResult {
  steps: InvestigationStep[];
  finding: StructureFinding | null;
  /** 確定できなかった理由（保留）。finding があれば null */
  hold: string | null;
  fetches: number;
  calls: number;
}

const hashKey = (s: string): string => createHash("sha256").update(s).digest("hex").slice(0, 12);
const flat = (s: string): string => s.normalize("NFKC").replace(/[\s　]+/g, "").toLowerCase();

/** 調査してよい公開ページ: 具体的なページ（汎用・短縮・SNSでない）の https。信頼性の高い情報源のURLを先にする。調査済みは除く */
export function planInvestigationUrls(members: SourceFact[], done: ReadonlySet<string>, max: number): string[] {
  const out: { url: string; rel: number; key: string }[] = [];
  for (const m of [...members].sort((a, b) => SOURCE_RELIABILITY[b.kind] - SOURCE_RELIABILITY[a.kind] || (a.sourceId < b.sourceId ? -1 : 1))) {
    for (const u of m.urls ?? []) {
      const c = canonUrl(u);
      if (c.cls !== "specific" || !u.startsWith("https://")) continue;
      const key = hashKey(c.key);
      if (done.has(key) || out.some((x) => x.key === key)) continue;
      out.push({ url: u, rel: SOURCE_RELIABILITY[m.kind], key });
    }
  }
  return out.slice(0, max).map((x) => x.url);
}

const APPLY_LINK = /応募|エントリー|申込|申し込み|抽選|フォーム/;

export async function investigateStructure(args: {
  members: SourceFact[];
  fetchPage: FetchPageFn;
  judge: StructureJudgeFn;
  budget: CallBudget;
  limits?: InvestigationLimits;
  /** 調査済みのURLキー（再実行で同じページを取得・判断しない＝追加費用なし） */
  done?: Set<string>;
  now?: () => number;
}): Promise<InvestigationResult> {
  const lim = args.limits ?? DEFAULT_INVESTIGATION_LIMITS;
  const now = args.now ?? Date.now;
  const t0 = now();
  const steps: InvestigationStep[] = [];
  const done = args.done ?? new Set<string>(); // 呼び出し側の集合へ調査済みを書き戻す（再実行で同じページを取得・判断しない）
  const pages: { n: number; text: string; urlKey: string; host: string | null }[] = [];
  let fetches = 0;
  const fetchOne = async (url: string, depth: number): Promise<FetchedPage | null> => {
    const c = canonUrl(url);
    const urlKey = hashKey(c.key);
    if (done.has(urlKey)) {
      steps.push({ kind: "fetch", host: c.host, urlKey, status: "duplicate" });
      return null;
    }
    if (pages.length >= lim.maxPages) {
      steps.push({ kind: "fetch", host: c.host, urlKey, status: "limit_pages" });
      return null;
    }
    if (fetches >= lim.maxFetches) {
      steps.push({ kind: "fetch", host: c.host, urlKey, status: "limit_pages" });
      return null;
    }
    if (now() - t0 > lim.timeMs) {
      steps.push({ kind: "fetch", host: c.host, urlKey, status: "limit_time" });
      return null;
    }
    done.add(urlKey);
    fetches++;
    const r = await args.fetchPage(url).catch(() => ({ ok: false as const, reason: "failed" as const }));
    if (!r.ok) {
      steps.push({ kind: "fetch", host: c.host, urlKey, status: r.reason === "robots" || r.reason === "blocked" ? "blocked" : r.reason === "not_public" ? "not_public" : "failed" });
      return null;
    }
    steps.push({ kind: "fetch", host: c.host, urlKey, status: "ok", chars: r.text.length });
    pages.push({ n: pages.length + 1, text: r.text, urlKey, host: c.host });
    void depth;
    return r;
  };

  for (const url of planInvestigationUrls(args.members, done, lim.maxPages)) {
    const p = await fetchOne(url, 0);
    // 深さ1: 取得できたページの中の、同じホストの「応募」リンク1件まで
    if (p && lim.maxDepth >= 1) {
      const host = canonUrl(url).host;
      const link = p.links.find((l) => APPLY_LINK.test(l.text) && canonUrl(l.url).host === host && canonUrl(l.url).cls === "specific" && l.url.startsWith("https://"));
      if (link) await fetchOne(link.url, 1);
    }
  }
  if (!pages.length) return { steps, finding: null, hold: steps.some((s) => s.status === "ok") ? null : "no_page_fetched", fetches, calls: 0 };

  const need = 1000;
  const s = args.budget.start("investigate", Math.min(need / 1000, 1));
  if (!s.ok) {
    steps.push({ kind: "judge", host: null, urlKey: "", status: "limit_calls" });
    return { steps, finding: null, hold: `budget_${s.reason}`, fetches, calls: 0 };
  }
  let ans: StructureAnswer | null = null;
  let cost: number | null = null;
  try {
    const r = await args.judge(pages.map((p) => ({ n: p.n, text: p.text })));
    ans = r.answer;
    cost = r.costJpy;
  } catch {
    ans = null;
  } finally {
    s.finish(cost);
  }
  if (!ans || ans.applyUnit === "unknown") {
    steps.push({ kind: "judge", host: null, urlKey: "", status: "no_answer" });
    return { steps, finding: null, hold: "structure_not_determined", fetches, calls: 1 };
  }
  const page = pages.find((p) => p.n === ans.page) ?? pages[0];
  const verified = ans.quote.length >= 4 && flat(page.text).includes(flat(ans.quote));
  if (!verified) {
    steps.push({ kind: "judge", host: page.host, urlKey: page.urlKey, status: "quote_not_found" });
    return { steps, finding: null, hold: "quote_not_in_page", fetches, calls: 1 };
  }
  steps.push({ kind: "judge", host: page.host, urlKey: page.urlKey, status: "judged" });
  return { steps, finding: { applyUnit: ans.applyUnit, selectableStores: ans.selectableStores.slice(0, 60), products: ans.products.slice(0, 20), quoteVerified: true, urlKey: page.urlKey, host: page.host }, hold: null, fetches, calls: 1 };
}
