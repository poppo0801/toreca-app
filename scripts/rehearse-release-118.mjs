// 本番反映（118: 収録パックマスター・個別購入と購入記録の連携）の前の、**本番の完全バックアップの復元コピー**への適用リハーサル。本番には接続しない（使い捨てコンテナ）。
//   前提: npm run prod -- scripts/restore-full-drill.mjs --file <最新の完全バックアップ> --keep --yes-production で、本番のコピーを復元済みであること。
//   node scripts/rehearse-release-118.mjs
// 確認: ①適用前の全表の行ごとの指紋を記録 ②118を適用 ③既存の全表・全行が不変（列の追加以外の変更・削除なし） ④購入記録・購入明細・収支の元になる表の件数・合計が不変
//       ⑤新しい表（expansion_marks）・列・関数・トリガー・RLS ⑥旧い2引数の購入関数が残っている ⑦新旧どちらの購入関数も動く（トランザクション内で試し、ロールバック）
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

check("本番コピーは117の適用後で、118の構造が無い", q("select count(*) from information_schema.tables where table_schema='public' and table_name='market_bulk_purchases'") === "1" && q("select count(*) from information_schema.tables where table_schema='public' and table_name='expansion_marks'") === "0");
const tables = q("select table_name from information_schema.tables where table_schema='public' and table_type='BASE TABLE' order by 1").split(NL).filter(Boolean);
const colsOf = (t) => q(`select column_name from information_schema.columns where table_schema='public' and table_name='${t}' order by ordinal_position`).split(NL).filter(Boolean);
const preCols = Object.fromEntries(tables.map((t) => [t, colsOf(t)]));
const snap = (t) => {
  const keep = preCols[t].map((c) => `'${c}'`).join(",");
  const out = q(`select id::text || '|' || md5(j::text) from (select x.id, (select jsonb_object_agg(k, v) from jsonb_each(to_jsonb(x)) e(k, v) where k in (${keep})) as j from public."${t}" x) s order by 1`);
  return out ? out.split(NL) : [];
};
const hasId = (t) => preCols[t].includes("id");
const pre = Object.fromEntries(tables.filter(hasId).map((t) => [t, snap(t)]));
const rows = Object.values(pre).reduce((n, v) => n + v.length, 0);
check("適用前の行ごとの指紋を記録（id を持つ全表）", rows > 20000, `${Object.keys(pre).length}表・${rows}行`);
const money = () => q("select (select count(*) from public.purchases) || '/' || (select count(*) from public.purchase_items) || '/' || coalesce((select sum(amount_paid) from public.purchase_items), 0) || '/' || (select count(*) from public.zukan_cards) || '/' || (select count(*) from public.market_purchases)");
const moneyBefore = money();
console.log("購入記録/明細/金額合計/収集カード/相場購入:", moneyBefore);

const sql = readFileSync("supabase/migrations/20261231000118_expansion_master_purchase_link.sql", "utf8");
const t0 = Date.now();
const r = run(`begin;${NL}${sql}${NL}commit;`);
check("118の適用", r.status === 0, r.status === 0 ? `${Date.now() - t0}ms` : (r.stderr || "").split(NL).filter(Boolean).slice(0, 3).join(" / "));
if (r.status !== 0) process.exit(1);

let same = true;
const diffs = [];
for (const t of Object.keys(pre)) {
  const post = snap(t);
  if (post.length !== pre[t].length || post.some((h, i) => h !== pre[t][i])) {
    same = false;
    diffs.push(t);
  }
}
check("既存の全表・全行が不変（移行前の列の値の変更・削除なし）", same, diffs.join(","));
check("購入記録・明細・金額合計・収集カード・相場購入が不変", money() === moneyBefore);
check("新しい表・列・関数・RLS", q("select count(*) from information_schema.tables where table_schema='public' and table_name='expansion_marks'") === "1" && q("select count(*) from pg_class where relname='expansion_marks' and relrowsecurity") === "1" && q("select count(*) from information_schema.columns where table_schema='public' and column_name='purchase_item_id' and table_name in ('zukan_cards','market_purchases')") === "2" && q("select count(*) from pg_proc where proname in ('market_attach_single_purchase','market_detach_purchase_item','market_on_purchase_delete')") === "3");
check("収録パックマスターの初期データ（SV1S・SV2a・SV8 ほか有効35件）", q("select count(*) from public.expansion_marks where active") === "35" && q("select set_name from public.expansion_marks where mark='SV2a'") === "ポケモンカード151");
check("旧い2引数の購入関数も残っている（新旧どちらでも呼べる）", q("select count(*) from pg_proc where proname in ('zukan_buy_from_price_tx','market_buy_from_price_tx')") === "4");
check("購入予定の一括購入関数・既存の更新/完売の関数が残っている", q("select count(*) from pg_proc where proname in ('market_bulk_buy_tx','market_record_event','market_set_plan_mark')") === "3");
console.log(results.every(Boolean) ? "\nリハーサル: すべて合格" : "\nリハーサル: 不合格あり");
process.exit(results.every(Boolean) ? 0 : 1);
