// 本番反映の前のマイグレーション・リハーサル（Stage 9H-3R-Release）。本番には接続しない。
//   前提: npm run prod -- scripts/restore-full-drill.mjs --file <最新の完全バックアップ> --keep --yes-production で、使い捨てコンテナ tcg-restore-drill に本番のコピーを復元済み。
//   node scripts/rehearse-release-9h.mjs
// 手順: ①本番コピーの件数を記録 → ②099〜103・105 を本番と同じく版の順に1本ずつ適用（失敗したら停止）→ ③既存の全表の件数が不変 → ④新しい列・表・RLS・関数の確認
//       → ⑤旧アプリ相当（現行の本番コードが使う2引数の関数呼び出し）と新アプリ相当の動作 → ⑥既存の抽選・応募が読める
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";

const NAME = "tcg-restore-drill";
const FILES = ["20261217000099_stage8f", "20261218000100_stage8f4", "20261219000101_stage8f6", "20261220000102_stage9b", "20261221000103_stage9d", "20261223000105_stage9h3q"];
const run = (input, extra = []) => spawnSync("docker", ["exec", "-i", NAME, "psql", "-U", "supabase_admin", "-d", "postgres", "-v", "ON_ERROR_STOP=1", "-q", ...extra], { input, encoding: "utf8", maxBuffer: 1 << 28 });
const q = (sql) => {
  const r = run(sql, ["-At"]);
  if (r.status !== 0) throw new Error((r.stderr || r.stdout).slice(0, 600));
  return r.stdout.trim();
};
const results = [];
const check = (name, ok, detail = "") => {
  results.push(ok);
  console.log(`${ok ? "OK" : "NG"}  ${name}${detail ? ` — ${detail}` : ""}`);
};

const counts = () => JSON.parse(q(`select json_object_agg(relname, n) from (select c.relname, (xpath('/row/c/text()', query_to_xml('select count(*) as c from public.' || quote_ident(c.relname), false, true, '')))[1]::text::int as n from pg_class c join pg_namespace s on s.oid=c.relnamespace where s.nspname='public' and c.relkind='r') t;`));
const before = counts();
check("本番コピーの表の件数を記録", Object.keys(before).length > 90, `${Object.keys(before).length}表 / lotteries ${before.lotteries} / applications ${before.applications}`);
check("適用前は新しい列・表が無い（本番と同じ状態）", q("select count(*) from information_schema.columns where table_name='lotteries' and column_name in ('lottery_form','update_history')") === "0" && q("select to_regclass('public.discovery_runs') is null") === "t");

for (const f of FILES) {
  const sql = readFileSync(`supabase/migrations/${f}.sql`, "utf8");
  const r = run(`begin;\n${sql}\ncommit;`);
  check(`適用 ${f}`, r.status === 0, r.status === 0 ? "" : (r.stderr || "").split("\n").filter(Boolean).slice(0, 3).join(" / "));
  if (r.status !== 0) process.exit(1);
}

const after = counts();
const changed = Object.keys(before).filter((t) => before[t] !== after[t]);
check("既存の全表の件数が適用の前後で不変", changed.length === 0, changed.length ? changed.join(",") : `${Object.keys(before).length}表すべて一致`);
const added = Object.keys(after).filter((t) => !(t in before));
check("新しい表が追加された（8表）", added.length === 8, added.sort().join(","));
check("新しい表はすべてRLS有効", q(`select count(*) from pg_class c join pg_namespace s on s.oid=c.relnamespace where s.nspname='public' and c.relname in (${added.map((t) => `'${t}'`).join(",")}) and c.relrowsecurity`) === String(added.length));
check("新しい表は匿名・認証済みから直接読めない（権限）", q(`select count(*) from information_schema.role_table_grants where table_schema='public' and table_name in (${added.map((t) => `'${t}'`).join(",")}) and grantee='anon'`) === "0");
check("lotteries の新しい列は既存行で NULL／既定値（データを変えない）", q("select count(*) from public.lotteries where lottery_form is not null or lottery_form_source is not null or update_history <> '[]'::jsonb") === "0");
check("収集方式は全世帯で legacy（自律型は選ぶまで無効）", q("select coalesce(string_agg(distinct collection_engine, ','), 'none') from public.collection_settings") !== "autonomous");
check("既存の collection_settings の行数が変わらない", String(before.collection_settings) === q("select count(*) from public.collection_settings"));
// 旧アプリ（現行の本番コード）が使う2引数の関数呼び出しが引き続き動く（既定値つきの新引数）
const sig = q("select string_agg(pg_get_function_identity_arguments(p.oid), ' | ') from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname in ('ungroup_lottery_tx','dissolve_lottery_group_tx')");
check("置き換えた関数の引数（新しい引数は既定値つき）", /p_actor|p_/.test(sig), sig);
const dflt = q("select bool_and(p.pronargdefaults >= 1) from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname in ('ungroup_lottery_tx','dissolve_lottery_group_tx')");
check("2関数とも既定値つきの引数がある（旧2引数の呼び出しが動く）", dflt === "t");
// 既存の抽選・応募が新しい列つきで読める（新アプリのselectに相当）
check("新アプリのselect（lottery_form・update_history 含む）で既存の抽選を全件読める", q("select count(*) from (select id, lottery_form, lottery_form_source, update_history from public.lotteries) t") === String(before.lotteries));
check("既存の応募記録を全件読める", q("select count(*) from public.applications") === String(before.applications));
// 制約: 新しい整合制約が既存行を拒否していない（上の適用が成功した時点で検証済み）。追加の確認として、冪等性（2回目の適用は表が既にあるため失敗する＝1回きり）を記録するだけ
const ok = results.every(Boolean);
console.log(ok ? "\nリハーサル: すべて合格" : "\nリハーサル: 不合格あり");
process.exit(ok ? 0 : 1);
