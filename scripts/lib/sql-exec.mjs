// SQL実行の共通処理（復元・復元訓練用）。実行先は2種類:
//   docker:<コンテナ名> ... ローカルの検証用Postgres（復元訓練。本番に触れない）
//   linked              ... リンク済みの Supabase プロジェクト（本番/新規プロジェクトへの復元。明示的な確認フラグが必要）
// 秘密や個人データは出力しない。
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** 検証用コンテナの管理ユーザー（Supabaseのイメージは supabase_admin。通常のpostgresイメージなら DRILL_DB_USER=postgres） */
const DB_USER = process.env.DRILL_DB_USER ?? "supabase_admin";

function run(cmd, args, input) {
  const r = spawnSync(cmd, args, { encoding: "utf8", input, maxBuffer: 1024 * 1024 * 512, shell: process.platform === "win32" && cmd === "npx" });
  return r;
}

/** SQLを実行する（結果は返さない）。失敗時は例外（メッセージ先頭のみ） */
export function execSql(target, sql) {
  if (target.startsWith("docker:")) {
    const r = run("docker", ["exec", "-i", target.slice(7), "psql", "-U", DB_USER, "-d", "postgres", "-v", "ON_ERROR_STOP=1", "-q"], sql);
    if (r.status !== 0) throw new Error((r.stderr || r.stdout || "").slice(0, 600));
    return;
  }
  if (target === "linked") {
    const dir = mkdtempSync(join(tmpdir(), "tcg-sql-"));
    const file = join(dir, "q.sql");
    writeFileSync(file, sql);
    try {
      const r = run("npx", ["supabase", "db", "query", "--linked", "-f", file]);
      if (r.status !== 0) throw new Error((r.stderr || r.stdout || "").replace(/eyJ[\w-]+\.[\w-]+\.[\w-]+/g, "***").slice(0, 600));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
    return;
  }
  throw new Error(`未対応の実行先: ${target}`);
}

/** 1つのjson値を返すSELECT（列名 res）を実行して値を返す */
export function queryJson(target, sql) {
  if (target.startsWith("docker:")) {
    const r = run("docker", ["exec", "-i", target.slice(7), "psql", "-U", DB_USER, "-d", "postgres", "-v", "ON_ERROR_STOP=1", "-At", "-q"], sql);
    if (r.status !== 0) throw new Error((r.stderr || r.stdout || "").slice(0, 600));
    return JSON.parse(r.stdout.trim().split("\n").pop());
  }
  const dir = mkdtempSync(join(tmpdir(), "tcg-sql-"));
  const file = join(dir, "q.sql");
  writeFileSync(file, sql);
  try {
    const r = run("npx", ["supabase", "db", "query", "--linked", "-f", file]);
    if (r.status !== 0) throw new Error((r.stderr || r.stdout || "").slice(0, 600));
    const out = r.stdout;
    const rows = JSON.parse(out.slice(out.indexOf("{"), out.lastIndexOf("}") + 1)).rows;
    return typeof rows[0].res === "string" ? JSON.parse(rows[0].res) : rows[0].res;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

export function readBackup(dir) {
  const manifest = JSON.parse(readFileSync(join(dir, "_manifest.json"), "utf8"));
  const tables = {};
  for (const t of Object.keys(manifest.counts)) tables[t] = JSON.parse(readFileSync(join(dir, `${t}.json`), "utf8"));
  return { manifest, tables };
}
