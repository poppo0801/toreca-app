// 重複している系列を安全に統合する（削除なし。統合元は非表示にして残す）。
//
//   npm run merge:chains -- --from 古本市場 --into ふるいち            ドライラン（影響範囲の表示のみ。何も変更しない）
//   npm run merge:chains -- --from 古本市場 --into ふるいち --apply    実行（実行前に npm run backup を取ること）
//
// 実体は DB 関数 merge_chains（service_role 専用・トランザクション内）。付け替え先を決められない設定（応募ルール・応募条件・対象設定）や
// 会員番号の重複がある場合は、何も変更せず中止する。
import { createClient } from "@supabase/supabase-js";

try {
  process.loadEnvFile(".env.local");
} catch {
  /* 環境変数が既に設定されている場合 */
}

const args = process.argv.slice(2);
const arg = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const from = arg("--from");
const into = arg("--into");
const apply = args.includes("--apply");
if (!from || !into) {
  console.error("使い方: npm run merge:chains -- --from <統合元の系列名> --into <統合先の系列名> [--apply]");
  process.exit(1);
}

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !key) {
  console.error("Supabase の接続設定(.env.local)が見つかりません");
  process.exit(1);
}
const db = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });

const one = async (name) => {
  const { data, error } = await db.from("chains").select("id,name,household_id,archived_at").eq("name", name);
  if (error) throw new Error(error.message);
  if (!data || data.length !== 1) throw new Error(`系列「${name}」を一意に特定できません（${data?.length ?? 0}件）`);
  return data[0];
};

const count = async (table, col, id) => {
  const { count: n, error } = await db.from(table).select("id", { count: "exact", head: true }).eq(col, id);
  if (error) throw new Error(`${table}: ${error.message}`);
  return n ?? 0;
};

const f = await one(from);
const t = await one(into);
if (f.household_id !== t.household_id) throw new Error("別の世帯の系列同士は統合できません");

const summary = {};
for (const [label, table] of [["店舗", "stores"], ["抽選", "lotteries"], ["応募アカウント", "service_accounts"], ["応募ルール", "application_rules"], ["応募条件", "chain_requirements"], ["対象設定", "profile_target_rules"], ["キャンペーン", "campaigns"]]) {
  summary[label] = { 統合元: await count(table, "chain_id", f.id), 統合先: await count(table, "chain_id", t.id) };
}
console.log(`統合元: ${f.name}（${f.archived_at ? "非表示" : "表示中"}） → 統合先: ${t.name}`);
console.table(summary);

const { data: stores } = await db.from("stores").select("id,chain_id,name").in("chain_id", [f.id, t.id]);
const norm = (s) => s.normalize("NFKC").toLowerCase().replace(/\s+/g, "");
const targetNames = new Set((stores ?? []).filter((s) => s.chain_id === t.id).map((s) => norm(s.name)));
const same = (stores ?? []).filter((s) => s.chain_id === f.id && targetNames.has(norm(s.name))).map((s) => s.name);
console.log(`同名の店舗（統合先の店舗に寄せる）: ${same.join("、") || "なし"}`);

if (!apply) {
  console.log("\nドライランです。何も変更していません。実行するには --apply を付けてください。");
  process.exit(0);
}
const { data, error } = await db.rpc("merge_chains", { p_from: f.id, p_into: t.id });
if (error) {
  console.error(`統合を中止しました（何も変更されていません）: ${error.message}`);
  process.exit(1);
}
console.log("統合しました:", JSON.stringify(data));
