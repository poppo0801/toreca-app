/**
 * 有料試験の出力の耐障害的な永続化（追記専用ジャーナル・Node専用・Git管理外）。
 *
 * 目的: 実行の終了を待たず、**取得できた時点ごと**（案件×アーム1件の処理が終わるたび）に、実行ID・案件・アーム・判断・引用・検証・費用・状態を追記して fsync する。
 *   - 追記専用（既存の行を書き換えない）。実行IDごとに別ファイル（'wx' で作成。既存なら作らず失敗＝上書き・二重実行で過去の結果を消さない）。
 *   - 途中停止・異常終了でも、書き終えた行は残る。末尾の途中で切れた行は読み取り時に無視し、件数を報告する。
 *   - 同じ（実行ID・案件・アーム）の単位は二重に書かない（再実行・再開で保存済みの結果を上書きしない）。
 *   - 秘密情報（キー・トークン・認証ヘッダ）は書かない（キー名と値の形で除外）。原文の全文は書かない（引用・値・判断だけ）。ファイルはGit管理外（.gitignore）。
 *   - 保存済みの出力だけから、ローカルDBを使わずに再採点できる（journalRecords）。DBのテスト・初期化とは独立。
 */
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, readdirSync, writeSync } from "node:fs";

export type JournalKind = "run_start" | "unit" | "run_end" | "run_abort";
export interface JournalUnit {
  experiment: string;
  caseId: string;
  arm: string;
  role: "baseline" | "treatment";
}
export interface JournalEntry {
  v: 1;
  runId: string;
  seq: number;
  at: string;
  kind: JournalKind;
  /** run_start: 段階キー・承認額など（承認文は書かない） */
  meta?: Record<string, unknown>;
  unit?: JournalUnit;
  state?: "done" | "failed";
  costJpy?: number;
  reason?: string;
  /** 登録案の行（判断・最終の扱い・引用・検証・保留理由・費用）。DBの行の主要列だけ */
  proposals?: Record<string, unknown>[];
  summary?: Record<string, unknown>;
}

const SECRET_KEY = /(api[_-]?key|secret|token|authorization|password|bearer|service[_-]?role|cookie)/i;
const SECRET_VALUE = /(sk-[A-Za-z0-9_-]{16,}|eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{10,}|Bearer\s+[A-Za-z0-9._-]{12,})/g;
/** 秘密らしいキー名の項目を除き、秘密らしい値の形を伏せる（深さ・件数に上限） */
export function scrub<T>(x: T, depth = 0): T {
  if (depth > 8) return null as T;
  if (typeof x === "string") return x.replace(SECRET_VALUE, "[redacted]") as T;
  if (Array.isArray(x)) return x.slice(0, 500).map((v) => scrub(v, depth + 1)) as T;
  if (x && typeof x === "object") {
    const o: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(x as Record<string, unknown>)) if (!SECRET_KEY.test(k)) o[k] = scrub(v, depth + 1);
    return o as T;
  }
  return x;
}

export const journalPath = (dir: string, runId: string): string => `${dir}/${runId}.journal.local.jsonl`;
const safeId = (id: string): boolean => /^[A-Za-z0-9._-]{1,80}$/.test(id);

function appendLine(path: string, flag: "wx" | "a", e: JournalEntry): void {
  const fd = openSync(path, flag);
  try {
    writeSync(fd, JSON.stringify(e) + "\n");
    fsyncSync(fd); // OSの書き込みキャッシュに残さない（電源断・強制終了でも、ここまでは残る）
  } finally {
    closeSync(fd);
  }
}

/** 読み取り。壊れた行（末尾の書きかけ）は無視し、件数を返す */
export function readJournal(path: string): { entries: JournalEntry[]; torn: number } {
  if (!existsSync(path)) return { entries: [], torn: 0 };
  const entries: JournalEntry[] = [];
  let torn = 0;
  for (const line of readFileSync(path, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try {
      const e = JSON.parse(line) as JournalEntry;
      if (e && e.v === 1 && typeof e.runId === "string" && typeof e.kind === "string") entries.push(e);
      else torn++;
    } catch {
      torn++;
    }
  }
  return { entries, torn };
}

export const unitKey = (u: Pick<JournalUnit, "experiment" | "caseId" | "arm">): string => `${u.experiment}|${u.caseId}|${u.arm}`;

export type JournalStatus = "empty" | "running_or_interrupted" | "finished" | "aborted";
export function statusOf(entries: readonly JournalEntry[]): JournalStatus {
  if (entries.length === 0) return "empty";
  if (entries.some((e) => e.kind === "run_end")) return "finished";
  if (entries.some((e) => e.kind === "run_abort")) return "aborted";
  return "running_or_interrupted";
}

/** 新しい実行のジャーナルを作る。同じ実行IDのファイルが既にあれば失敗する（上書き・二重実行の防止） */
export function startJournal(dir: string, runId: string, meta: Record<string, unknown>): { ok: true; path: string } | { ok: false; reason: string } {
  if (!safeId(runId)) return { ok: false, reason: "invalid_run_id" };
  mkdirSync(dir, { recursive: true });
  const path = journalPath(dir, runId);
  try {
    appendLine(path, "wx", { v: 1, runId, seq: 0, at: new Date().toISOString(), kind: "run_start", meta: scrub(meta) });
    return { ok: true, path };
  } catch {
    return { ok: false, reason: "journal_exists_or_unwritable" };
  }
}

/** 単位（案件×アーム）の結果を追記する。同じ単位が既に記録済みなら書かない（保存済みの結果を上書きしない）。書けなければ例外（呼び出し側は有料呼び出しを止める） */
export function appendUnit(path: string, e: { runId: string; unit: JournalUnit; state: "done" | "failed"; costJpy: number; reason?: string; proposals?: Record<string, unknown>[] }): { written: boolean; reason?: string } {
  const { entries } = readJournal(path);
  if (entries.some((x) => x.kind === "unit" && x.unit && unitKey(x.unit) === unitKey(e.unit))) return { written: false, reason: "duplicate_unit" };
  if (entries.some((x) => x.kind === "run_end" || x.kind === "run_abort")) return { written: false, reason: "run_closed" };
  const seq = entries.length;
  appendLine(path, "a", { v: 1, runId: e.runId, seq, at: new Date().toISOString(), kind: "unit", unit: e.unit, state: e.state, costJpy: e.costJpy, ...(e.reason ? { reason: e.reason } : {}), ...(e.proposals ? { proposals: scrub(e.proposals) } : {}) });
  return { written: true };
}

export function closeJournal(path: string, runId: string, kind: "run_end" | "run_abort", summary: Record<string, unknown>): { written: boolean } {
  const { entries } = readJournal(path);
  if (entries.some((x) => x.kind === "run_end" || x.kind === "run_abort")) return { written: false };
  appendLine(path, "a", { v: 1, runId, seq: entries.length, at: new Date().toISOString(), kind, summary: scrub(summary) });
  return { written: true };
}

/** 完了済み（done）の単位の集合。再開で、保存済みの単位をやり直さない（費用の二重計上を避ける） */
export function doneUnits(entries: readonly JournalEntry[]): Set<string> {
  return new Set(entries.filter((e) => e.kind === "unit" && e.state === "done" && e.unit).map((e) => unitKey(e.unit!)));
}

/** 実行ID順に、終了していない実行（実行中・異常終了）を探す。二重実行の検出・復旧の案内用 */
export function findUnfinished(dir: string): { runId: string; path: string; units: number }[] {
  if (!existsSync(dir)) return [];
  const out: { runId: string; path: string; units: number }[] = [];
  for (const f of readdirSync(dir).filter((x) => x.endsWith(".journal.local.jsonl")).sort()) {
    const path = `${dir}/${f}`;
    const { entries } = readJournal(path);
    if (statusOf(entries) === "running_or_interrupted") out.push({ runId: f.replace(".journal.local.jsonl", ""), path, units: entries.filter((e) => e.kind === "unit").length });
  }
  return out;
}

/** 保存済みの出力から、案件×アームの登録案の行を取り出す（DB不要の再採点用） */
export function journalRows(entries: readonly JournalEntry[]): Map<string, Record<string, unknown>[]> {
  const m = new Map<string, Record<string, unknown>[]>();
  for (const e of entries) if (e.kind === "unit" && e.unit && e.state === "done") m.set(unitKey(e.unit), e.proposals ?? []);
  return m;
}
