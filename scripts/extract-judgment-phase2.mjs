// 第2段階（保存済み実原文の評価）の読み取り専用の抽出（Stage 10F）。
//   node scripts/extract-judgment-phase2.mjs [--limit 30] [--since <UTC ISO>]            … dry-run（SQL・ゲート状態の表示のみ。接続しない）
//   npm run prod -- scripts/extract-judgment-phase2.mjs --execute --backup-done --expect-ref <本番のプロジェクトID> --yes-production
//     … 承認ゲートA・直近バックアップ・接続先の照合・二重ゲートがすべて揃ったときだけ、読み取り専用（CLIの --read-only＝読み取り専用トランザクション）で1回だけ読み取る
// **承認記録（eval/real-data/approvals.json のゲートA）が無い限り、実行しても接続しない**。出力は eval/real-data/（Git管理外）のみ。ログに原文・URL・IDを出さない。
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { APPROVALS_PATH, MAX_ROWS, NINE_Z_EARLIEST_ISO, assertSafeExtractSql, buildExtractSql, buildQueryArgs, checkGates, readApprovals, runExtraction } from "./lib/phase2-extract.mjs";
import { parseQueryRows } from "./lib/query-output.mjs";
import { PRODUCTION_REFS, assertProductionTarget } from "./lib/target.mjs";

const args = process.argv.slice(2);
const val = (name) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};
const execute = args.includes("--execute");
const yesProduction = args.includes("--yes-production") || process.env.TOREMANE_TARGET === "production";
const limit = val("limit") ?? MAX_ROWS;
const since = val("since") ?? NINE_Z_EARLIEST_ISO;

let sql;
try {
  sql = buildExtractSql({ limit, sinceIso: since });
  assertSafeExtractSql(sql);
} catch (e) {
  console.error(`入力が不正です: ${e.message}`);
  process.exit(2);
}
const approvals = readApprovals();
const gates = checkGates("extract", approvals);
console.log(`モード: ${execute ? "execute" : "dry-run"}`);
console.log(`件数の上限: ${Math.min(Number(limit), MAX_ROWS)} / 下限日時（UTC）: ${since}`);
console.log(`承認ゲートA: ${gates.ok ? "承認記録あり" : `未承認（${APPROVALS_PATH} に承認者・承認日・範囲の記載が必要）`}`);
console.log("--- 実行予定のSQL（読み取り専用。静的検査済み。実行時はCLIの --read-only で読み取り専用トランザクションも強制）---");
console.log(sql);

const linkedRef = (() => {
  try {
    return readFileSync("supabase/.temp/project-ref", "utf8").trim();
  } catch {
    return null;
  }
})();
const gitignoreText = existsSync(".gitignore") ? readFileSync(".gitignore", "utf8") : "";
// 完全バックアップの保存先（full-backup.mjs と同じ: BACKUP_DIR 既定 %USERPROFILE%TorecaBackups、BACKUP_DIR2 任意。いずれも full/ 配下）
const backupDirs = [process.env.BACKUP_DIR ?? join(homedir(), "TorecaBackups"), process.env.BACKUP_DIR2].filter(Boolean).map((d) => join(d, "full"));
const backupList = () => backupDirs.flatMap((d) => (existsSync(d) ? readdirSync(d).map((name) => ({ name, mtimeMs: statSync(join(d, name)).mtimeMs, size: statSync(join(d, name)).size })) : []));
const outPath = `eval/real-data/extract-${new Date().toISOString().replace(/[:.]/g, "-")}.json`;

/** 本番のCLI経路（接続はここだけ。runExtraction の確認がすべて通った後にだけ呼ばれる） */
async function query(text) {
  assertProductionTarget("extract-judgment-phase2"); // npm run prod 経由の本番設定でなければ停止
  const dir = mkdtempSync(join(tmpdir(), "tcg-p2-"));
  const file = join(dir, "q.sql");
  writeFileSync(file, text);
  try {
    const a = buildQueryArgs({ ref: val("expect-ref"), file });
    const r = spawnSync("npx", a, { encoding: "utf8", shell: process.platform === "win32", maxBuffer: 64 * 1024 * 1024 });
    if (r.status !== 0) throw new Error((r.stderr || "").replace(/eyJ[\w-]+\.[\w-]+\.[\w-]+/g, "***").slice(0, 300));
    return parseQueryRows(r.stdout);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

try {
  const res = await runExtraction({
    execute,
    yesProduction,
    approvals,
    backupDone: args.includes("--backup-done"),
    expectRef: val("expect-ref"),
    linkedRef,
    productionRefs: PRODUCTION_REFS,
    backupList,
    nowMs: Date.now(),
    limit,
    sinceIso: since,
    outPath,
    gitignoreText,
    query,
    write: (p, body) => {
      mkdirSync(dirname(p), { recursive: true });
      writeFileSync(p, body);
    },
  });
  if (res.mode === "dry-run") process.exit(0);
  if (!res.executed) {
    console.error("実行できません:");
    for (const r of res.reasons) console.error(` - ${r}`);
    process.exit(3);
  }
  console.log(`抽出完了: ${res.count}件（原文なし ${res.noText}件）→ ${outPath}（Git管理外）`);
  for (const l of res.log) console.log(JSON.stringify(l));
} catch (e) {
  console.error(`中止しました: ${e.message}`);
  process.exit(4);
}
