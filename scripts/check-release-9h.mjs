// Stage 9H-3R-Release: 自律型AI主体の本番反映（マイグレーション099〜103・105）の事前確認・適用後確認（**読み取り専用**。何も書き込まない）。
//   本番:   npm run prod -- scripts/check-release-9h.mjs --yes-production [--snapshot=<保存先.json>] [--compare=<事前の.json>]
//   開発DB: node scripts/check-release-9h.mjs
// 確認: ①新しい列・表の有無（適用前は「なし」、適用後は「あり」）②既存の主要な表の件数（適用の前後で変わっていないこと）
//       ③収集方式の設定（適用後は全世帯が legacy。自律型を選ぶまで変わらない）④RLS（匿名では新しい表を読めない）
// --snapshot で件数を保存し、適用後に --compare で前後の差が無いことを確認する。
import { createClient } from "@supabase/supabase-js";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

const isProd = process.env.TOREMANE_TARGET === "production";
if (!isProd) {
  try {
    process.loadEnvFile(".env.local");
  } catch {
    /* 環境変数が既に設定されている場合 */
  }
}
const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
const anon = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
if (!url || !key) throw new Error("接続先の設定がありません。中止します。");
const local = /^http:\/\/(127\.0\.0\.1|localhost)/.test(url);
if (!isProd && !local) throw new Error("本番への接続は npm run prod 経由のみです。中止します。");
console.log(`接続先: ${isProd ? "本番（読み取り専用）" : "ローカル開発DB（動作確認）"}`);
const db = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
const arg = (n) => process.argv.find((a) => a.startsWith(`--${n}=`))?.split("=")[1];

const COLUMNS = {
  "099": [["lottery_group_proposals", ["id", "kind", "status", "tier"]]],
  "100": [["lottery_source_snapshots", ["id"]]],
  "101": [["lotteries", ["lottery_form", "lottery_form_source"]]],
  "102": [["lotteries", ["update_history"]]],
  "103": [["agent_investigation_runs", ["id"]], ["agent_investigation_steps", ["id"]], ["agent_monitor_candidates", ["id"]]],
  "105": [["collection_settings", ["collection_engine", "collection_engine_changed_at", "autonomous_lock_until"]], ["discovery_runs", ["id", "slot", "cost_jpy", "status"]], ["discovery_strategy", ["household_id"]], ["lottery_discovery_origins", ["lottery_id", "source_url"]]],
};
const NEW_TABLES = ["lottery_group_proposals", "lottery_source_snapshots", "agent_investigation_runs", "agent_investigation_steps", "agent_monitor_candidates", "discovery_runs", "discovery_strategy", "lottery_discovery_origins"];
const EXISTING = ["households", "profiles", "lotteries", "lottery_items", "applications", "purchases", "purchase_items", "card_masters", "card_holdings", "chains", "stores", "products", "collection_candidates", "collection_runs", "collection_settings", "zukan_cards", "market_cards", "box_lots", "profile_settings"];

// 存在しない表・列への select はエラーになる（HEAD要求は204を返すため、通常の取得で確認する）
const hasColumns = async (table, cols) => !(await db.from(table).select(cols.join(",")).limit(1)).error;
async function count(table) {
  const probe = await db.from(table).select("*").limit(1);
  if (probe.error) return { exists: false, count: null };
  const { count: c, error } = await db.from(table).select("*", { count: "exact", head: true });
  return error ? { exists: true, count: null } : { exists: true, count: c ?? 0 };
}

const snapshot = { at: new Date().toISOString(), target: isProd ? "production" : "local", migrations: {}, newTables: {}, existing: {} };
console.log("\n== マイグレーションの固有物（適用前は『なし』、適用後は『あり』）");
for (const [v, parts] of Object.entries(COLUMNS)) {
  let all = true;
  for (const [t, cols] of parts) all = all && (await hasColumns(t, cols));
  snapshot.migrations[v] = all;
  console.log(`  ${v}: ${all ? "あり" : "なし"}`);
}
console.log("\n== 新しい表の行数（適用直後は0。自律型を使い始めたら増える）");
for (const t of NEW_TABLES) {
  const r = await count(t);
  snapshot.newTables[t] = r;
  console.log(`  ${t}: ${r.exists ? `あり（${r.count}行）` : "なし"}`);
}
console.log("\n== 既存の主要な表の件数（適用の前後で変わらないこと）");
for (const t of EXISTING) {
  const r = await count(t);
  snapshot.existing[t] = r;
  console.log(`  ${t}: ${r.exists ? r.count : "（表なし）"}`);
}
if (snapshot.migrations["105"]) {
  const { data } = await db.from("collection_settings").select("collection_engine");
  const by = {};
  for (const r of data ?? []) by[r.collection_engine] = (by[r.collection_engine] ?? 0) + 1;
  snapshot.engines = by;
  console.log(`\n== 収集方式の設定: ${JSON.stringify(by)}（自律型を選ぶまで、すべて legacy が正常）`);
  if (Object.keys(by).some((k) => k !== "legacy")) console.log("  ※ legacy 以外の設定があります（利用者が選んだ場合を除き、異常）");
}
if (anon && NEW_TABLES.every((t) => snapshot.newTables[t].exists)) {
  const a = createClient(url, anon, { auth: { persistSession: false, autoRefreshToken: false } });
  for (const t of NEW_TABLES) {
    const { data } = await a.from(t).select("*").limit(1);
    console.log(`  RLS ${t}: 匿名で読めた行 ${data?.length ?? 0}（0が正常）`);
    if ((data?.length ?? 0) > 0) process.exitCode = 1;
  }
}
const snap = arg("snapshot");
if (snap) {
  mkdirSync(dirname(snap), { recursive: true });
  writeFileSync(snap, JSON.stringify(snapshot, null, 1));
  console.log(`\n件数を保存: ${snap}`);
}
const cmp = arg("compare");
if (cmp) {
  const before = JSON.parse(readFileSync(cmp, "utf8"));
  const diffs = EXISTING.filter((t) => before.existing[t]?.count !== snapshot.existing[t]?.count);
  console.log(`\n== 事前（${before.at}）との比較: 既存の表で件数が変わったもの ${diffs.length}件`);
  for (const t of diffs) console.log(`  - ${t}: ${before.existing[t]?.count} → ${snapshot.existing[t]?.count}（利用者の通常の操作・収集による変化か確認）`);
}
