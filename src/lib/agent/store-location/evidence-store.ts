/**
 * 評価実行の証拠（取得したページ）の保存（Stage 8D-6）。サーバー側のみ（ファイル・ハッシュを使う）。
 *
 * 8D-5 で見つかった不具合の原因:
 *  - 実行記録（real-*.json）には、AIが見たページの本文を保存しておらず、再判定（replay）は共有のキャッシュ（cache.json）から URL で探していた。
 *  - そのキャッシュは「URL → 最後に取得した内容」で、実行をまたいで上書きされる（8D-5 の時点で、150件のURLのうち14件が複数の実行で取得されていた）。
 *    取得日時も実行IDも持たないため、再判定で「実行時とは別の時点のページ」が混入しても検出できなかった（P19・R1 の再判定の食い違い）。
 * 対策:
 *  - 実行ごとに、取得したページの台帳（pages-<実行ID>.jsonl）を新規作成して、店舗・順番・URL・取得日時・取得元（通信/キャッシュ）・本文・ハッシュを追記する。
 *    既存のファイルは上書きしない（作成は排他的。過去の評価結果を書き換えない）。
 *  - 評価実行のキャッシュも実行ごとに分ける（cache-<実行ID>.json）。別の実行のページを、AIにも再判定にも渡さない。
 *  - 再判定は台帳のページだけを使う。台帳の整合性（実行ID・ハッシュ・連番・取得日時・実行記録のツール呼び出しとの対応）は verifyLedger が検査する。
 */
import { createHash } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import type { TraceEvent } from "@/lib/agent/core";
import type { PageEvidence } from "@/lib/agent/store-location/verify";
import { detectInjection } from "@/lib/agent/core";

export interface PageLedgerEntry {
  runId: string;
  storeId: string;
  /** その店舗の中で、ページを取得した順（0始まり） */
  seq: number;
  url: string;
  finalUrl: string;
  title: string;
  text: string;
  links: { text: string; href: string }[];
  /** 本文を実際に取得した日時（ISO）。cache のときは、その実行の中で最初に取得した日時 */
  fetchedAt: string;
  origin: "network" | "cache";
  sha256: string;
}

export const sha256 = (s: string): string => createHash("sha256").update(s, "utf8").digest("hex");

/** 実行の経過（トレース）から、その店舗が取得したページを、取得した順に台帳の形にする */
export function ledgerEntriesFromTrace(runId: string, storeId: string, trace: TraceEvent[], now: () => string = () => new Date().toISOString()): PageLedgerEntry[] {
  const out: PageLedgerEntry[] = [];
  for (const e of trace) {
    if (e.t !== "tool" || !e.ok || e.name !== "fetch_page" || !e.data || typeof e.data !== "object") continue;
    const d = e.data as { url: string; finalUrl: string; title: string; text: string; links?: { text: string; href: string }[]; cached?: boolean; fetchedAt?: string };
    out.push({ runId, storeId, seq: out.length, url: d.url, finalUrl: d.finalUrl, title: d.title ?? "", text: d.text, links: d.links ?? [], fetchedAt: d.fetchedAt ?? now(), origin: d.cached ? "cache" : "network", sha256: sha256(d.text) });
  }
  return out;
}

export const ledgerPath = (dir: string, runId: string) => `${dir}/pages-${runId}.jsonl`;

/** 実行ごとの台帳。作成は排他的（同じ実行IDのファイルが既にあれば失敗する＝過去の保存データを上書き・改ざんしない）。追記のみ */
export class RunLedgerWriter {
  readonly path: string;
  constructor(dir: string, readonly runId: string, startedAt: string) {
    mkdirSync(dir, { recursive: true });
    this.path = ledgerPath(dir, runId);
    if (existsSync(this.path)) throw new Error(`証拠の台帳が既にあります（上書きしません）: ${this.path}`);
    writeFileSync(this.path, JSON.stringify({ kind: "ledger-header", runId, startedAt }) + "\n", { flag: "wx" });
  }
  append(entries: PageLedgerEntry[]): void {
    for (const e of entries) {
      if (e.runId !== this.runId) throw new Error("別の実行のページは、この台帳に追加できません");
      appendFileSync(this.path, JSON.stringify(e) + "\n");
    }
  }
}

export interface Ledger {
  runId: string;
  startedAt: string;
  entries: PageLedgerEntry[];
}
export function readLedger(path: string): Ledger {
  const lines = readFileSync(path, "utf8").split("\n").filter((l) => l.trim());
  const head = JSON.parse(lines[0]) as { kind?: string; runId: string; startedAt: string };
  if (head.kind !== "ledger-header") throw new Error("台帳の形式が不正です");
  return { runId: head.runId, startedAt: head.startedAt, entries: lines.slice(1).map((l) => JSON.parse(l) as PageLedgerEntry) };
}

/** 台帳から、その店舗のページ（AIが取得した順）を取り出す。再判定の証拠はこれだけを使う（他の店舗・他の実行のページは混ざらない） */
export function pagesForStore(ledger: Ledger, storeId: string): PageEvidence[] {
  return ledger.entries
    .filter((e) => e.storeId === storeId)
    .sort((a, b) => a.seq - b.seq)
    .map((e) => ({ url: e.url, finalUrl: e.finalUrl, title: e.title, text: e.text, links: e.links, injection: detectInjection(e.text).length > 0 }));
}

/**
 * 台帳の整合性の検査（問題の一覧。空なら整合）。
 *  - すべての項目が、この台帳の実行IDである（別の実行のページが混ざらない）
 *  - 本文のハッシュが一致する（保存後に書き換わっていない）
 *  - 店舗ごとの連番が 0,1,2… と連続し、重複しない（URL・取得日時・本文が1件ずつ対応する）
 *  - 取得日時が正しい形式で、実行の開始以降である（実行ごとにキャッシュを分けているため、古い時点のページが混入しない）
 *  - 実行記録のツール呼び出し（fetch_page の成功）と、台帳のURLが、順番も含めて対応する（actions を渡したとき）
 * 同じURLで内容（ハッシュ）が違うページは、別の取得結果として別の項目になる（上書きしない）。
 */
export function verifyLedger(ledger: Ledger, actions?: Record<string, { name: string; ok: boolean; arg: string }[]>): string[] {
  const problems: string[] = [];
  const start = Date.parse(ledger.startedAt);
  const byStore = new Map<string, PageLedgerEntry[]>();
  for (const e of ledger.entries) {
    if (e.runId !== ledger.runId) problems.push(`${e.storeId}#${e.seq}: 別の実行（${e.runId}）のページが混ざっている`);
    if (sha256(e.text) !== e.sha256) problems.push(`${e.storeId}#${e.seq}: 本文のハッシュが一致しない（保存後に変更された可能性）`);
    const t = Date.parse(e.fetchedAt);
    if (!Number.isFinite(t)) problems.push(`${e.storeId}#${e.seq}: 取得日時が不正`);
    else if (Number.isFinite(start) && t < start) problems.push(`${e.storeId}#${e.seq}: 取得日時が実行の開始より前（別の時点のページの混入）`);
    if (!e.url) problems.push(`${e.storeId}#${e.seq}: URLが空`);
    byStore.set(e.storeId, [...(byStore.get(e.storeId) ?? []), e]);
  }
  for (const [id, es] of byStore) {
    const seqs = es.map((e) => e.seq).sort((a, b) => a - b);
    if (seqs.some((s, i) => s !== i)) problems.push(`${id}: 連番が連続していない／重複している（${seqs.join(",")}）`);
  }
  if (actions) {
    for (const [id, acts] of Object.entries(actions)) {
      const fetched = acts.filter((a) => a.name === "fetch_page" && a.ok).map((a) => a.arg);
      const led = (byStore.get(id) ?? []).sort((a, b) => a.seq - b.seq).map((e) => e.url.slice(0, 120));
      if (fetched.length !== led.length || fetched.some((u, i) => u !== led[i])) problems.push(`${id}: 実行記録のページ取得（${fetched.length}件）と台帳（${led.length}件）が対応しない`);
    }
  }
  return problems;
}
