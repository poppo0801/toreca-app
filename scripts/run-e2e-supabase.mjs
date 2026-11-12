// ローカルの開発用Supabaseに対するログインE2E。固定テストユーザー(rls-test-1)のパスワードを一時的な乱数に更新して使う。
// パスワードは画面・ログへ出さず、子プロセスの環境変数でのみ渡す。
//   E2E_SPEC=<ファイル名>            そのファイルだけ実行
//   E2E_SPEC="*.supabase.spec.ts"    （ワイルドカード）一致するファイルを1つずつ、ファイルごとに世帯を作り直して実行する（Stage 8D-1）。
//                                   ビルドと起動は1回だけ。重いデータを作るファイル（perf-*）の残りが後続に連鎖しないようにするため。
import { randomUUID } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";
import { freePort } from "./lib/port.mjs";
import { ISOLATED_AGENT_ENV } from "./lib/e2e-env.mjs";
import { assertLocalTarget } from "./lib/target.mjs";

process.loadEnvFile(".env.local");
assertLocalTarget("test:e2e:supabase"); // 開発用ローカルDBのみ（Stage 8C。npm run prod 経由でも本番では実行しない）
const admin = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});
const email = "rls-test-1@example.invalid";
const PORT = Number(process.env.E2E_PORT) || 3100;
const { cleanupTestData } = await import("./lib/test-cleanup.mjs");

/** テストユーザーを用意し、一時パスワードを返す（マスターは下準備しない。Stage 3.5 から、名称の入力だけで仮登録される動作もE2Eで確認する） */
async function prepareUser() {
  const password = randomUUID() + "Aa1!";
  const { data: list } = await admin.auth.admin.listUsers({ perPage: 200 });
  const user = list?.users.find((u) => u.email === email);
  if (user) await admin.auth.admin.updateUserById(user.id, { password });
  else {
    const { error } = await admin.auth.admin.createUser({ email, password, email_confirm: true });
    if (error) throw error;
  }
  return password;
}
const playwright = (args, extraEnv) =>
  spawnSync("npx", ["playwright", "test", ...args], { stdio: "inherit", shell: true, env: { ...process.env, ...ISOLATED_AGENT_ENV, E2E_MODE: "supabase", ...extraEnv } });

const spec = process.env.E2E_SPEC ?? "";
const isolate = spec.includes("*");
let status = 1;

if (!isolate) {
  const password = await prepareUser();
  if (!process.env.E2E_BASE_URL) freePort();
  const r = playwright(process.argv.slice(2), { E2E_EMAIL: email, E2E_PASSWORD: password });
  if (!process.env.E2E_BASE_URL) freePort();
  status = r.status ?? 1;
  // 復元訓練用: E2E_BACKUP_BEFORE_CLEANUP=1 のとき、テストデータを掃除する前にバックアップを取る
  if (process.env.E2E_BACKUP_BEFORE_CLEANUP === "1") spawnSync("node", ["scripts/backup.mjs"], { stdio: "inherit" });
  await cleanupTestData({ execute: true }); // 掃除（テスト世帯とテストユーザーのみ。docs/backup-and-ops.md）
} else {
  const re = new RegExp("^" + spec.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*") + "$");
  const files = readdirSync("e2e").filter((f) => re.test(f)).sort();
  console.log(`[e2e] ${files.length} ファイルを1つずつ実行します（ファイルごとに世帯を作り直す）`);
  freePort();
  // ビルドと起動は1回。playwright.config.ts の webServer は使わず、起動済みのサーバーへ繋ぐ（E2E_BASE_URL）
  const appEnv = { ...process.env, ...ISOLATED_AGENT_ENV, NEXT_PUBLIC_DATA_SOURCE: "supabase", AI_PROVIDER: "mock" };
  const build = spawnSync("npm", ["run", "build"], { stdio: "inherit", shell: true, env: appEnv });
  if (build.status !== 0) process.exit(build.status ?? 1);
  const server = spawn("npx", ["next", "start", "-p", String(PORT)], { stdio: "ignore", shell: true, env: appEnv });
  for (let i = 0; i < 60; i++) {
    try {
      if ((await fetch(`http://localhost:${PORT}/login`)).ok) break;
    } catch {
      /* 起動待ち */
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  const failed = [];
  for (const f of files) {
    await cleanupTestData({ execute: true }); // 前のファイルの残りを消してから始める
    const password = await prepareUser();
    const r = playwright([], { E2E_SPEC: f, E2E_BASE_URL: `http://localhost:${PORT}`, E2E_EMAIL: email, E2E_PASSWORD: password });
    if (r.status !== 0) failed.push(f);
  }
  freePort();
  server.kill();
  await cleanupTestData({ execute: true });
  console.log(failed.length ? `[e2e] 不合格のファイル: ${failed.join(", ")}` : "[e2e] すべてのファイルが合格");
  status = failed.length ? 1 : 0;
}
process.exit(status);
