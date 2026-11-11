// Stage 8A: 完全バックアップ（full-backup.mjs の .tcgbak2）から、使い捨てのローカルPostgres(Docker)へ復元して検証する。
// 本番(Supabase)には一切接続しない。専用コンテナ名 tcg-restore-drill のみを使い、他のコンテナには触れない。
//
//   node scripts/restore-full-drill.mjs --file <tcg-full-….tcgbak2> [--keep]
//   BACKUP_PASSPHRASE が必要。復号した平文は一時フォルダにのみ置き、終了時に削除する。
//
// 検証内容: ①復号・全ファイルのSHA-256 ②スキーマ+全テーブル+認証ユーザー+Storageメタデータの復元 ③全テーブルの行数がダンプ時と一致
//           ④テーブル/RLS有効/ポリシー/関数/トリガー/インデックス/制約の数が本番と一致 ⑤全外部キーに孤児行がない
//           ⑥Storage の objects と実ファイルの対応 ⑦RLS（所有者は読める・他人/匿名は読めない）
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import JSZip from "jszip";
import { decryptBuffer } from "./lib/backup-crypto.mjs";
import { extractCopySql } from "./lib/pg-copy.mjs";

try {
  process.loadEnvFile(".env.local");
} catch {
  /* 環境変数が設定済みの場合 */
}
const args = process.argv.slice(2);
const opt = (n) => (args.includes(`--${n}`) ? args[args.indexOf(`--${n}`) + 1] : undefined);
const file = opt("file");
if (!file || !process.env.BACKUP_PASSPHRASE) {
  console.error("使い方: node scripts/restore-full-drill.mjs --file <.tcgbak2>（BACKUP_PASSPHRASE が必要）");
  process.exit(2);
}
const NAME = "tcg-restore-drill";
const IMAGE = process.env.DRILL_IMAGE ?? "public.ecr.aws/supabase/postgres:17.11.0.006";
const sha = (b) => createHash("sha256").update(b).digest("hex");
const sh = (cmd, a, input) => spawnSync(cmd, a, { encoding: "utf8", input, maxBuffer: 1024 * 1024 * 512 });
const psql = (extra, input) => sh("docker", ["exec", "-i", NAME, "psql", "-U", "supabase_admin", "-d", "postgres", "-v", "ON_ERROR_STOP=1", "-q", ...extra], input);
const query = (sql) => {
  const r = psql(["-At"], sql);
  if (r.status !== 0) throw new Error((r.stderr || r.stdout).slice(0, 500));
  return JSON.parse(r.stdout.trim().split("\n").pop());
};

if (sh("docker", ["ps", "-a", "--filter", `name=^${NAME}$`, "--format", "{{.Names}}"]).stdout.trim()) {
  console.error(`コンテナ ${NAME} が既に存在します。docker rm -f ${NAME} で削除してから再実行してください（他のコンテナには触れません）。`);
  process.exit(1);
}

const work = mkdtempSync(join(tmpdir(), "tcg-drill-"));
const results = [];
const check = (name, ok, detail) => {
  results.push({ 項目: name, 結果: ok ? "OK" : "NG", 詳細: detail });
  console.log(`${ok ? "OK" : "NG"}  ${name}${detail ? ` — ${detail}` : ""}`);
  return ok;
};
let allOk = false;
try {
  // ---- ① 復号・展開・SHA-256
  const zip = await JSZip.loadAsync(decryptBuffer(readFileSync(file), process.env.BACKUP_PASSPHRASE));
  const manifest = JSON.parse(await zip.file("manifest.json").async("string"));
  let bad = 0;
  const content = {};
  for (const [p, h] of Object.entries(manifest.fileSha256)) {
    const buf = await zip.file(p).async("nodebuffer");
    if (sha(buf) !== h) bad++;
    if (p.startsWith("db/")) {
      mkdirSync(join(work, "db"), { recursive: true });
      writeFileSync(join(work, p), buf);
    } else if (p.startsWith("storage/")) content[p] = buf.length;
  }
  check("復号と全ファイルのSHA-256", bad === 0, `${Object.keys(manifest.fileSha256).length}ファイル・不一致${bad}件`);
  if (bad > 0) throw new Error("ファイルが壊れています");
  console.log(`   バックアップ: ${manifest.createdAt} / Git ${manifest.git.commit.slice(0, 7)} / project ${manifest.project}`);

  // ---- ② 復元
  console.log(`使い捨てPostgresを起動（${IMAGE}）…`);
  const run = sh("docker", ["run", "-d", "--name", NAME, "-e", "POSTGRES_PASSWORD=drill", IMAGE]);
  if (run.status !== 0) throw new Error(run.stderr.slice(0, 400));
  for (let i = 0; ; i++) {
    if (sh("docker", ["exec", NAME, "pg_isready", "-U", "postgres"]).status === 0) break;
    if (i > 60) throw new Error("Postgresが起動しませんでした");
    await new Promise((r) => setTimeout(r, 2000));
  }
  await new Promise((r) => setTimeout(r, 6000)); // 初期化スクリプトの完了待ち
  const load = (name) => {
    const cp = sh("docker", ["cp", join(work, "db", name), `${NAME}:/tmp/${name}`]);
    if (cp.status !== 0) throw new Error(cp.stderr.slice(0, 300));
    const r = psql(["-f", `/tmp/${name}`]);
    if (r.status !== 0) throw new Error(`${name}: ${(r.stderr || r.stdout).slice(0, 600)}`);
  };
  // ホスト版 Supabase では auth / storage の定義は各サービスが作る。ベアのPostgresでは無いため、バックアップ内の定義で代替する（使い捨てコンテナなので作り直してよい）
  const drop = psql([], "drop schema if exists auth cascade; drop schema if exists storage cascade;");
  if (drop.status !== 0) throw new Error(drop.stderr.slice(0, 300));
  // storage.objects のポリシーは public の関数を参照するため、public の作成前は失敗する（想定内）。public を作ったあとに、そのポリシーだけ再適用する
  const asSql = readFileSync(join(work, "db", "schema-auth-storage.sql"), "utf8");
  const storagePolicies = asSql.match(/CREATE POLICY [^;]*? ON "storage"\."objects"[^;]*;/gs) ?? [];
  {
    const cp = sh("docker", ["cp", join(work, "db", "schema-auth-storage.sql"), `${NAME}:/tmp/as.sql`]);
    if (cp.status !== 0) throw new Error(cp.stderr.slice(0, 300));
    const r = sh("docker", ["exec", "-i", NAME, "psql", "-U", "supabase_admin", "-d", "postgres", "-q", "-f", "/tmp/as.sql"]);
    const errs = (r.stderr || "").split("\n").filter((l) => /ERROR:/.test(l));
    const unexpected = errs.filter((l) => !/is_household_member|public\./.test(l));
    check("auth / storage の定義の適用（ホストでは Supabase が作る部分の代替）", unexpected.length === 0, unexpected.length ? unexpected[0].slice(0, 200) : `storage のポリシー${storagePolicies.length}件は public 作成後に再適用`);
    if (unexpected.length > 0) throw new Error("auth / storage の定義の適用に失敗しました");
  }
  load("schema.sql");
  {
    const r = psql([], storagePolicies.join("\n"));
    if (r.status !== 0) throw new Error(`storage のポリシーの再適用に失敗: ${(r.stderr || "").slice(0, 300)}`);
    const n = query("select jsonb_build_object('n', count(*)) from pg_policies where schemaname = 'storage' and tablename = 'objects';").n;
    check("storage.objects のRLSポリシーの復元", Number(n) === storagePolicies.length && storagePolicies.length > 0, `${n}/${storagePolicies.length}件`);
  }
  check("スキーマの復元（schema.sql）", true, "");
  load("data-public.sql");
  check("全テーブルのデータの復元（data-public.sql）", true, "");
  // 認証・Storage は、復元先の Supabase が作るスキーマ（バージョン差あり）に合わせ、必要なテーブルだけを戻す
  writeFileSync(join(work, "db", "auth-users.sql"), extractCopySql(readFileSync(join(work, "db", "data-auth.sql"), "utf8"), ["auth.users", "auth.identities"]));
  load("auth-users.sql");
  check("認証ユーザーの復元（auth.users / auth.identities）", true, "");
  writeFileSync(join(work, "db", "storage-meta.sql"), extractCopySql(readFileSync(join(work, "db", "data-storage.sql"), "utf8"), ["storage.buckets", "storage.objects"]));
  load("storage-meta.sql");
  check("Storage メタデータの復元（buckets / objects）", true, "");

  // ---- ③ 行数
  const live = manifest.counts.dump;
  const restored = query(
    `select jsonb_object_agg(table_name, n) from (select table_name, (xpath('/row/c/text()', query_to_xml(format('select count(*) as c from public.%I', table_name), false, true, '')))[1]::text::bigint n
       from information_schema.tables where table_schema='public' and table_type='BASE TABLE') t;`,
  );
  const diff = Object.keys(live).filter((t) => Number(restored[t]) !== live[t]);
  const total = Object.values(restored).reduce((a, n) => a + Number(n), 0);
  check("全テーブルの行数がダンプ時と一致", diff.length === 0 && Object.keys(restored).length === Object.keys(live).length, `${Object.keys(restored).length}テーブル・${total}行${diff.length ? `・不一致: ${diff.join(",")}` : ""}`);

  // ---- ④ 構造
  const inv = manifest.inventory.public_objects;
  const got = query(
    `select jsonb_build_object(
       'tables', (select count(*) from information_schema.tables where table_schema='public' and table_type='BASE TABLE'),
       'rls_enabled', (select count(*) from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and c.relkind='r' and c.relrowsecurity),
       'policies', (select count(*) from pg_policies where schemaname='public'),
       'functions', (select count(*) from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public'),
       'triggers', (select count(*) from pg_trigger t join pg_class c on c.oid=t.tgrelid join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and not t.tgisinternal),
       'indexes', (select count(*) from pg_indexes where schemaname='public'),
       'constraints', (select count(*) from pg_constraint c join pg_namespace n on n.oid=c.connamespace where n.nspname='public'));`,
  );
  const sdiff = Object.keys(inv).filter((k) => Number(got[k]) !== Number(inv[k]));
  check("構造（テーブル・RLS有効・ポリシー・関数・トリガー・インデックス・制約）が本番と一致", sdiff.length === 0, Object.keys(inv).map((k) => `${k}=${got[k]}`).join(" ") + (sdiff.length ? `・不一致: ${sdiff.map((k) => `${k}(本番${inv[k]}/復元${got[k]})`).join(",")}` : ""));

  // ---- ⑤ 外部キー
  const fk = query(
    `select jsonb_build_object('fks', count(*), 'orphans', coalesce(sum(o),0), 'bad', coalesce(jsonb_agg(conname) filter (where o > 0), '[]'::jsonb)) from (
       select c.conname, (xpath('/row/c/text()', query_to_xml(format(
         'select count(*) as c from %s ch where %s and not exists (select 1 from %s p where %s)', c.conrelid::regclass,
         (select string_agg(format('ch.%I is not null', a.attname), ' and ') from unnest(c.conkey) k join pg_attribute a on a.attrelid = c.conrelid and a.attnum = k),
         c.confrelid::regclass,
         (select string_agg(format('p.%I = ch.%I', pa.attname, ca.attname), ' and ') from unnest(c.conkey, c.confkey) u(ck, pk) join pg_attribute ca on ca.attrelid = c.conrelid and ca.attnum = u.ck join pg_attribute pa on pa.attrelid = c.confrelid and pa.attnum = u.pk)
       ), false, true, '')))[1]::text::bigint o
       from pg_constraint c join pg_namespace n on n.oid = c.connamespace where c.contype = 'f' and n.nspname = 'public') s;`,
  );
  check("全外部キーに孤児行がない", Number(fk.orphans) === 0, `外部キー${fk.fks}件・孤児${fk.orphans}行${fk.bad.length ? `（${fk.bad.join(",")}）` : ""}`);

  // ---- ⑥ Storage
  const objs = query(`select jsonb_build_object('rows', jsonb_agg(jsonb_build_object('b', bucket_id, 'n', name))) from storage.objects;`).rows;
  const missingFiles = objs.filter((o) => !(`storage/${o.b}/${o.n}` in content));
  const buckets = query(`select jsonb_agg(id order by id) from storage.buckets;`);
  const wantBuckets = manifest.inventory.buckets.map((b) => b.id).sort();
  check("Storage: バケット設定と、objects の全行に対応する実ファイルがある", missingFiles.length === 0 && objs.length === manifest.storage.count && JSON.stringify(buckets) === JSON.stringify(wantBuckets), `バケット${buckets.length}・objects ${objs.length}行・実ファイル${Object.keys(content).length}件・欠落${missingFiles.length}`);

  // ---- ⑦ RLS（所有者の世帯の抽選が見え、他人・匿名には見えない）
  const hh = query(`select jsonb_build_object('hid', h.id, 'owner', h.owner_auth_user_id, 'n', (select count(*) from public.lotteries l where l.household_id = h.id), 'apps', (select count(*) from public.applications a where a.household_id = h.id)) from public.households h order by (select count(*) from public.lotteries l where l.household_id = h.id) desc limit 1;`);
  const as = (role, sub, q) => {
    const claim = sub ? `select set_config('request.jwt.claims', json_build_object('sub','${sub}','role','${role}')::text, true), set_config('request.jwt.claim.sub','${sub}', true);` : "";
    const r = psql(["-At"], `begin; set local role ${role}; ${claim} select count(*) from (${q}) x; rollback;`);
    return r.status === 0 ? Number(r.stdout.trim().split("\n").filter(Boolean).pop()) : "denied";
  };
  const qL = `select 1 from public.lotteries where household_id = '${hh.hid}'`;
  const qA = `select 1 from public.applications where household_id = '${hh.hid}'`;
  const owner = [as("authenticated", hh.owner, qL), as("authenticated", hh.owner, qA)];
  const stranger = [as("authenticated", "00000000-0000-4000-8000-000000000001", qL), as("authenticated", "00000000-0000-4000-8000-000000000001", qA)];
  const anon = as("anon", null, qL);
  check("RLS: 所有者は抽選・応募記録が読める／他人・匿名は読めない", owner[0] === Number(hh.n) && owner[1] === Number(hh.apps) && stranger[0] === 0 && stranger[1] === 0 && (anon === 0 || anon === "denied"), `所有者 抽選${owner[0]}/${hh.n}・応募${owner[1]}/${hh.apps}／他人 ${stranger.join("/")}／匿名 ${anon}`);

  allOk = results.every((r) => r.結果 === "OK");
  console.log(allOk ? "\n復元検証: すべて合格" : "\n復元検証: 不合格あり");
} catch (e) {
  console.error("\n復元検証: 失敗 —", e instanceof Error ? e.message : e);
} finally {
  rmSync(work, { recursive: true, force: true });
  if (!args.includes("--keep")) sh("docker", ["rm", "-f", NAME]);
  else console.log(`コンテナ ${NAME} を残しました（docker rm -f ${NAME} で削除）。`);
}
process.exit(allOk ? 0 : 1);
