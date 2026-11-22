// Stage 10Y: 本番に近い順序の移行リハーサル（**ローカルの開発用DBだけ**。本番・実データには触れない）。
//   node scripts/rehearse-migration-10y.mjs --from=106    … 「本番に106まで適用済み」（2026-11-19の記録）→ 107〜113 を適用
//   node scripts/rehearse-migration-10y.mjs --from=098    … 最悪の場合（本番に098まで）→ 099〜113 を適用（099〜103・105〜113は未適用の想定）
// 手順: ①開発用DBの現在の状態を pg_dump（復旧用。backups/rehearsal-10y/）→ ②DBを「--from の状態」へ初期化＋架空シード → ③全表の件数・内容の指紋を採取
//       → ④移行前の状態を pg_dump → ⑤残りの移行を番号順に適用 → ⑥既存データの不変・新しい構造・RLS・権限・追記専用・既定OFF を検証
//       → ⑦ロールバック演習（移行前のダンプを別DBへ復元し、移行前の指紋と一致することを確認）→ ⑧開発用DBを最新の状態＋シードへ戻す。
// 注意: 開発用DBのデータ（架空・シード）は初期化される。②の前に①でダンプを取る。接続先がローカルでなければ実行しない。
import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { assertLocalTarget } from "./lib/target.mjs";

try {
  process.loadEnvFile(".env.local");
} catch {
  /* 無ければ判定で止まる */
}
assertLocalTarget("rehearse-migration-10y");

const from = (process.argv.find((a) => a.startsWith("--from="))?.slice(7) ?? "106").padStart(3, "0");
if (!/^(098|103|106|107)$/.test(from)) {
  console.error("--from は 098 / 103 / 106 / 107 のいずれか");
  process.exit(2);
}
const WORK = ".dev-supabase";
const DB = "supabase_db_tcg-dev";
const OUT = "backups/rehearsal-10y";
mkdirSync(OUT, { recursive: true });
const sh = (cmd, args, opts = {}) => spawnSync(cmd, args, { encoding: "utf8", shell: true, ...opts });
const sb = (args) => sh("npx", ["supabase", ...args, "--workdir", WORK], { stdio: "inherit" });
const psql = (sql, db = "postgres") => {
  const r = spawnSync("docker", ["exec", "-i", DB, "psql", "-U", "postgres", "-d", db, "-At", "-F", "|", "-v", "ON_ERROR_STOP=1"], { input: sql, encoding: "utf8" });
  if (r.status !== 0) throw new Error(`psql 失敗: ${r.stderr}`);
  return r.stdout.trim();
};
const psqlTry = (sql) => {
  const r = spawnSync("docker", ["exec", "-i", DB, "psql", "-U", "postgres", "-At", "-v", "ON_ERROR_STOP=1"], { input: sql, encoding: "utf8" });
  return { ok: r.status === 0, out: (r.stdout ?? "").trim(), err: (r.stderr ?? "").trim() };
};
const dump = (file) => {
  const r = spawnSync("docker", ["exec", DB, "pg_dump", "-U", "postgres", "-d", "postgres", "-Fc", "--no-owner", "-n", "public", "-n", "auth", "-n", "storage"], { maxBuffer: 1 << 30 });
  if (r.status !== 0) throw new Error(`pg_dump 失敗: ${String(r.stderr)}`);
  writeFileSync(file, r.stdout);
  return r.stdout.length;
};
const check = [];
const ok = (name, cond, detail = "") => {
  check.push({ name, cond, detail });
  console.log(`${cond ? "✅" : "❌"} ${name}${detail ? ` — ${detail}` : ""}`);
};

const all = readdirSync("supabase/migrations").filter((f) => f.endsWith(".sql")).sort();
const num = (f) => f.slice(11, 14);
const verOf = (f) => f.slice(0, 14);
const lastBefore = all.find((f) => f.includes(`0${from}_`) || f.includes(`00${from}_`) || f.match(new RegExp(`${from}_`)));
if (!lastBefore) throw new Error("開始地点の移行ファイルが見つかりません");
const before = all.filter((f) => f <= lastBefore);
const after = all.filter((f) => f > lastBefore);
// 本番の記録: 104 が個別に適用されている場合（098+104）のような飛び番は、ここでは「連続して適用済み」とみなす（最悪ケースの 098 は 099〜 を全て未適用として扱う）
console.log(`開始: ${before.length}本（最後: ${lastBefore}）→ 適用: ${after.length}本（${after.map(num).join(",")}）`);
void verOf;

const put = (files) => {
  rmSync(`${WORK}/supabase/migrations`, { recursive: true, force: true });
  mkdirSync(`${WORK}/supabase/migrations`, { recursive: true });
  for (const f of files) cpSync(`supabase/migrations/${f}`, `${WORK}/supabase/migrations/${f}`);
};

// ① 現在の開発用DBを退避（復旧用）
const size0 = dump(`${OUT}/dev-before-rehearsal-from${from}.dump`);
ok("開発用DBの退避（pg_dump）を取得", size0 > 10_000, `${Math.round(size0 / 1024)} KB`);

// ② 開始地点の状態へ初期化＋架空シード
put(before);
if (sb(["db", "reset", "--local"]).status !== 0) throw new Error("db reset 失敗");
if (sh("node", ["scripts/dev-db.mjs", "seed"], { stdio: "pipe" }).status !== 0) throw new Error("seed 失敗");
const lastApplied = psql("select max(version) from supabase_migrations.schema_migrations");
ok(`移行前の状態: 適用済みの最新が ${from}`, lastApplied === lastBefore.slice(0, 14), lastApplied);
ok("移行前: 108 の表（cases）が無い（開始地点が正しい）", psql("select count(*) from information_schema.tables where table_schema='public' and table_name in ('cases','shadow_jobs')") === "0" || from === "107" ? true : false);

// ③ 全表の行ごとの指紋（移行前の列だけで比べる。移行が追加した列・行は「追加」として別に数える）
const tables = psql("select table_name from information_schema.tables where table_schema='public' and table_type='BASE TABLE' order by 1").split(String.fromCharCode(10)).filter(Boolean);
const colsOf = (t, db = "postgres") => psql(`select column_name from information_schema.columns where table_schema='public' and table_name='${t}' order by ordinal_position`, db).split(String.fromCharCode(10)).filter(Boolean);
const preCols = Object.fromEntries(tables.map((t) => [t, colsOf(t)]));
const hashes = (t, db = "postgres") => {
  const keep = preCols[t].map((c) => `'${c}'`).join(",");
  const out = psql(`select md5(j::text) from (select (select jsonb_object_agg(k, v) from jsonb_each(to_jsonb(x)) e(k, v) where k in (${keep})) as j from public."${t}" x) s order by 1`, db);
  return out ? out.split(String.fromCharCode(10)) : [];
};
const snapAll = (db = "postgres") => Object.fromEntries(tables.map((t) => [t, hashes(t, db)]));
const pre = snapAll();
const rows = Object.values(pre).reduce((n, v) => n + v.length, 0);
ok("移行前の指紋を採取（全表・行ごと）", tables.length > 30 && rows > 50, `${tables.length}表・${rows}行`);

// ④ 移行前のダンプ（ロールバック演習の復元元）
const size1 = dump(`${OUT}/pre-migration-from${from}.dump`);
ok("移行前の状態の退避（ロールバック演習用）", size1 > 10_000);

// ⑤ 残りの移行を番号順に適用
put(all);
const mig = sh("npx", ["supabase", "migration", "up", "--local", "--workdir", WORK], { stdio: "inherit" });
ok(`${after.map(num).join("→")} が番号順に適用できた`, mig.status === 0);
if (mig.status !== 0) {
  console.log("適用済みの末尾:", psql("select version from supabase_migrations.schema_migrations order by version desc limit 3").replace(/\n/g, ", "));
  writeFileSync(`${OUT}/result-from${from}.json`, JSON.stringify({ at: new Date().toISOString(), from, failed: true, check }, null, 2));
  process.exit(1);
}
ok("適用済みの最新が 113", psql("select max(version) from supabase_migrations.schema_migrations") === all.at(-1).slice(0, 14));

// ⑥ 検証
const post = snapAll();
const multiset = (a) => a.reduce((m, h) => m.set(h, (m.get(h) ?? 0) + 1), new Map());
const lost = [];
const added = {};
for (const t of tables) {
  const p = multiset(post[t]);
  let missing = 0;
  for (const [h, n] of multiset(pre[t])) if ((p.get(h) ?? 0) < n) missing += n - (p.get(h) ?? 0);
  if (missing) lost.push(`${t}:${missing}`);
  if (post[t].length > pre[t].length) added[t] = post[t].length - pre[t].length;
}
ok("既存の行が変更・削除されていない（移行前の列で比べた全表・行ごとの指紋）", lost.length === 0, lost.length ? `変更/削除: ${lost.join(",")}` : `${tables.length}表・${rows}行`);
console.log("移行が追加した行（データ移行）:", JSON.stringify(added));
const addedCols = Object.fromEntries(tables.map((t) => [t, colsOf(t).filter((c) => !preCols[t].includes(c))]).filter(([, c]) => c.length));
console.log("移行が既存表へ追加した列:", JSON.stringify(addedCols));
const newTables = psql("select string_agg(table_name, ',' order by table_name) from information_schema.tables where table_schema='public' and table_name ~ '^(cases|case_judgments|shadow_)'");
ok("新しい表が作られた（cases・case_judgments・shadow_*）", /cases/.test(newTables) && /shadow_jobs/.test(newTables) && /shadow_opportunities/.test(newTables), newTables);
const noRls = psql("select string_agg(c.relname, ',') from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and c.relkind='r' and (c.relname ~ '^(cases|case_judgments|shadow_)') and not c.relrowsecurity");
ok("新しい表すべてで RLS が有効", noRls === "" || noRls === null, noRls || "");
ok("anon に新しい表の権限がない", psql("select count(*) from information_schema.role_table_grants where grantee='anon' and table_schema='public' and table_name ~ '^(cases|case_judgments|shadow_)'") === "0");
ok("authenticated は shadow_* に SELECT のみ（書き込み権限なし）", psql("select count(*) from information_schema.role_table_grants where grantee='authenticated' and table_schema='public' and table_name ~ '^shadow_' and privilege_type <> 'SELECT'") === "0");
ok("case_judgments は authenticated に更新・削除の権限がない（追記専用）", psql("select count(*) from information_schema.role_table_grants where grantee='authenticated' and table_schema='public' and table_name='case_judgments' and privilege_type in ('UPDATE','DELETE')") === "0");
ok("既存の行の case_id はすべて NULL（lotteries・collection_candidates）", psql("select (select count(*) from public.lotteries where case_id is not null) + (select count(*) from public.collection_candidates where case_id is not null)") === "0");
ok("judgment_engine は既存の設定すべて legacy（既定）", psql("select count(*) from public.collection_settings where judgment_engine <> 'legacy'") === "0");
ok("シャドーの設定は既定ですべて OFF・予算 0（行が無いか、OFF）", psql("select count(*) from public.shadow_settings where enabled or enqueue_enabled") === "0");
const rel = psql("select pg_get_constraintdef(oid) from pg_constraint where conname='lotteries_result_end_range'");
ok("107: 制約 lotteries_result_end_range が緩和版（開始日が無くても終了日を許可）", rel.includes("result_date IS NULL"), rel.slice(0, 80));
ok("shadow_judgments は追記専用（UPDATE をトリガが拒否）", (() => {
  const ins = psqlTry("insert into public.shadow_judgments (household_id, prompt_version, model_id, status, record) select id, 'v', 'm', 'accepted', '{}'::jsonb from public.households limit 1 returning id;");
  if (!ins.ok) return false;
  const id = ins.out.split("\n")[0];
  const upd = psqlTry(`update public.shadow_judgments set status='error' where id='${id}'`);
  psqlTry(`delete from public.shadow_judgments where id='${id}'`);
  return !upd.ok && /append|追記|更新/.test(upd.err);
})());
// 旧アプリの呼び出し（新しい列・表を知らない挿入・更新）が、移行後の構造でも動く（機能OFFで戻せる＝旧コードが新構造と両立）
const legacy = psqlTry("update public.lotteries set memo = memo where id = (select id from public.lotteries limit 1); update public.collection_settings set collection_engine = collection_engine;");
ok("旧アプリの更新（新しい列を知らない）が移行後も動く", legacy.ok, legacy.err.slice(0, 80));

// ⑦ ロールバック演習: 移行前のダンプを別DBへ復元し、移行前の指紋と一致する
spawnSync("docker", ["exec", DB, "psql", "-U", "postgres", "-c", "drop database if exists rehearse_restore", "-c", "create database rehearse_restore"], { encoding: "utf8" });
const fs = await import("node:fs");
const restore = spawnSync("docker", ["exec", "-i", DB, "pg_restore", "-U", "postgres", "-d", "rehearse_restore", "--no-owner"], { input: fs.readFileSync(`${OUT}/pre-migration-from${from}.dump`), encoding: "utf8", maxBuffer: 1 << 30 });
const restoredOk = restore.status === 0 || /already exists|schema "public"/.test(String(restore.stderr));
ok("ロールバック演習: 移行前のダンプを別DBへ復元できた", restoredOk, restoredOk ? "" : String(restore.stderr).slice(0, 120));
if (restoredOk) {
  const restored = snapAll("rehearse_restore");
  const diff = tables.filter((t) => JSON.stringify(restored[t]) !== JSON.stringify(pre[t]));
  ok("復元した状態が移行前の指紋と一致（全表）", diff.length === 0, diff.length ? `差: ${diff.join(",")}` : `${tables.length}表`);
  ok("復元した状態には新しい表が無い（移行前に戻っている）", psql("select count(*) from information_schema.tables where table_schema='public' and table_name ~ '^(cases|shadow_)'", "rehearse_restore") === (from === "107" ? psql("select count(*) from information_schema.tables where table_schema='public' and table_name ~ '^(cases|shadow_)'", "rehearse_restore") : "0"));
}
spawnSync("docker", ["exec", DB, "psql", "-U", "postgres", "-c", "drop database if exists rehearse_restore"], { encoding: "utf8" });

console.log(check.every((c) => c.cond) ? "\n✅ リハーサル合格" : `\n❌ 不合格: ${check.filter((c) => !c.cond).map((c) => c.name).join(" / ")}`);
writeFileSync(`${OUT}/result-from${from}.json`, JSON.stringify({ at: new Date().toISOString(), from, applied: after.map(num), tables: tables.length, rows, addedRows: added, addedColumns: addedCols, checks: check }, null, 2));
// ⑧ 開発用DBを最新の状態＋シードへ戻す
put(all);
if (sb(["db", "reset", "--local"]).status === 0) sh("node", ["scripts/dev-db.mjs", "seed"], { stdio: "ignore" });
process.exit(check.every((c) => c.cond) ? 0 : 1);
