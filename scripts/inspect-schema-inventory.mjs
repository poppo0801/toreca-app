import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
// Stage Release-1: スキーマの棚卸し（**読み取り専用**）。マイグレーションの適用履歴（あれば）と、テーブル・列・関数・トリガー・RLS・ポリシー・制約・インデックスの一覧（定義はmd5）を出力する。
//   node scripts/inspect-schema-inventory.mjs --container=<コンテナ名> --out=<保存先.json> --label=<名前>
//   コンテナ: 開発用DB（既定 supabase_db_tcg-dev）／本番バックアップの復元演習DB（restore-full-drill.mjs --keep が作る tcg-restore-drill）
// 本番には接続しない（本番の状態は、取得済みバックアップを使い捨てDBへ復元して調べる）。比較: node scripts/compare-schema-inventory.mjs <A.json> <B.json>
const out = process.argv.find((a) => a.startsWith("--out="))?.split("=")[1];
if (!out) throw new Error("--out=<保存先.json> が必要です");

const SQL = `select jsonb_build_object(
  'migrations', __MIG__,
  'tables', (select coalesce(jsonb_agg(c.relname order by c.relname), '[]'::jsonb) from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'public' and c.relkind in ('r', 'p')),
  'columns', (select coalesce(jsonb_agg(table_name || '.' || column_name || ':' || data_type || ':' || is_nullable || ':' || coalesce(md5(column_default), '') order by table_name, column_name), '[]'::jsonb) from information_schema.columns where table_schema = 'public'),
  'functions', (select coalesce(jsonb_agg(p.proname || '(' || pg_get_function_identity_arguments(p.oid) || '):' || md5(replace(pg_get_functiondef(p.oid), chr(13), '')) order by p.proname, pg_get_function_identity_arguments(p.oid)), '[]'::jsonb) from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.prokind in ('f', 'p')),
  'triggers', (select coalesce(jsonb_agg(c.relname || '.' || t.tgname || ':' || md5(pg_get_triggerdef(t.oid)) order by c.relname, t.tgname), '[]'::jsonb) from pg_trigger t join pg_class c on c.oid = t.tgrelid join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'public' and not t.tgisinternal),
  'policies', (select coalesce(jsonb_agg(tablename || '.' || policyname || ':' || cmd || ':' || md5(coalesce(qual, '') || '|' || coalesce(with_check, '')) order by tablename, policyname), '[]'::jsonb) from pg_policies where schemaname = 'public'),
  'rls', (select coalesce(jsonb_agg(c.relname || ':' || c.relrowsecurity order by c.relname), '[]'::jsonb) from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'public' and c.relkind = 'r'),
  'constraints', (select coalesce(jsonb_agg(c.relname || '.' || con.conname || ':' || con.contype::text || ':' || md5(replace(pg_get_constraintdef(con.oid), chr(13), '')) order by c.relname, con.conname), '[]'::jsonb) from pg_constraint con join pg_class c on c.oid = con.conrelid join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'public'),
  'indexes', (select coalesce(jsonb_agg(tablename || '.' || indexname || ':' || md5(indexdef) order by tablename, indexname), '[]'::jsonb) from pg_indexes where schemaname = 'public'),
  'views', (select coalesce(jsonb_agg(viewname || ':' || md5(definition) order by viewname), '[]'::jsonb) from pg_views where schemaname = 'public')
) as j;`;

// 問い合わせ先はローカルのDockerコンテナだけ（開発用DB、または本番バックアップを使い捨てDBへ復元したもの）。本番へは接続しない
const container = process.argv.find((a) => a.startsWith("--container="))?.split("=")[1] ?? "supabase_db_tcg-dev";
if (!/^[A-Za-z0-9_.-]+$/.test(container)) throw new Error("コンテナ名が不正です");
const run = (input) => spawnSync("docker", ["exec", "-i", container, "psql", "-U", "postgres", "-At", "-v", "ON_ERROR_STOP=1"], { input, encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });
const has = run("select to_regclass('supabase_migrations.schema_migrations') is not null;").stdout.trim() === "t";
const MIG = has ? "(select coalesce(jsonb_agg(jsonb_build_object('version', version, 'name', name) order by version), '[]'::jsonb) from supabase_migrations.schema_migrations)" : "'[]'::jsonb";
const r = run(SQL.replace("__MIG__", MIG));
if (r.status !== 0) throw new Error(`psql 失敗: ${r.stderr}`);
const json = JSON.parse(r.stdout.trim());

mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, JSON.stringify({ target: process.argv.find((a) => a.startsWith("--label="))?.split("=")[1] ?? container, at: new Date().toISOString(), ...json }, null, 1));
console.log(`棚卸し: ${out}`);
console.log(`  適用履歴 ${json.migrations.length}件（最新: ${json.migrations.at(-1)?.version ?? "なし"}）／テーブル ${json.tables.length}／関数 ${json.functions.length}／トリガー ${json.triggers.length}／ポリシー ${json.policies.length}／制約 ${json.constraints.length}／インデックス ${json.indexes.length}`);
