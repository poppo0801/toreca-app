// Phase 2: 本番相当のスキーマ（既存の移行が 118 まで適用済み）への、AI の移行（120・121）の適用・復元・巻き戻しのリハーサル。**ローカルの開発用DBのコンテナ（supabase_db_tcg-dev）だけ**に作用し、本番には接続しない。
//   前提: 最新 main の移行（〜118）だけが適用された状態のローカルDBであること（main をマージした使い捨てブランチで `npm run db:reset` → `npm run db:seed`。AIの移行 phase2_* は退避しておく）。
//   node scripts/rehearse-migration-phase2.mjs
// 手順: ①適用済み（本番相当）と未適用の差を求め、未適用が phase2_* だけ・版が適用済みの最大より後ろ（順序の逆転なし）・重複なし・依存する表が既にあることを確認
//       ②既存の全表の行ごとの指紋を記録 ③未適用の移行を、本番と同じく版の順に1本ずつ（1本ごとに1トランザクション）適用し、履歴（schema_migrations）に登録
//       ④既存の全行が変更・削除されていないこと ⑤新しい表・RLS・権限・追記専用・外部キー（候補の削除に伴う連鎖）の確認 ⑥旧アプリ相当の読み書き（新しい表を知らない既存の操作）
//       ⑦ロールバック（移行ファイル先頭の「逆戻し」SQL）を新しい表にデータがある状態で実行し、既存の全行が変わらないこと・履歴を戻せること ⑧再適用できること
import { spawnSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";

const NAME = "supabase_db_tcg-dev";
const NL = String.fromCharCode(10);
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

// このDBがローカルの開発用であることを確認（本番の接続情報は使わない。コンテナ名で固定）
check("対象はローカルの開発用DBのコンテナ", q("select current_database()") === "postgres" && NAME.startsWith("supabase_db_tcg-dev"), NAME);

const files = readdirSync("supabase/migrations").filter((f) => /^\d{14}_.+\.sql$/.test(f)).sort();
const applied = new Set(q("select version from supabase_migrations.schema_migrations").split(NL).filter(Boolean));
const pending = files.filter((f) => !applied.has(f.slice(0, 14)));
const maxApplied = [...applied].sort().at(-1);
check("未適用の移行は AI の移行（phase2_*）だけ", pending.length > 0 && pending.every((f) => /_phase2_/.test(f)), pending.map((f) => f.slice(0, 14)).join(","));
check("未適用の版は、適用済みの最大の版より後ろ（順序の逆転なし＝ --include-all 不要）", pending.every((f) => f.slice(0, 14) > maxApplied), `最大の適用済み=${maxApplied}`);
check("版の重複なし", new Set(files.map((f) => f.slice(0, 14))).size === files.length);
// 依存する表（references public.X）が、適用済みの構造か、より前の未適用の移行にある
const created = new Set(q("select table_name from information_schema.tables where table_schema='public'").split(NL));
let depOk = true;
const depDetail = [];
for (const f of pending) {
  const sql = readFileSync(`supabase/migrations/${f}`, "utf8").replace(/--.*$/gm, "");
  for (const m of sql.matchAll(/references\s+public\.(\w+)/gi)) if (!created.has(m[1])) { depOk = false; depDetail.push(`${f.slice(0, 14)}→${m[1]}`); }
  for (const m of sql.matchAll(/create\s+table\s+public\.(\w+)/gi)) created.add(m[1]);
}
check("依存する表が全て存在する（外部キーの参照先）", depOk, depDetail.join(","));

const tables = q("select table_name from information_schema.tables where table_schema='public' and table_type='BASE TABLE' order by 1").split(NL).filter(Boolean);
const cols = (t) => q(`select column_name from information_schema.columns where table_schema='public' and table_name='${t}' order by ordinal_position`).split(NL).filter(Boolean);
const preCols = Object.fromEntries(tables.map((t) => [t, cols(t)]));
const hashes = (t) => {
  const keep = preCols[t].map((c) => `'${c}'`).join(",");
  const out = q(`select md5(j::text) from (select (select jsonb_object_agg(k, v) from jsonb_each(to_jsonb(x)) e(k, v) where k in (${keep})) as j from public."${t}" x) s order by 1`);
  return out ? out.split(NL) : [];
};
const pre = Object.fromEntries(tables.map((t) => [t, hashes(t)]));
const rows = Object.values(pre).reduce((n, v) => n + v.length, 0);
check("適用前の行ごとの指紋を記録（全表）", tables.length > 100 && rows > 100, `${tables.length}表・${rows}行`);
const compare = (label) => {
  const lost = [];
  for (const t of tables) {
    const cur = hashes(t);
    const m = cur.reduce((a, h) => a.set(h, (a.get(h) ?? 0) + 1), new Map());
    let missing = 0;
    for (const h of pre[t]) if ((m.get(h) ?? 0) > 0) m.set(h, m.get(h) - 1); else missing++;
    if (missing) lost.push(`${t}:${missing}`);
  }
  check(label, lost.length === 0, lost.join(","));
};
const preProposalCols = cols("registration_proposals");

const apply = (list) => {
  for (const f of list) {
    const sql = readFileSync(`supabase/migrations/${f}`, "utf8");
    const t0 = Date.now();
    const r = run(`begin;${NL}${sql}${NL}insert into supabase_migrations.schema_migrations(version,name) values ('${f.slice(0, 14)}','${f.slice(15).replace(/\.sql$/, "")}');${NL}commit;`);
    check(`適用 ${f.slice(0, 14)}`, r.status === 0, r.status === 0 ? `${Date.now() - t0}ms` : (r.stderr || "").split(NL).filter(Boolean).slice(0, 3).join(" / "));
    if (r.status !== 0) process.exit(1);
  }
};
apply(pending);
compare("適用後も既存の全行が変更・削除されていない");
check("新しい表が揃った", q("select count(*) from information_schema.tables where table_schema='public' and table_name in ('evidence_documents','evidence_coverage_stats','evidence_image_observations','investigation_experiences')") === "4");
check("registration_proposals に item_fingerprint 列が追加された（NULL許容）", q("select is_nullable from information_schema.columns where table_name='registration_proposals' and column_name='item_fingerprint'") === "YES");
check("新しい表は全て RLS 有効", q("select count(*) from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and c.relname in ('evidence_documents','evidence_coverage_stats','evidence_image_observations','investigation_experiences') and c.relrowsecurity") === "4");
check("anon は新しい表に何もできない", q("select count(*) from information_schema.role_table_grants where grantee='anon' and table_schema='public' and table_name in ('evidence_documents','evidence_coverage_stats','evidence_image_observations','investigation_experiences')") === "0");
check("追記専用のトリガーがある（更新を拒否）", q("select count(*) from pg_trigger where tgname in ('evidence_image_observations_no_update','investigation_experiences_no_update') and not tgisinternal") === "2");

// 外部キー: 候補の削除に伴い、画像観察が連鎖して消える（候補の削除を妨げない）。テスト用の世帯・候補は後で消す
const hh = q("select id from public.households limit 1");
const cand = q(`insert into public.collection_candidates (household_id, dedupe_key, source_url, title, status, job_state, reasons) values ('${hh}', 'rehearse://p2/1', 'rehearse://p2/1', 'rehearse', 'pending', 'review', '{}') returning id`).split(NL)[0];
run(`insert into public.evidence_image_observations (household_id, candidate_id, image_url, url_key, image_index, status, readings, mode, observed_at) values ('${hh}', '${cand}', 'https://example.invalid/a.png', 'example.invalid/a.png', 1, 'analyzed', '[]'::jsonb, 'mock', now())`);
run(`insert into public.investigation_experiences (household_id, host, features, doc_chars, found_buckets, verification, source, mode, recorded_at) values ('${hh}', 'example.invalid', array['host:example.invalid'], 100, array[1,0,0,0,0,0,0,0,0,0], 'human', 'human_review', 'mock', now())`);
check("新しい表へ書ける（サービス権限）", q("select count(*) from public.evidence_image_observations") === "1" && q("select count(*) from public.investigation_experiences") === "1");
check("追記専用: 更新を拒否する", run("update public.evidence_image_observations set status='unreadable'").status !== 0 && run("update public.investigation_experiences set host='x'").status !== 0);
run(`delete from public.collection_candidates where id='${cand}'`);
check("候補を削除すると画像観察は連鎖して消える（候補の削除を妨げない）", q("select count(*) from public.evidence_image_observations") === "0");

// 旧アプリ相当: 新しい表・列を知らない既存の読み書きが動く
const okOld = run(`select count(*) from public.lotteries; select id, status from public.collection_candidates limit 1; insert into public.collection_candidates (household_id, dedupe_key, source_url, title, status, job_state, reasons) values ('${hh}', 'rehearse://p2/2', 'rehearse://p2/2', 'old-app', 'pending', 'review', '{}'); delete from public.collection_candidates where dedupe_key='rehearse://p2/2';`).status === 0;
check("旧アプリ相当の読み書き（新しい表・列を使わない）が動く", okOld);

// ロールバック（新しい表にデータがある状態で）
run(`insert into public.investigation_experiences (household_id, host, features, doc_chars, found_buckets, verification, source, mode, recorded_at) values ('${hh}', 'example.invalid', array['host:example.invalid'], 100, array[1,0,0,0,0,0,0,0,0,0], 'human', 'human_review', 'mock', now())`);
const rollback = `begin;
drop table public.investigation_experiences;
drop table public.evidence_image_observations;
drop table public.evidence_coverage_stats;
drop table public.evidence_documents;
alter table public.registration_proposals drop column item_fingerprint;
drop function public.phase2_append_only_guard();
drop function public.evidence_documents_guard();
drop function public.evidence_coverage_stats_no_update();
delete from supabase_migrations.schema_migrations where version in (${pending.map((f) => `'${f.slice(0, 14)}'`).join(",")});
commit;`;
const rb = run(rollback);
check("ロールバック（新しい表の削除・履歴を戻す）が成功する", rb.status === 0, rb.status === 0 ? "" : (rb.stderr || "").split(NL).slice(0, 3).join(" / "));
compare("ロールバック後も既存の全行が変わらない（新しい表のデータだけが失われる）");
check("ロールバック後の registration_proposals の列が適用前と同じ", JSON.stringify(cols("registration_proposals")) === JSON.stringify(preProposalCols));
check("ロールバック後の適用履歴が適用前と同じ", q("select count(*) from supabase_migrations.schema_migrations") === String(applied.size));
// 再適用
apply(pending);
compare("再適用後も既存の全行が変わらない");
check("再適用後に新しい表が揃っている", q("select count(*) from information_schema.tables where table_schema='public' and table_name in ('evidence_documents','evidence_coverage_stats','evidence_image_observations','investigation_experiences')") === "4");

console.log(results.every(Boolean) ? "\n全て合格（ローカルの本番相当スキーマでのリハーサル）。本番への適用は別承認（docs/RELEASE_FLOW.md）" : "\n不合格あり");
process.exit(results.every(Boolean) ? 0 : 1);
