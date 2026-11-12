// 本番反映の前の、マイグレーションのリハーサル（ローカルの開発用DBだけを使う。本番・実データには触れない。Stage 8E-1）。
//   node scripts/rehearse-migration.mjs
// 手順: ①開発用DBを「本番と同じ状態（093まで適用）」に初期化 → ②架空データ（開発用シード＋旧形式の一括登録グループ）を入れる → ③状態を記録
//       → ④094〜098を順に適用（supabase migration up） → ⑤既存データの件数・内容が変わっていないこと、グループ履歴の補完、新しい構造を検証。
// 終了後、開発用DBは最新の状態（db:reset 相当＋シード）に戻す。接続先がローカルであることを確認してから実行する。
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { assertLocalTarget } from "./lib/target.mjs";

try {
  process.loadEnvFile(".env.local");
} catch {
  /* 無ければ判定で止まる */
}
assertLocalTarget("rehearse-migration");

const WORK = ".dev-supabase";
const DB = "supabase_db_tcg-dev";
const sh = (cmd, args, opts = {}) => spawnSync(cmd, args, { encoding: "utf8", shell: true, ...opts });
const sb = (args) => sh("npx", ["supabase", ...args, "--workdir", WORK], { stdio: "inherit" });
const psql = (sql) => {
  const r = spawnSync("docker", ["exec", "-i", DB, "psql", "-U", "postgres", "-At", "-F", "|", "-v", "ON_ERROR_STOP=1"], { input: sql, encoding: "utf8" });
  if (r.status !== 0) throw new Error(`psql 失敗: ${r.stderr}`);
  return r.stdout.trim();
};
const check = [];
const ok = (name, cond, detail = "") => {
  check.push({ name, cond, detail });
  console.log(`${cond ? "✅" : "❌"} ${name}${detail ? ` — ${detail}` : ""}`);
};

const all = readdirSync("supabase/migrations").filter((f) => f.endsWith(".sql")).sort();
const before = all.filter((f) => f <= "20261211000093_stage7s_store_delete_merge.sql");
const after = all.filter((f) => f > "20261211000093_stage7s_store_delete_merge.sql");
console.log(`本番と同じ状態（${before.length}本。最後: ${before.at(-1)}）→ 適用するもの: ${after.join(", ")}`);

const put = (files) => {
  rmSync(`${WORK}/supabase/migrations`, { recursive: true, force: true });
  mkdirSync(`${WORK}/supabase/migrations`, { recursive: true });
  for (const f of files) cpSync(`supabase/migrations/${f}`, `${WORK}/supabase/migrations/${f}`);
};

// ① 093 まで適用した状態へ初期化
put(before);
if (sb(["db", "reset", "--local"]).status !== 0) throw new Error("db reset 失敗");
const tables0 = psql("select count(*) from information_schema.tables where table_schema='public' and table_name in ('lottery_exclusions','lottery_group_events','lottery_operations','store_location_research')");
ok("リハーサル前: 094〜098 の表が無い（本番と同じ状態）", tables0 === "0", `該当 ${tables0}`);

// ② 架空データ（開発用シード）
const seed = sh("node", ["scripts/dev-db.mjs", "seed"], { stdio: "pipe" });
if (seed.status !== 0) throw new Error(`seed 失敗: ${seed.stderr}`);
// 旧形式の一括登録グループ（Stage 7L）と、同じ系列の複数の抽選を所属させる
psql(`
with c as (select chain_id, household_id from public.lotteries group by chain_id, household_id having count(*) >= 3 order by count(*) desc limit 1),
g as (
  insert into public.lottery_bulk_groups (household_id, op_id, chain_id, store_count)
  select household_id, gen_random_uuid(), chain_id, 3 from c returning id, chain_id, household_id
)
update public.lotteries l set bulk_group_id = g.id
 from g where l.chain_id = g.chain_id and l.household_id = g.household_id and l.id in (select id from public.lotteries x where x.chain_id = g.chain_id order by x.created_at limit 3);
`);
const snap = () => ({
  lotteries: psql("select count(*) from public.lotteries"),
  items: psql("select count(*) from public.lottery_items"),
  apps: psql("select count(*) from public.applications"),
  mgmt: psql("select count(*) from public.lottery_management"),
  stores: psql("select count(*) from public.stores"),
  purchases: psql("select count(*) from public.purchases"),
  profiles: psql("select count(*) from public.profiles"),
  groups: psql("select count(*) from public.lottery_bulk_groups"),
  members: psql("select count(*) from public.lotteries where bulk_group_id is not null"),
  // 既存の列の内容の指紋（新しい列は含めない）
  lotHash: psql("select md5(string_agg(concat_ws('|', id, chain_id, store_id, apply_method, event_state, apply_deadline_date, apply_deadline_at, memo, archived_at, bulk_group_id), ',' order by id)) from public.lotteries"),
  appHash: psql("select md5(string_agg(concat_ws('|', id, lottery_id, state, result_status, fulfillment_status), ',' order by id)) from public.applications"),
  storeHash: psql("select md5(string_agg(concat_ws('|', id, chain_id, name, prefecture), ',' order by id)) from public.stores"),
});
const pre = snap();
console.log("適用前:", JSON.stringify(pre));
ok("リハーサル用データ: 旧形式のグループと所属がある", Number(pre.groups) >= 1 && Number(pre.members) >= 3, `グループ ${pre.groups} / 所属 ${pre.members}`);

// ④ 094〜098 を順に適用（番号順。途中で失敗したら止まる）
put(all);
const mig = sh("npx", ["supabase", "migration", "up", "--local", "--workdir", WORK], { stdio: "inherit" });
ok("094→095→096→097→098 が順に適用できた", mig.status === 0);
if (mig.status !== 0) {
  const applied = psql("select version from supabase_migrations.schema_migrations order by version desc limit 3");
  console.log("適用済みの末尾:", applied.replace(/\n/g, ", "));
  process.exit(1);
}
const ver = psql("select version from supabase_migrations.schema_migrations order by version desc limit 1");
ok("適用済みの最新が 098", ver === "20261216000098", ver);

// ⑤ 検証
const post = snap();
console.log("適用後:", JSON.stringify(post));
for (const k of ["lotteries", "items", "apps", "mgmt", "stores", "purchases", "profiles", "groups", "members", "lotHash", "appHash", "storeHash"]) ok(`既存データが変わっていない: ${k}`, pre[k] === post[k], pre[k] === post[k] ? "" : `${pre[k]} → ${post[k]}`);
const ev = psql("select count(*) filter (where action='created'), count(*) filter (where action='added') from public.lottery_group_events where detail ? 'backfilled'");
const [evCreated, evAdded] = ev.split("|");
ok("097: グループ履歴の補完（グループ数＝作成、所属数＝追加）", Number(evCreated) === Number(post.groups) && Number(evAdded) === Number(post.members), `作成 ${evCreated} / 追加 ${evAdded}`);
ok("097: 既存のグループは origin = bulk_registration", psql("select count(*) from public.lottery_bulk_groups where origin <> 'bulk_registration'") === "0");
ok("097: 除外・操作の表が空（新規）", psql("select (select count(*) from public.lottery_exclusions) + (select count(*) from public.lottery_operations)") === "0");
const rls = psql("select string_agg(relname, ',' order by relname) from pg_class where relname in ('lottery_exclusions','lottery_group_events','lottery_operations','store_location_research','store_location_proposals','store_location_proposal_events') and relrowsecurity");
ok("RLS: 新しい表すべてで有効", rls?.split(",").length === 6, rls);
ok("関数が揃っている（デプロイ前に必要なもの）", psql("select count(*) from pg_proc where pronamespace='public'::regnamespace and proname in ('exclude_lottery_tx','group_lotteries_tx','ungroup_lottery_tx','dissolve_lottery_group_tx','duplicate_lottery_tx','duplicate_lottery_op_tx','save_lottery_and_duplicate_tx','lottery_op_result','propose_store_location','decide_store_location_proposal','apply_store_location_proposal','revert_store_location_proposal')") === "12");
ok("anon に新しい表・関数の権限がない", psql("select count(*) from information_schema.role_table_grants where grantee='anon' and table_schema='public' and table_name in ('lottery_exclusions','lottery_group_events','lottery_operations','store_location_research','store_location_proposals','store_location_proposal_events')") === "0");
ok("制約: apply_method に serial、旧い値は有効のまま", psql("select pg_get_constraintdef(oid) from pg_constraint where conname='lotteries_apply_method_check'").includes("serial"));
// 旧アプリが使う旧い呼び出し（save_lottery_bulk_tx の groups 挿入）が、新しい列・制約と両立すること
psql(`insert into public.lottery_bulk_groups (household_id, op_id, chain_id, store_count) select household_id, gen_random_uuid(), chain_id, 2 from public.lottery_bulk_groups limit 1;`);
ok("旧形式のグループ作成（旧アプリの挿入）が新しい構造で動く（既定値・制約）", psql("select count(*) from public.lottery_bulk_groups where origin = 'bulk_registration'") === String(Number(post.groups) + 1));

console.log(check.every((c) => c.cond) ? "\n✅ リハーサル合格" : `\n❌ 不合格: ${check.filter((c) => !c.cond).map((c) => c.name).join(" / ")}`);
// 開発用DBを最新の状態へ戻す
put(all);
if (sb(["db", "reset", "--local"]).status === 0) sh("node", ["scripts/dev-db.mjs", "seed"], { stdio: "ignore" });
writeFileSync("eval/runs/migration-rehearsal.json", JSON.stringify({ at: new Date().toISOString(), pre, post, checks: check }, null, 2));
process.exit(check.every((c) => c.cond) ? 0 : 1);
