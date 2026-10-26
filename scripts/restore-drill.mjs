// 復元訓練: 最新のバックアップ(JSON)を、使い捨てのローカルPostgres(Docker)へ復元して整合を検証する。
// 本番(Supabase)には一切接続・変更しない。家計簿などの既存コンテナにも触れない（専用コンテナ名・専用ポート）。
//
//   npm run restore:drill                         # backups/ の最新で実行
//   npm run restore:drill -- --backup backups/<日時> [--keep]
//
// 検証内容: マイグレーション適用 → 復元 → 件数/ID/外部キー整合 → RLS（所有者は読める・他者/匿名は読めない）
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { execSql, queryJson, readBackup } from "./lib/sql-exec.mjs";

const args = process.argv.slice(2);
const opt = (n) => {
  const i = args.indexOf(`--${n}`);
  return i >= 0 ? args[i + 1] : undefined;
};
const NAME = "tcg-restore-drill";
const PORT = "55432";
const IMAGE = process.env.DRILL_IMAGE ?? "public.ecr.aws/supabase/postgres:17.11.0.006";

const sh = (cmd, a, input) => spawnSync(cmd, a, { encoding: "utf8", input });

const backupDir = opt("backup") ?? (() => {
  const dirs = existsSync("backups") ? readdirSync("backups").filter((d) => existsSync(join("backups", d, "_manifest.json"))).sort() : [];
  if (dirs.length === 0) throw new Error("backups/ にバックアップがありません。先に npm run backup を実行してください。");
  return join("backups", dirs[dirs.length - 1]);
})();

if (sh("docker", ["ps", "-a", "--filter", `name=^${NAME}$`, "--format", "{{.Names}}"]).stdout.trim()) {
  console.error(`コンテナ ${NAME} が既に存在します。docker rm -f ${NAME} で削除してから再実行してください（他のコンテナには触れません）。`);
  process.exit(1);
}

const target = `docker:${NAME}`;
let ok = false;
try {
  console.log(`使い捨てPostgresを起動（${IMAGE}、127.0.0.1:${PORT}）…`);
  const run = sh("docker", ["run", "-d", "--name", NAME, "-e", "POSTGRES_PASSWORD=drill", "-p", `127.0.0.1:${PORT}:5432`, IMAGE]);
  if (run.status !== 0) throw new Error(run.stderr.slice(0, 400));
  for (let i = 0; i < 60; i++) {
    const r = sh("docker", ["exec", NAME, "pg_isready", "-U", "postgres"]);
    if (r.status === 0) break;
    if (i === 59) throw new Error("Postgresが起動しませんでした");
    await new Promise((r2) => setTimeout(r2, 2000));
  }
  await new Promise((r) => setTimeout(r, 4000)); // 初期化スクリプトの完了待ち

  // auth スキーマの最小スタブ（本物のSupabaseでは GoTrue が作る）
  execSql(
    target,
    `create schema if not exists auth;
     create table if not exists auth.users (id uuid primary key default gen_random_uuid(), email text unique);
     create or replace function auth.uid() returns uuid language sql stable as $f$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $f$;
     grant usage on schema auth to anon, authenticated, service_role;
     grant select on auth.users to service_role;`,
  );

  const dir = "supabase/migrations";
  const files = readdirSync(dir).filter((f) => /^\d+_.+\.sql$/.test(f)).sort();
  for (const f of files) {
    const sql = readFileSync(join(dir, f), "utf8");
    try {
      execSql(target, sql);
      console.log(`  migration OK: ${f}`);
    } catch (e) {
      // pg_cron / pg_net / Vault などホスト専用の機能が検証用Postgresに無い場合は、その移行だけ最小スタブで代替
      if (/pg_cron|pg_net|vault|cron\./i.test(String(e.message)) || /notification_cron/.test(f)) {
        execSql(
          target,
          `create schema if not exists cron; create table if not exists cron.job (jobname text, active boolean default true);
           create schema if not exists net; create schema if not exists vault; create table if not exists vault.decrypted_secrets (name text, decrypted_secret text);`,
        );
        try {
          execSql(target, sql.replace(/create extension[^;]*;/gi, ""));
          console.log(`  migration OK（拡張機能をスタブで代替）: ${f}`);
        } catch (e2) {
          throw new Error(`${f}: ${String(e2.message).slice(0, 300)}`);
        }
      } else throw new Error(`${f}: ${String(e.message).slice(0, 300)}`);
    }
  }

  // 復元先の共通ログイン（本番のオーナーIDとは別のIDで作成され、所有者の付け替えを検証する）
  const { tables } = readBackup(backupDir);
  const households = tables.households;
  if (households.length === 0) throw new Error("バックアップに世帯がありません");
  const lotteriesBy = (hid) => tables.lotteries.filter((l) => l.household_id === hid).length;
  const main = [...households].sort((a, b) => lotteriesBy(b.id) - lotteriesBy(a.id))[0];
  const email = "drill-owner@example.invalid";
  const newOwner = randomUUID();
  execSql(target, `insert into auth.users (id, email) values ('${newOwner}', '${email}');`);

  const r = spawnSync("node", ["scripts/restore.mjs", "--backup", backupDir, "--target", target, "--map-owner", `${main.owner_auth_user_id}=${email}`], { stdio: "inherit" });
  if (r.status !== 0) throw new Error("復元または検証に失敗しました");

  // ---- RLS: 復元後の世帯データは所有者だけが読める
  const hid = main.id;
  const expectedLotteries = lotteriesBy(hid);
  const rls = queryJson(
    target,
    `select jsonb_build_object(
       'owner_profiles', (select count(*) from (select set_config('request.jwt.claim.sub', '${newOwner}', true)) s, lateral (select 1 from public.profiles where household_id = '${hid}') p),
       'x', 1) as res;`,
  );
  void rls;
  const asRole = (role, sub, q) =>
    queryJson(target, `begin; set local role ${role}; select set_config('request.jwt.claim.sub', '${sub}', true); select jsonb_build_object('n', (${q})) as res; rollback;`);
  const q = `select count(*) from public.lotteries where household_id = '${hid}'`;
  const owner = (() => {
    try {
      return asRole("authenticated", newOwner, q).n;
    } catch (e) {
      return `error: ${String(e.message).slice(0, 120)}`;
    }
  })();
  const stranger = (() => {
    try {
      return asRole("authenticated", randomUUID(), q).n;
    } catch (e) {
      return `error: ${String(e.message).slice(0, 120)}`;
    }
  })();
  const anon = (() => {
    try {
      return asRole("anon", randomUUID(), q).n;
    } catch {
      return "denied";
    }
  })();
  console.log(`RLS確認: 所有者が見える抽選=${owner}（期待 ${expectedLotteries}）／他人=${stranger}（期待 0）／匿名=${anon}（期待 denied）`);
  if (Number(owner) !== expectedLotteries || Number(stranger) !== 0 || anon !== "denied") throw new Error("RLSの確認に失敗しました");
  const ownerRow = queryJson(target, `select jsonb_build_object('o', owner_auth_user_id::text) as res from public.households where id = '${hid}';`);
  if (ownerRow.o !== newOwner) throw new Error("所有者の付け替えに失敗しました");
  console.log("所有者の付け替え: OK");

  ok = true;
  console.log("\n復元訓練: すべて成功しました。");
} catch (e) {
  console.error("\n復元訓練: 失敗 —", e instanceof Error ? e.message : e);
} finally {
  if (!args.includes("--keep")) sh("docker", ["rm", "-f", NAME]);
  else console.log(`コンテナ ${NAME} を残しました（docker rm -f ${NAME} で削除）。`);
}
process.exit(ok ? 0 : 1);
