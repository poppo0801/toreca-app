/**
 * 取得した公開ページの全文の保存・読戻し・取得網羅性の計測（Phase 2 証拠の網羅性）。
 *  - 原則: 取得が許された公開情報は、再解析できるよう元の意味を失わず保持する。収集時の保存（先頭3,000字）で切れた本文を、取得時の全文で補う。
 *  - 保存するのは整形後の全文テキスト・構造化の観察・取得URL/時刻/ハッシュ・切り詰めの事実。**原HTMLは保存しない**（容量・著作権・機密。構造は観察として残す）。
 *  - 書き込みはサービス権限のみ（RLS）。失敗は握り潰さず分類して返し、呼び出し側は処理を止めない（保存の失敗で調査結果を失わない）。
 *  - 計測（evidence_coverage_stats）は原文・URLを含まない（ホスト名・字数・位置・件数・結果のみ）。人の確認結果と突き合わせて、取得・読む範囲の最適化に使う（サイト名の固定ルールにはしない）。
 */
import { createHash } from "node:crypto";
import { canonUrl } from "@/lib/judgment/xsource/normalize";
import type { ApplyPageStructure } from "@/lib/judgment/xsource/page-structure";
import { FULL_VIEW_CHARS, shownRanges, type Evidence, type ResearchResult } from "@/lib/judgment/xsource/research-loop";
import type { Db } from "@/lib/server/lottery-service";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Loose = { from: (n: string) => any };
const t = (db: Db, name: string) => (db as unknown as Loose).from(name);

/** 1ページの保存上限（DBの制約と一致）。超える分は切り詰めて、truncated と理由を残す */
export const MAX_DOC_CHARS = 400_000;

export interface StoredDocument {
  /** page=リンク先ページ／post=X投稿本文（既定は page） */
  kind?: "page" | "post";
  url: string;
  urlKey: string;
  origin: string;
  contentHash: string;
  fetchedAt: string;
  text: string;
  textChars: number;
  sourceChars: number | null;
  truncated: boolean;
  truncatedReason: string | null;
  structure: ApplyPageStructure | null;
  textLoss: string[] | null;
}

const hashOf = (s: string): string => createHash("sha256").update(s).digest("hex").slice(0, 32);

/** 調査で得た証拠（ページ）を、保存用の形にする。収集時に切り詰められた本文は truncated として残す（情報なしと区別する） */
export function documentFromEvidence(e: Evidence, o: { collectorTruncatedAt?: number } = {}): StoredDocument | null {
  if (e.kind !== "page" || !e.url) return null;
  const cut = e.text.length > MAX_DOC_CHARS;
  const collectorCut = o.collectorTruncatedAt !== undefined && e.text.length >= o.collectorTruncatedAt;
  const text = cut ? e.text.slice(0, MAX_DOC_CHARS) : e.text;
  return {
    url: e.url.slice(0, 500),
    urlKey: canonUrl(e.url).key.slice(0, 300),
    origin: (e.scope?.origin ?? "unknown").slice(0, 40),
    contentHash: hashOf(e.text),
    fetchedAt: e.fetchedAt,
    text,
    textChars: text.length,
    sourceChars: cut ? e.text.length : collectorCut ? null : e.text.length,
    truncated: cut || collectorCut,
    truncatedReason: cut ? "doc_max_chars" : collectorCut ? "collector_limit" : null,
    structure: e.structure,
    textLoss: e.textLoss ?? null,
  };
}

export type StoreFailure = "db_error" | "invalid";
export async function saveDocuments(db: Db, householdId: string, candidateId: string, docs: StoredDocument[]): Promise<{ saved: number; existing: number; failed: number }> {
  const out = { saved: 0, existing: 0, failed: 0 };
  for (const d of docs) {
    try {
      const r = (await t(db, "evidence_documents").insert({
        household_id: householdId,
        candidate_id: candidateId,
        url: d.url,
        url_key: d.urlKey,
        kind: d.kind ?? "page",
        origin: d.origin,
        content_hash: d.contentHash,
        fetched_at: d.fetchedAt,
        text_chars: d.textChars,
        source_chars: d.sourceChars,
        truncated: d.truncated,
        truncated_reason: d.truncatedReason,
        text: d.text,
        structure: d.structure ? (JSON.parse(JSON.stringify(d.structure)) as object) : null,
        text_loss: d.textLoss,
      })) as { error: { code?: string } | null };
      if (!r.error) out.saved++;
      else if (r.error.code === "23505") out.existing++; // 同じ内容は保存済み（冪等）
      else out.failed++;
    } catch {
      out.failed++;
    }
  }
  return out;
}

/** 候補に保存された、そのURLの最も完全な本文（切り詰めのないもの・字数が多いもの・新しいものを優先）。無ければ null */
export async function loadBestDocument(db: Db, householdId: string, candidateId: string, url: string): Promise<StoredDocument | null> {
  try {
    const key = canonUrl(url).key.slice(0, 300);
    const r = (await t(db, "evidence_documents").select("url,url_key,origin,content_hash,fetched_at,text,text_chars,source_chars,truncated,truncated_reason,structure,text_loss").eq("household_id", householdId).eq("candidate_id", candidateId).eq("url_key", key).order("truncated", { ascending: true }).order("text_chars", { ascending: false }).order("fetched_at", { ascending: false }).limit(1)) as { data: Record<string, unknown>[] | null };
    const x = r.data?.[0];
    if (!x) return null;
    return { url: String(x.url), urlKey: String(x.url_key), origin: String(x.origin), contentHash: String(x.content_hash), fetchedAt: String(x.fetched_at), text: String(x.text), textChars: Number(x.text_chars), sourceChars: x.source_chars === null ? null : Number(x.source_chars), truncated: !!x.truncated, truncatedReason: (x.truncated_reason as string | null) ?? null, structure: (x.structure as ApplyPageStructure | null) ?? null, textLoss: (x.text_loss as string[] | null) ?? null };
  } catch {
    return null;
  }
}

// ------------------------------------------------------------------ 取得網羅性の計測（原文・URLを含まない）
/** 文書の識別子（正規化したURLのハッシュ先頭16桁）。計測にURLそのものを残さない */
export const urlHashOf = (url: string): string => createHash("sha256").update(canonUrl(url).key).digest("hex").slice(0, 16);

export interface CoverageStat {
  proposalKey: string | null;
  host: string;
  sourceChars: number;
  truncated: boolean;
  viewMode: "full" | "indexed";
  shownChars: number;
  reads: number;
  readChars: number;
  firstReadAt: number | null;
  /** 文書の識別（URLのハッシュ）と、AIの入力に出ていた区間・readした区間（字位置。最大各40区間） */
  urlHash?: string | null;
  shownRanges?: number[][];
  readRanges?: number[][];
  fetchOutcome: string;
  endReason: string;
  decision: "register" | "tentative" | "exclude" | "none";
  unresolved: string[];
  costJpy: number | null;
  mode: "mock" | "replay" | "real";
}

/** 1項目の調査結果から、ページごとの計測行を作る。ページが無い項目（取得できなかった・URLなし）も1行（host=none）で残す */
export function coverageStatsOf(a: { proposalKey: string | null; result: ResearchResult; mode: CoverageStat["mode"]; collectorLimit?: number }): CoverageStat[] {
  const r = a.result;
  const common = { proposalKey: a.proposalKey, endReason: r.investigation.reason.slice(0, 30), decision: r.registration.decision, unresolved: (r.registration.held?.reasons ?? []).map((x) => x.slice(0, 40)).slice(0, 12), costJpy: r.budget.costJpy, mode: a.mode };
  const pages = r.evidence.filter((e) => e.kind === "page");
  const outcome = (host: string): string => r.history.find((h) => h.host === host)?.outcome ?? "none";
  if (!pages.length) return [{ ...common, host: "none", sourceChars: 0, truncated: false, viewMode: "full", shownChars: 0, reads: 0, readChars: 0, firstReadAt: null, fetchOutcome: r.history[0]?.outcome ?? "none" }];
  return pages.map((e) => {
    const host = (e.url ? canonUrl(e.url).host : "unknown").slice(0, 120);
    const reads = e.reads ?? [];
    return { ...common, host, sourceChars: e.text.length, truncated: !!e.notice || (a.collectorLimit !== undefined && e.text.length >= a.collectorLimit), viewMode: e.text.length > FULL_VIEW_CHARS ? "indexed" : "full", shownChars: shownRanges(e).reduce((s, x) => s + (x.to - x.from), 0), reads: reads.length, readChars: reads.reduce((s, x) => s + (x.to - x.from), 0), firstReadAt: reads.length ? Math.min(...reads.map((x) => x.from)) : null, urlHash: e.url ? urlHashOf(e.url) : null, shownRanges: shownRanges(e).slice(0, 40).map((x) => [x.from, x.to]), readRanges: reads.slice(0, 40).map((x) => [x.from, x.to]), fetchOutcome: outcome(host).slice(0, 30) };
  });
}

export async function saveCoverageStats(db: Db, householdId: string, stats: CoverageStat[]): Promise<{ saved: number; failed: number }> {
  const out = { saved: 0, failed: 0 };
  for (const s of stats) {
    try {
      const r = (await t(db, "evidence_coverage_stats").insert({ household_id: householdId, proposal_key: s.proposalKey, host: s.host, source_chars: s.sourceChars, truncated: s.truncated, view_mode: s.viewMode, shown_chars: s.shownChars, reads: s.reads, read_chars: s.readChars, first_read_at: s.firstReadAt, url_hash: s.urlHash ?? null, shown_ranges: s.shownRanges ?? [], read_ranges: s.readRanges ?? [], fetch_outcome: s.fetchOutcome, end_reason: s.endReason, decision: s.decision, unresolved: s.unresolved, cost_jpy: s.costJpy, mode: s.mode })) as { error: unknown };
      if (r.error) out.failed++;
      else out.saved++;
    } catch {
      out.failed++;
    }
  }
  return out;
}

export interface HostCoverageSummary {
  host: string;
  runs: number;
  avgSourceChars: number;
  truncatedRate: number;
  indexedRate: number;
  readRate: number;
  avgFirstReadAt: number | null;
  failureRate: number;
}
/**
 * ホスト別の取得網羅性の傾向（過去の実績の要約）。**判断に使う固定ルールではなく、AIの判断・最適化の比較実験に提示する候補**。サンプルが少ない（minRuns 未満）ホストは出さない。
 */
export async function loadCoverageSummary(db: Db, householdId: string, minRuns = 3): Promise<HostCoverageSummary[]> {
  try {
    const r = (await t(db, "evidence_coverage_stats").select("host,source_chars,truncated,view_mode,reads,first_read_at,fetch_outcome").eq("household_id", householdId).neq("host", "none").order("created_at", { ascending: false }).limit(2000)) as { data: { host: string; source_chars: number; truncated: boolean; view_mode: string; reads: number; first_read_at: number | null; fetch_outcome: string }[] | null };
    const by = new Map<string, NonNullable<typeof r.data>>();
    for (const x of r.data ?? []) by.set(x.host, [...(by.get(x.host) ?? []), x]);
    const out: HostCoverageSummary[] = [];
    for (const [host, xs] of by) {
      if (xs.length < minRuns) continue;
      const firsts = xs.map((x) => x.first_read_at).filter((v): v is number => v !== null);
      const rate = (n: number): number => Math.round((n / xs.length) * 100) / 100;
      out.push({ host, runs: xs.length, avgSourceChars: Math.round(xs.reduce((s, x) => s + x.source_chars, 0) / xs.length), truncatedRate: rate(xs.filter((x) => x.truncated).length), indexedRate: rate(xs.filter((x) => x.view_mode === "indexed").length), readRate: rate(xs.filter((x) => x.reads > 0).length), avgFirstReadAt: firsts.length ? Math.round(firsts.reduce((s, v) => s + v, 0) / firsts.length) : null, failureRate: rate(xs.filter((x) => x.fetch_outcome !== "ok").length) });
    }
    return out.sort((a, b) => b.runs - a.runs);
  } catch {
    return [];
  }
}
