import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * 本番誤接続防止の実動作テスト（Stage 8D-1）。実際のスクリプトを子プロセスで起動し、本番の URL・鍵を環境変数で注入して、
 * 「実行前に止まる」ことを確認する。本番への通信は行わない（ガードが接続前に停止する／ローカルの閉じたポートへのみ接続する）。
 */
const ROOT = resolve(__dirname, "../..");
const jwt = (payload: object) => `h.${Buffer.from(JSON.stringify(payload)).toString("base64url")}.s`;
const PROD_URL = "https://yofqgfarflrlhzufjhqs.supabase.co";
const PROD_KEY = jwt({ ref: "yofqgfarflrlhzufjhqs", role: "service_role" });
const DEMO_KEY = jwt({ iss: "supabase-demo", role: "service_role" });
const DEAD_LOCAL = "http://127.0.0.1:59999"; // 何も待ち受けていないローカルのポート

function run(script: string, env: Record<string, string>, opts: { cwd?: string; args?: string[] } = {}) {
  const r = spawnSync(process.execPath, [join(opts.cwd ? ROOT : ROOT, script), ...(opts.args ?? [])], {
    cwd: opts.cwd ?? ROOT,
    encoding: "utf8",
    timeout: 30_000,
    // 親の環境を引き継がない（実際の .env 由来の値が混ざらない）。ただし PATH 等は渡す
    env: { PATH: process.env.PATH ?? "", SystemRoot: process.env.SystemRoot ?? "", ...env } as unknown as NodeJS.ProcessEnv,
  });
  return { code: r.status, out: `${r.stdout}\n${r.stderr}` };
}
const GUARD = /接続先ガード/;

describe("本番へ誤接続しないことの実動作確認（開発用コマンド）", () => {
  const devCommands: [string, string[]][] = [
    ["scripts/dev-db.mjs", ["check"]],
    ["scripts/dev-db.mjs", ["seed"]],
    ["scripts/dev.mjs", []],
    ["scripts/run-db-tests.mjs", []],
    ["scripts/run-e2e-supabase.mjs", []],
    ["scripts/cleanup-testdata.mjs", ["--execute"]],
  ];
  describe.each([
    ["本番のURLを開発用の環境変数に設定した", { NEXT_PUBLIC_SUPABASE_URL: PROD_URL, NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: DEMO_KEY, SUPABASE_SERVICE_ROLE_KEY: DEMO_KEY }],
    ["URLはローカルだが本番の鍵が混入した", { NEXT_PUBLIC_SUPABASE_URL: "http://127.0.0.1:55321", NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: DEMO_KEY, SUPABASE_SERVICE_ROLE_KEY: PROD_KEY }],
    ["本番のURLと鍵の両方を設定した", { NEXT_PUBLIC_SUPABASE_URL: PROD_URL, NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: PROD_KEY, SUPABASE_SERVICE_ROLE_KEY: PROD_KEY }],
    ["別のホスト版Supabaseを設定した", { NEXT_PUBLIC_SUPABASE_URL: "https://abcdefghij.supabase.co", NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: DEMO_KEY, SUPABASE_SERVICE_ROLE_KEY: DEMO_KEY }],
  ])("%s", (_label, env) => {
    it.each(devCommands)("%s %j は実行前に停止する", (script, args) => {
      const r = run(script, env, { args });
      expect(r.code).not.toBe(0);
      expect(r.out).toMatch(GUARD);
    });
  });

  it("接続先が未設定でも、本番へフォールバックせず停止する（db:check）", () => {
    const empty = mkdtempSync(join(tmpdir(), "no-env-")); // .env.local の無い作業フォルダ
    try {
      const r = run("scripts/dev-db.mjs", {}, { cwd: empty, args: ["check"] });
      expect(r.code).not.toBe(0);
      expect(r.out).toMatch(GUARD);
    } finally { rmSync(empty, { recursive: true, force: true }); }
  });
});

describe("開発用DBが止まっている・接続が切れた場合", () => {
  it("ローカルの接続先に繋がらないとき、失敗して終わる（別の接続先へ切り替えない）", () => {
    const r = run("scripts/dev-db.mjs", { NEXT_PUBLIC_SUPABASE_URL: DEAD_LOCAL, NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: DEMO_KEY, SUPABASE_SERVICE_ROLE_KEY: DEMO_KEY }, { args: ["seed"] });
    expect(r.code).not.toBe(0);
    expect(r.out).not.toMatch(/supabase\.co/);
    expect(r.out).not.toMatch(/テストデータ:/); // 投入は完了していない
  });
});

describe("本番向けの入口 npm run prod（scripts/prod.mjs）", () => {
  const setup = (envText: string) => {
    const dir = mkdtempSync(join(tmpdir(), "prod-door-"));
    mkdirSync(join(dir, "scripts"));
    writeFileSync(join(dir, ".env.production-ops"), envText);
    writeFileSync(join(dir, "scripts", "stub.mjs"), 'console.log("STUB-RAN target=" + process.env.TOREMANE_TARGET);\n');
    return dir;
  };
  const prodEnv = `NEXT_PUBLIC_SUPABASE_URL=${PROD_URL}\nSUPABASE_SERVICE_ROLE_KEY=${PROD_KEY}\n`;
  it("確認フラグ（--yes-production）が無ければ実行しない", () => {
    const dir = setup(prodEnv);
    try {
      const r = run("scripts/prod.mjs", {}, { cwd: dir, args: ["scripts/stub.mjs"] });
      expect(r.code).toBe(2);
      expect(r.out).not.toMatch(/STUB-RAN/);
      expect(r.out).toMatch(/--yes-production/);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
  it("フラグがあれば、接続先を表示して実行し、子プロセスは本番の印（TOREMANE_TARGET）を持つ", () => {
    const dir = setup(prodEnv);
    try {
      const r = run("scripts/prod.mjs", {}, { cwd: dir, args: ["scripts/stub.mjs", "--yes-production"] });
      expect(r.code).toBe(0);
      expect(r.out).toMatch(/本番（yofqgfarflrlhzufjhqs\.supabase\.co）/);
      expect(r.out).toMatch(/STUB-RAN target=production/);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
  it("設定が本番でなければ（ローカルの値を入れても）停止する。スクリプト名は scripts/*.mjs のみ", () => {
    const dir = setup(`NEXT_PUBLIC_SUPABASE_URL=http://127.0.0.1:55321\nSUPABASE_SERVICE_ROLE_KEY=${DEMO_KEY}\n`);
    try {
      const r = run("scripts/prod.mjs", {}, { cwd: dir, args: ["scripts/stub.mjs", "--yes-production"] });
      expect(r.code).not.toBe(0);
      expect(r.out).toMatch(GUARD);
      expect(r.out).not.toMatch(/STUB-RAN/);
      const bad = run("scripts/prod.mjs", {}, { cwd: dir, args: ["../outside.mjs", "--yes-production"] });
      expect(bad.code).toBe(1);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
  it("本番の入口を通しても、DB結合テスト・Supabase E2E は本番では実行されない", () => {
    const dir = setup(prodEnv);
    try {
      // 実スクリプトを直接、本番の環境変数つきで起動（prod.mjs 経由と同じ状態）
      for (const s of ["scripts/run-db-tests.mjs", "scripts/run-e2e-supabase.mjs"]) {
        const r = run(s, { NEXT_PUBLIC_SUPABASE_URL: PROD_URL, SUPABASE_SERVICE_ROLE_KEY: PROD_KEY, TOREMANE_TARGET: "production" });
        expect(r.code).not.toBe(0);
        expect(r.out).toMatch(GUARD);
      }
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});

describe("バックアップ・本番検証は、本番でない設定では実行しない", () => {
  it.each(["scripts/full-backup.mjs", "scripts/local-backup.mjs", "scripts/backup.mjs", "scripts/verify-production.mjs"])("%s はローカルDBの設定では停止する", (script) => {
    const r = run(script, { NEXT_PUBLIC_SUPABASE_URL: "http://127.0.0.1:55321", SUPABASE_SERVICE_ROLE_KEY: DEMO_KEY, BACKUP_PASSPHRASE: "x".repeat(20) }, { args: script.includes("local-backup") ? ["--status"] : [] });
    expect(r.code).not.toBe(0);
    expect(r.out).toMatch(GUARD);
  });
});
