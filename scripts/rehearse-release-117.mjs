// 本番反映（117: 状態ランク S/A/B/C/D・更新/完売の履歴・一括購入）の前の、**本番の完全バックアップの復元コピー**への適用リハーサル。本番には接続しない（使い捨てコンテナ）。
//   前提: npm run prod -- scripts/restore-full-drill.mjs --file <最新の完全バックアップ> --keep --yes-production で、本番のコピーを復元済みであること。
//   node scripts/rehearse-release-117.mjs
// 確認: ①適用前の相場系の行ごとの値（旧ランク）を記録 ②117を適用 ③旧→新のランク対応（A+→S, A→A, B+→B, B→C, C→D）が全行で正しく、ランク以外の列は全て不変 ④他の全表の行が不変
//       ⑤旧ランクが残っていない・新制約が効く ⑥新しい表・関数・RLS ⑦再適用してもランクが二重に変換されない
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";

const NAME = "tcg-restore-drill";
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

const RANK = ["zukan_price_records", "zukan_cards", "market_prices", "market_purchases"];
const MAP = { "A+": "S", A: "A", "B+": "B", B: "C", C: "D", "": "" };

check("本番コピーは116の適用後（相場の共通化済み）で、117の構造が無い", q("select count(*) from information_schema.tables where table_schema='public' and table_name='market_price_events'") === "0" && q("select count(*) from information_schema.tables where table_schema='public' and table_name='market_plan_marks'") === "1");
const tables = q("select table_name from information_schema.tables where table_schema='public' and table_type='BASE TABLE' order by 1").split(NL).filter(Boolean);
const colsOf = (t) => q(`select column_name from information_schema.columns where table_schema='public' and table_name='${t}' order by ordinal_position`).split(NL).filter(Boolean);
const preCols = Object.fromEntries(tables.map((t) => [t, colsOf(t)]));
// 行ごとの値（id → 全列のJSON）。ランク列（condition）は別に比較する
const snap = (t, skipCond) => {
  const keep = preCols[t].filter((c) => !(skipCond && c === "condition")).map((c) => `'${c}'`).join(",");
  const out = q(`select id::text || '|' || md5(j::text) from (select x.id, (select jsonb_object_agg(k, v) from jsonb_each(to_jsonb(x)) e(k, v) where k in (${keep})) as j from public."${t}" x) s order by 1`);
  return out ? out.split(NL) : [];
};
const hasId = (t) => preCols[t].includes("id");
const pre = Object.fromEntries(tables.filter(hasId).map((t) => [t, snap(t, RANK.includes(t))]));
const rows = Object.values(pre).reduce((n, v) => n + v.length, 0);
check("適用前の行ごとの指紋を記録（id を持つ全表）", rows > 20000, `${Object.keys(pre).length}表・${rows}行`);
const before = Object.fromEntries(RANK.map((t) => [t, q(`select id::text || '|' || condition from public.${t} order by id`).split(NL).filter(Boolean)]));
console.log("適用前の件数:", RANK.map((t) => `${t}=${before[t].length}`).join(" / "), "／ランク:", [...new Set(RANK.flatMap((t) => before[t].map((x) => x.split("|")[1])))].join(","));

const sql = readFileSync("supabase/migrations/20261231000117_market_ranks_events_bulk_buy.sql", "utf8");
const t0 = Date.now();
const r = run(`begin;${NL}${sql}${NL}commit;`);
check("117の適用", r.status === 0, r.status === 0 ? `${Date.now() - t0}ms` : (r.stderr || "").split(NL).filter(Boolean).slice(0, 3).join(" / "));
if (r.status !== 0) process.exit(1);

let rankOk = true;
for (const t of RANK) {
  const after = new Map(q(`select id::text || '|' || condition from public.${t}`).split(NL).filter(Boolean).map((x) => x.split("|")));
  for (const b of before[t]) {
    const [id, cond] = b.split("|");
    if (after.get(id) !== MAP[cond]) rankOk = false;
  }
  if (after.size !== before[t].length) rankOk = false;
}
check("ランクの対応（A+→S, A→A, B+→B, B→C, C→D。空欄は空欄）が相場系の全行で正しい。行数も同じ", rankOk);
check("旧ランク（A+・B+）が残っていない", q(`select count(*) from (${RANK.map((t) => `select condition from public.${t}`).join(" union all ")}) s where condition in ('A+','B+')`) === "0");
let same = true;
const diffs = [];
for (const t of Object.keys(pre)) {
  const post = snap(t, RANK.includes(t));
  if (post.length !== pre[t].length || post.some((h, i) => h !== pre[t][i])) {
    // 新しい列が増えた表は、移行前の列だけで比較している（preCols）。差があれば報告
    same = false;
    diffs.push(t);
  }
}
check("ランク列以外の既存データは全表・全行で不変（値の変更・削除なし）", same, diffs.join(","));
check("新制約が効く（旧ランクの挿入は拒否）", (() => {
  const x = run("begin; insert into public.market_prices(household_id,profile_id,card_id,store_name,condition,price_yen) select household_id,profile_id,id,'x','A+',1 from public.market_cards limit 1; rollback;");
  return x.status !== 0;
})());
check("新しい表・関数・RLS", q("select count(*) from information_schema.tables where table_schema='public' and table_name in ('market_price_events','market_bulk_purchases')") === "2" && q("select count(*) from pg_proc where proname in ('market_record_event','market_bulk_buy_tx','market_set_plan_mark')") === "3" && q("select count(*) from pg_class where relname in ('market_price_events','market_bulk_purchases') and relrowsecurity") === "2");
// 再適用でランクが二重に変換されない（新表の作成で失敗するが、ランク変換のブロックは何もしない）
const first = Object.fromEntries(RANK.map((t) => [t, q(`select string_agg(condition, ',' order by id) from public.${t}`)]));
const re = run(`begin;${NL}${sql.slice(0, sql.indexOf("-- ================================================================ 2."))}${NL}commit;`);
const again = Object.fromEntries(RANK.map((t) => [t, q(`select string_agg(condition, ',' order by id) from public.${t}`)]));
check("ランク変換の部分を再実行しても二重に変換されない", re.status === 0 && RANK.every((t) => again[t] === first[t]));
console.log(results.every(Boolean) ? "\nリハーサル: すべて合格" : "\nリハーサル: 不合格あり");
process.exit(results.every(Boolean) ? 0 : 1);
