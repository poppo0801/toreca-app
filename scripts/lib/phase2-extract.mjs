// Stage 10E 第2段階（保存済み実原文の評価）の抽出の安全機構。**純関数のみ。DB・ネットワークには接続しない**。
// 実際の抽出（本番DBの読み取り）は、承認ゲートAの個別承認後に別途実装する（今回は接続コードを含めない）。
// 層の防御: ①静的なSQL検査（読み取り専用・列ホワイトリスト・最大30件）②承認記録（ローカルファイル）③`--execute` と `--yes-production` の二重ゲート
//          ④実行時に DB 側でも読み取り専用を強制（`supabase db query --linked --read-only`。既存の full-backup.mjs と同じ方式）
//          ⑤出力先はローカルの Git 管理外（eval/real-data/）のみ ⑥ログに原文・個人情報を出さない
import { existsSync, readFileSync } from "node:fs";

export const PHASE2_ROOT = "eval/real-data";
export const MAX_ROWS = 30;
export const MAX_NO_TEXT = 3;
/**
 * 9Z（原文保存）導入の下限。出典: PR #26 のマージ 2026-11-20 10:09:01 +0900（コミット ef1943a）、本番反映の記録 2026-11-20 10:10 +0900（1527380）。
 * 実際のデプロイ完了時刻は履歴から確定できないため、**抽出は日付ではなく「原文が保存された行そのもの」（evidence.v = 1 と fetchedAt）で絞る**。
 * この値は、それ以前の行を除くための保守的な下限（承認時に確定する）。
 */
export const NINE_Z_EARLIEST_ISO = "2026-11-20T01:09:01Z";

/** 読み取る列（これ以外は読まない）。household_id・応募/当選/購入・個人名義・draft（人の入力を含みうる）は含めない */
export const ALLOWED_SELECT_COLUMNS = ["id", "status", "created_at", "evidence_text", "evidence_fetched_at", "evidence_via", "evidence_origin", "evidence_hash", "evidence_url"];

/** 抽出SQLを組み立てる。条件値はすべて検証済みの値だけを埋め込む（インジェクション防止のため、since は ISO 日時形式のみ・limit は整数のみ） */
export function buildExtractSql({ limit = MAX_ROWS, sinceIso = NINE_Z_EARLIEST_ISO } = {}) {
  const n = clampLimit(limit);
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/.test(String(sinceIso))) throw new Error("since は UTC の ISO 日時（例: 2026-11-20T01:09:01Z）で指定してください");
  return [
    "select",
    "  cp.id,",
    "  cp.status,",
    "  cp.created_at,",
    "  cp.last_good->'evidence'->>'text' as evidence_text,",
    "  cp.last_good->'evidence'->>'fetchedAt' as evidence_fetched_at,",
    "  cp.last_good->'evidence'->>'via' as evidence_via,",
    "  cp.last_good->'evidence'->>'origin' as evidence_origin,",
    "  cp.last_good->'evidence'->>'hash' as evidence_hash,",
    "  cp.last_good->'evidence'->>'url' as evidence_url",
    "from public.collection_candidates cp",
    "where cp.last_good->'evidence'->>'v' = '1'",
    `  and (cp.last_good->'evidence'->>'fetchedAt') >= '${sinceIso}'`,
    "order by (cp.last_good->'evidence'->>'fetchedAt') desc, cp.id",
    `limit ${n}`,
  ].join("\n");
}

export function clampLimit(x) {
  const n = Number(x);
  if (!Number.isInteger(n) || n < 1) throw new Error("件数は1以上の整数で指定してください");
  return Math.min(n, MAX_ROWS);
}

const FORBIDDEN = /\b(insert|update|delete|drop|alter|create|truncate|grant|revoke|copy|call|do|execute|merge|vacuum|analyze|set|reset|begin|commit|rollback|lock|notify|listen|comment|refresh|reindex|cluster|security|explain)\b|;|--|\/\*|pg_|information_schema|\bhousehold_id\b|\bdraft\b|\bapplications\b|\bprofiles\b/i;

/** 静的なSQL検査: 単一の SELECT・対象は collection_candidates だけ・禁止語なし・列は証拠関連のみ・limit ≤ 30。通らなければ例外 */
export function assertSafeExtractSql(sql) {
  const s = String(sql);
  if (!/^\s*select\b/i.test(s)) throw new Error("SELECT 以外は実行できません");
  if (FORBIDDEN.test(s)) throw new Error("禁止された語・記号が含まれています（読み取り専用の単一SELECTのみ許可）");
  const from = [...s.matchAll(/\b(?:from|join)\s+([\w.]+)/gi)].map((m) => m[1].toLowerCase());
  if (from.length !== 1 || from[0] !== "public.collection_candidates") throw new Error("対象表は public.collection_candidates のみです");
  const lim = s.match(/\blimit\s+(\d+)\s*$/i);
  if (!lim || Number(lim[1]) > MAX_ROWS) throw new Error(`limit は ${MAX_ROWS} 以下を末尾に指定してください`);
  const aliases = [...s.matchAll(/\bas\s+(\w+)/gi)].map((m) => m[1]);
  for (const a of aliases) if (!ALLOWED_SELECT_COLUMNS.includes(a)) throw new Error(`許可されていない列: ${a}`);
  const cols = [...s.matchAll(/\bcp\.(\w+)/g)].map((m) => m[1]);
  for (const c of cols) if (!["id", "status", "created_at", "last_good"].includes(c)) throw new Error(`許可されていない列: cp.${c}`);
  for (const m of s.matchAll(/last_good->'evidence'->>'(\w+)'/g)) if (!["text", "fetchedAt", "via", "origin", "hash", "url", "v"].includes(m[1])) throw new Error(`許可されていない項目: evidence.${m[1]}`);
  return true;
}

// ---------------------------------------------------------------- 承認記録（ローカル。Git管理外）
export const GATES = ["A", "B", "C", "D", "E"];
export const APPROVALS_PATH = `${PHASE2_ROOT}/approvals.json`;

/** 承認記録を読む。無い・壊れている・形式が違うなら、すべて未承認として扱う（安全側） */
export function readApprovals(path = APPROVALS_PATH) {
  try {
    if (!existsSync(path)) return {};
    const j = JSON.parse(readFileSync(path, "utf8"));
    const out = {};
    for (const g of GATES) {
      const a = j?.gates?.[g];
      // 承認は、承認者・承認日・範囲の記載がある true のみ有効（真偽値だけでは通さない）
      if (a && a.approved === true && typeof a.by === "string" && a.by.trim() && !/^ai\b|claude/i.test(a.by) && /^\d{4}-\d{2}-\d{2}$/.test(String(a.at)) && typeof a.scope === "string" && a.scope.trim()) out[g] = { approved: true };
    }
    return out;
  } catch {
    return {};
  }
}

/** 行為ごとに必要なゲート */
export const REQUIRED_GATES = {
  extract: ["A"],
  review: ["A", "B"],
  send_external: ["A", "B", "C"],
  // 課金評価（新旧のシャドー比較を含む）: gold（D）は必須にしない。正解率を断定するときだけ別途 D が必要（paid_eval_with_gold）
  paid_eval: ["A", "B", "C", "E"],
  paid_eval_with_gold: ["A", "B", "C", "D", "E"],
};

export function checkGates(action, approvals) {
  const need = REQUIRED_GATES[action];
  if (!need) throw new Error(`未知の行為: ${action}`);
  const missing = need.filter((g) => !approvals?.[g]?.approved);
  return missing.length ? { ok: false, missing } : { ok: true, missing: [] };
}

/**
 * 抽出の実行可否。dry-run（既定）は常に可（接続せず計画だけ表示）。実行は、`--execute`・`--yes-production`・ゲートA承認・バックアップ済みの申告・対象が本番であること、がすべて必要。
 * 今回の実装は接続コードを持たないため、すべて満たしても「接続コードが未実装」で止まる（承認後に別途実装する）。
 */
export function planExtractRun({ execute = false, yesProduction = false, approvals = {}, backupDone = false } = {}) {
  if (!execute) return { mode: "dry-run", canConnect: false, reasons: [] };
  const reasons = [];
  if (!yesProduction) reasons.push("--yes-production がありません（npm run prod 経由で、本番への作用を確認する必要があります）");
  const g = checkGates("extract", approvals);
  if (!g.ok) reasons.push(`承認ゲート ${g.missing.join("・")} が未承認です（${APPROVALS_PATH} に承認者・承認日・範囲が必要）`);
  if (!backupDone) reasons.push("実行前の npm run backup:full の完了が確認できません（--backup-done の申告が必要）");
  reasons.push("本番へ接続するコードは未実装です（ゲートA承認後に別途実装・レビューする）");
  return { mode: "execute", canConnect: false, reasons };
}

// ---------------------------------------------------------------- ローカル保存先・ログ
/** 出力先は eval/real-data/ 配下だけ（..・絶対パス・別の場所は拒否）。.gitignore に同じパスがあることも確認する */
export function assertLocalOutputPath(path, gitignoreText) {
  const p = String(path).replace(/\\/g, "/");
  if (!p.startsWith(`${PHASE2_ROOT}/`) || p.includes("..") || /^[a-zA-Z]:/.test(p)) throw new Error(`出力先は ${PHASE2_ROOT}/ 配下のみです`);
  if (!String(gitignoreText).split(/\r?\n/).some((l) => l.trim() === `${PHASE2_ROOT}/`)) throw new Error(`.gitignore に ${PHASE2_ROOT}/ がありません`);
  return true;
}

/** ログに出してよい形（原文・URL・id・個人情報は出さない。連番・層・文字数・ハッシュ先頭のみ） */
export function safeLogRow(row, seq) {
  return { seq, stratum: row.stratum ?? null, chars: typeof row.evidence_text === "string" ? row.evidence_text.length : 0, hash: typeof row.evidence_hash === "string" ? `${row.evidence_hash.slice(0, 6)}…` : null };
}

/** 削除記録（原文を含めない。ファイル名・バイト数・件数・日時のみ） */
export function buildDeletionRecord(files, at) {
  return { deletedAt: at, count: files.length, totalBytes: files.reduce((s, f) => s + (f.bytes || 0), 0), files: files.map((f) => ({ name: String(f.name).split(/[\\/]/).pop(), bytes: f.bytes || 0 })), note: "原文・評価記録のローカル写しを削除した記録（内容は含まない）" };
}
