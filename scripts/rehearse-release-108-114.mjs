// 本番反映（108〜114）の前の、**本番の完全バックアップの復元コピー**への適用リハーサル。本番には接続しない（使い捨てコンテナ tcg-restore-drill だけ）。
//   前提: npm run prod -- scripts/restore-full-drill.mjs --file <最新の完全バックアップ> --keep --yes-production で、本番のコピーを復元済みであること。
//   node scripts/rehearse-release-108-114.mjs
// 手順: ①本番コピーの適用履歴が107までであることを確認 ②全表の行ごとの指紋（移行前の列のみ）を記録 ③108〜114 を本番と同じく版の順に1本ずつ（1本ごとに1トランザクションで）適用
//       ④既存の全行が変更・削除されていないこと ⑤新しい列・表・RLS・権限・関数の確認 ⑥旧アプリ相当の読み書き（実データ）⑦ purge 関数が実データの世帯を消さないこと
import { spawnSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";

const NAME = "tcg-restore-drill";
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
const NL = String.fromCharCode(10);

// 完全バックアップは public・auth・storage のみ（適用履歴の表 supabase_migrations は含まない）。本番の履歴が107までであることは plan（本番の読み取り）で確認済み。コピーでは構造から確認する
check("本番コピーは107の適用後の構造（制約が緩和版）で、108以降の構造が無い", q("select pg_get_constraintdef(oid) from pg_constraint where conname='lotteries_result_end_range'").includes("result_date IS NULL") && q("select count(*) from information_schema.columns where table_name='lotteries' and column_name='case_id'") === "0");
check("適用前は 108 以降の表が無い", q("select count(*) from information_schema.tables where table_schema='public' and (table_name in ('cases','case_judgments','registration_proposals') or table_name like 'shadow_%')") === "0");

const tables = q("select table_name from information_schema.tables where table_schema='public' and table_type='BASE TABLE' order by 1").split(NL).filter(Boolean);
const colsOf = (t) => q(`select column_name from information_schema.columns where table_schema='public' and table_name='${t}' order by ordinal_position`).split(NL).filter(Boolean);
const preCols = Object.fromEntries(tables.map((t) => [t, colsOf(t)]));
const hashes = (t) => {
  const keep = preCols[t].map((c) => `'${c}'`).join(",");
  const out = q(`select md5(j::text) from (select (select jsonb_object_agg(k, v) from jsonb_each(to_jsonb(x)) e(k, v) where k in (${keep})) as j from public."${t}" x) s order by 1`);
  return out ? out.split(NL) : [];
};
const pre = Object.fromEntries(tables.map((t) => [t, hashes(t)]));
const rows = Object.values(pre).reduce((n, v) => n + v.length, 0);
check("適用前の行ごとの指紋を記録（全表）", tables.length > 100 && rows > 20000, `${tables.length}表・${rows}行`);
const lotteries0 = q("select count(*) from public.lotteries");
const households0 = q("select count(*) from public.households");

const files = readdirSync("supabase/migrations").filter((f) => /^\d{14}_.+\.sql$/.test(f) && f.slice(0, 14) > "20261225000107").sort();
check("適用する移行は 108〜114 の7本", files.length === 7 && files[0].startsWith("20261226000108") && files.at(-1).startsWith("20261228000114"), files.map((f) => f.slice(11, 14)).join(","));
for (const f of files) {
  const sql = readFileSync(`supabase/migrations/${f}`, "utf8");
  const t0 = Date.now();
  const r = run(`begin;${NL}${sql}${NL}commit;`);
  check(`適用 ${f.slice(0, 14)}`, r.status === 0, r.status === 0 ? `${Date.now() - t0}ms` : (r.stderr || "").split(NL).filter(Boolean).slice(0, 3).join(" / "));
  if (r.status !== 0) process.exit(1);
}

check("114 までの構造が揃った（登録案・案件・シャドーの表）", q("select count(*) from information_schema.tables where table_schema='public' and table_name in ('registration_proposals','registration_proposal_reviews','cases','shadow_opportunities')") === "4");
const post = Object.fromEntries(tables.map((t) => [t, hashes(t)]));
const multiset = (a) => a.reduce((m, h) => m.set(h, (m.get(h) ?? 0) + 1), new Map());
const lost = [];
const added = {};
for (const t of tables) {
  const p = multiset(post[t]);
  let missing = 0;
  for (const [h, n] of multiset(pre[t])) if ((p.get(h) ?? 0) < n) missing += n - (p.get(h) ?? 0);
  if (missing) lost.push(`${t}:${missing}`);
  if (post[t].length !== pre[t].length) added[t] = post[t].length - pre[t].length;
}
check("既存の行が変更・削除されていない（実データ・全表・行ごとの指紋）", lost.length === 0, lost.length ? lost.join(",") : `${tables.length}表・${rows}行`);
check("既存表の行数が増減していない", Object.keys(added).length === 0, JSON.stringify(added));
const addedCols = Object.fromEntries(tables.map((t) => [t, colsOf(t).filter((c) => !preCols[t].includes(c))]).filter(([, c]) => c.length));
console.log("既存表へ追加された列:", JSON.stringify(addedCols));
check("既存表へ追加された列は case_id ×2・judgment_engine だけ", JSON.stringify(Object.keys(addedCols).sort()) === JSON.stringify(["collection_candidates", "collection_settings", "lotteries"]) && addedCols.lotteries.join() === "case_id" && addedCols.collection_candidates.join() === "case_id" && addedCols.collection_settings.join() === "judgment_engine");
check("既存行の case_id はすべて NULL・judgment_engine はすべて legacy", q("select (select count(*) from public.lotteries where case_id is not null) + (select count(*) from public.collection_candidates where case_id is not null) + (select count(*) from public.collection_settings where judgment_engine <> 'legacy')") === "0");
const newT = q("select string_agg(table_name, ',' order by table_name) from information_schema.tables where table_schema='public' and (table_name in ('cases','case_judgments') or table_name like 'shadow_%' or table_name like 'registration_proposal%')");
check("新しい表が作られた", /cases/.test(newT) && /shadow_jobs/.test(newT) && /registration_proposals/.test(newT), newT);
check("新しい表すべてで RLS 有効", q("select count(*) from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and c.relkind='r' and (c.relname in ('cases','case_judgments') or c.relname like 'shadow_%' or c.relname like 'registration_proposal%') and not c.relrowsecurity") === "0");
check("anon に新しい表の権限がない", q("select count(*) from information_schema.role_table_grants where grantee='anon' and table_schema='public' and (table_name in ('cases','case_judgments') or table_name like 'shadow_%' or table_name like 'registration_proposal%')") === "0");
check("新しい表が空（シャドー・登録案・案件は未使用）", q("select (select count(*) from public.cases)+(select count(*) from public.case_judgments)+(select count(*) from public.shadow_jobs)+(select count(*) from public.shadow_judgments)+(select count(*) from public.shadow_opportunities)+(select count(*) from public.registration_proposals)+(select count(*) from public.registration_proposal_reviews)") === "0");
check("シャドーの設定は行なし（＝すべてOFF・予算0）", q("select count(*) from public.shadow_settings") === "0");
check("107 の制約（緩和版）が保たれている", q("select pg_get_constraintdef(oid) from pg_constraint where conname='lotteries_result_end_range'").includes("result_date IS NULL"));

// 旧アプリ相当: 新しい列・表を知らない読み書き（実データ。トランザクションを巻き戻す）
const legacy = run(`begin;${NL}update public.lotteries set memo = memo where id = (select id from public.lotteries limit 1);${NL}update public.collection_settings set collection_engine = collection_engine;${NL}select count(*) from public.applications;${NL}rollback;`, ["-At"]);
check("旧アプリ相当の更新・読み取りが動く（巻き戻し）", legacy.status === 0, (legacy.stderr || "").slice(0, 120));
const ownerId = q("select user_id::text from public.household_members limit 1");
const rls = run(`begin;${NL}set local role authenticated;${NL}select set_config('request.jwt.claims', '{"sub":"${ownerId}","role":"authenticated"}', true);${NL}select (select count(*) from public.lotteries), (select count(*) from public.applications);${NL}rollback;`, ["-At"]);
const m = (rls.stdout || "").split(NL).find((l) => /^\d+\|\d+$/.test(l.trim()));
check("RLS: 所有者として実データの抽選・応募が読める（移行後）", rls.status === 0 && m === `${lotteries0}|${q("select count(*) from public.applications")}`, m ?? (rls.stderr || "").slice(0, 120));
const purge = q("select count(*) from public.purge_test_households()");
check("purge_test_households() は実データの世帯を消さない（実行して0世帯・世帯数不変）", purge === "0" && q("select count(*) from public.households") === households0, `削除 ${purge} 世帯 / 世帯 ${households0}`);

console.log(results.every(Boolean) ? "\nリハーサル: すべて合格" : "\nリハーサル: 不合格あり");
process.exit(results.every(Boolean) ? 0 : 1);
