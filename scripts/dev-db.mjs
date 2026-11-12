// 開発用ローカルSupabase（Docker）の操作。Stage 8C。
//   node scripts/dev-db.mjs up | down | status | reset | env | seed | check
// - 作業フォルダ .dev-supabase/ に repo の config.toml と migrations をコピーし、ポートを 553xx に変えて起動する
//   （家計簿アプリのコンテナが標準ポート 54321〜 を使うため。家計簿には触れない）。
// - env: 起動中のローカルDBの値で .env.local を作る（本番の値は入れない。既存の .env.local は .env.local.bak に退避）。
// - seed / reset / env は接続先がローカルであることを確認してから実行する。本番には作用しない。
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync, copyFileSync } from "node:fs";
import { assertLocalTarget, classifyTarget, describeTarget } from "./lib/target.mjs";

const WORK = ".dev-supabase";
const EXCLUDE = "studio,inbucket,edge-runtime,logflare,vector,imgproxy,supavisor";
const cmd = process.argv[2] ?? "status";

function sb(args, opts = {}) {
  return spawnSync("npx", ["supabase", ...args, "--workdir", WORK], { stdio: opts.capture ? ["ignore", "pipe", "pipe"] : "inherit", shell: true, encoding: "utf8" });
}

function dockerOk() {
  const r = spawnSync("docker", ["info"], { stdio: "ignore", shell: true });
  if (r.status !== 0) {
    console.error("Docker が起動していません。Docker Desktop を起動してから再実行してください。");
    process.exit(1);
  }
}

/** repo の設定からポートとプロジェクト名を変えた作業用設定を作り、migrations を同期する */
function prepare() {
  mkdirSync(`${WORK}/supabase`, { recursive: true });
  let toml = readFileSync("supabase/config.toml", "utf8");
  toml = toml.replace(/^project_id = .*/m, 'project_id = "tcg-dev"');
  toml = toml.replace(/^(\s*(?:shadow_)?port\s*=\s*)543(\d\d)/gm, "$1553$2");
  writeFileSync(`${WORK}/supabase/config.toml`, toml);
  rmSync(`${WORK}/supabase/migrations`, { recursive: true, force: true });
  cpSync("supabase/migrations", `${WORK}/supabase/migrations`, { recursive: true });
  console.log(`作業フォルダを同期しました（マイグレーション ${readdirSync(`${WORK}/supabase/migrations`).length} 本、ポート 553xx）`);
}

function statusEnv() {
  const r = sb(["status", "-o", "env"], { capture: true });
  if (r.status !== 0) return null;
  const env = {};
  for (const line of r.stdout.split("\n")) {
    const m = /^([A-Z_]+)="?(.*?)"?\s*$/.exec(line.trim());
    if (m) env[m[1]] = m[2];
  }
  return env.API_URL && env.SERVICE_ROLE_KEY ? env : null;
}

function loadLocalEnv() {
  try {
    process.loadEnvFile(".env.local");
  } catch {
    /* 無ければ判定で止まる */
  }
}

if (cmd === "up") {
  dockerOk();
  prepare();
  const r = sb(["start", "-x", EXCLUDE]);
  if (r.status !== 0) process.exit(r.status ?? 1);
  console.log("起動しました。.env.local をローカル値にするには: npm run db:env");
} else if (cmd === "down") {
  dockerOk();
  const r = sb(["stop"]); // データは残す（消すには db:reset）
  process.exit(r.status ?? 0);
} else if (cmd === "status") {
  const env = statusEnv();
  console.log(env ? `ローカルDB: 起動中（${env.API_URL}）` : "ローカルDB: 停止中（npm run db:up）");
  loadLocalEnv();
  const t = describeTarget();
  console.log(`.env.local の接続先: ${t.kind}（${t.host}）${t.kind === "local" ? "" : "  ← 開発用ではありません。npm run db:env で直してください"}`);
} else if (cmd === "reset") {
  dockerOk();
  prepare();
  const env = statusEnv();
  if (!env || classifyTarget(env.API_URL, env.SERVICE_ROLE_KEY) !== "local") {
    console.error("ローカルDBが起動していません（または接続先がローカルではありません）。npm run db:up を先に実行してください。");
    process.exit(1);
  }
  // db reset はこの作業フォルダのローカルDBだけに作用する（--local 固定。--linked は使わない）
  const r = sb(["db", "reset", "--local"]);
  if (r.status !== 0) process.exit(r.status ?? 1);
  console.log("初期化しました。テストデータは npm run db:seed");
} else if (cmd === "env") {
  const env = statusEnv();
  if (!env || classifyTarget(env.API_URL, env.SERVICE_ROLE_KEY) !== "local") {
    console.error("ローカルDBが起動していません。npm run db:up を先に実行してください。");
    process.exit(1);
  }
  if (existsSync(".env.local")) {
    // 本番の値が入っている .env.local は、本番用の入口の設定ファイルへ退避済みであることを確認してから置き換える
    const text = readFileSync(".env.local", "utf8");
    process.loadEnvFile?.(".env.local");
    const wasProd = classifyTarget(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY) === "production";
    if (wasProd && !existsSync(".env.production-ops")) {
      console.error("現在の .env.local は本番の値です。先に本番用の入口へ移してください: copy .env.local .env.production-ops（docs/DEV_ENVIRONMENT.md）");
      process.exit(1);
    }
    copyFileSync(".env.local", ".env.local.bak");
    void text;
  }
  const lines = [
    "# 開発用（ローカルSupabase）。npm run db:env が生成。本番の値は入れない。Git管理外。",
    "# 本番の設定は .env.production-ops（npm run prod 経由でのみ読む）。",
    "TOREMANE_ENV=local",
    "NEXT_PUBLIC_DATA_SOURCE=supabase",
    `NEXT_PUBLIC_SUPABASE_URL=${env.API_URL}`,
    `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY=${env.ANON_KEY}`,
    `SUPABASE_SERVICE_ROLE_KEY=${env.SERVICE_ROLE_KEY}`,
    "# 外部への副作用は無効（AIはモック。X・Web Push・Anthropic の実キーは入れない）",
    "AI_PROVIDER=mock",
    "CRON_SECRET=dev-local-cron-secret-not-for-production",
    "",
  ];
  // 実API評価用の開発専用設定（AGENT_*）は、書き換えても消さずに引き継ぐ（Stage 8D-5。以前は消えて、開発用キーの再設定が必要だった）。値は表示しない
  const kept = existsSync(".env.local.bak")
    ? readFileSync(".env.local.bak", "utf8")
        .split(/\r?\n/)
        .filter((l) => /^AGENT_[A-Z_]+=/.test(l))
    : [];
  if (kept.length) lines.splice(lines.length - 1, 0, "# 実API評価用の開発専用設定（db:env が引き継いだもの。本番のキーは入れない）", ...kept);
  writeFileSync(".env.local", lines.join("\n"));
  console.log(".env.local を開発用（ローカルDB）に書き換えました。元の内容は .env.local.bak に退避（本番の値はコミットされません）。");
  if (kept.length) console.log(`実API評価用の設定（AGENT_*）${kept.length} 件を引き継ぎました（値は表示しません）。`);
} else if (cmd === "seed") {
  loadLocalEnv();
  assertLocalTarget("db:seed");
  await import("./lib/dev-seed.mjs");
} else if (cmd === "check") {
  loadLocalEnv();
  const t = describeTarget();
  console.log(`接続先: ${t.kind}（${t.host}）`);
  assertLocalTarget("db:check");
  console.log("OK: 開発用のローカルSupabaseです。");
} else {
  console.error("使い方: node scripts/dev-db.mjs up|down|status|reset|env|seed|check");
  process.exit(1);
}
