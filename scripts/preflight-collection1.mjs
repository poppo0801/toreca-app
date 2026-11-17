// Stage Release-1: Collection-1（151図鑑・相場調査メモ）の本番反映の事前確認・適用後確認（**読み取り専用**。何も書き込まない）。
//   本番:   npm run prod -- scripts/preflight-collection1.mjs --yes-production [--snapshot=<保存先.json>] [--compare=<事前の.json>]
//   開発DB: node scripts/preflight-collection1.mjs
// 確認: ①新しい5表の有無（適用前は「なし」、適用後は「あり・0件」）②既存の主要な表の件数（適用の前後で変わっていないこと）
//       ③新しい表の行数（適用直後は0。ユーザーが使い始めたら増える）④RLS（匿名では読めない）
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

const NEW_TABLES = ["zukan_cards", "zukan_price_records", "market_cards", "market_prices", "market_purchases"];
const EXISTING = ["households", "profiles", "lotteries", "lottery_items", "applications", "purchases", "purchase_items", "card_masters", "card_holdings", "card_prices", "card_favorites", "chains", "stores", "products", "collection_candidates", "box_lots", "profile_settings"];

// 注意: 存在しない表への HEAD 要求はエラーにならない（204）ため、先に通常の取得（GET）で存在を確認する
async function count(table) {
  const probe = await db.from(table).select("*").limit(1);
  if (probe.error) return { exists: false, count: null, error: probe.error.code ?? probe.error.message };
  const { count: c, error } = await db.from(table).select("*", { count: "exact", head: true });
  return error ? { exists: true, count: null, error: error.code } : { exists: true, count: c ?? 0 };
}

const snapshot = { at: new Date().toISOString(), target: isProd ? "production" : "local", newTables: {}, existing: {} };
console.log("\n== 新しい5表（適用前は『なし』、適用後は『あり』）");
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
// RLS: 匿名では新しい表を読めない（表があるとき）
if (anon && NEW_TABLES.every((t) => snapshot.newTables[t].exists)) {
  const a = createClient(url, anon, { auth: { persistSession: false, autoRefreshToken: false } });
  for (const t of NEW_TABLES) {
    const { data } = await a.from(t).select("id").limit(1);
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
  for (const t of diffs) console.log(`  - ${t}: ${before.existing[t]?.count} → ${snapshot.existing[t]?.count}（利用者の通常の操作による変化か確認）`);
}
