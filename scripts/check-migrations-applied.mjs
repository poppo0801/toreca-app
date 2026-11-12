// 本番に 094〜098 が適用済みかを、読み取り専用で確認する（Stage 8E-1。何も書き込まない）。
//   npm run prod -- scripts/check-migrations-applied.mjs --yes-production
// 各マイグレーションに固有の「表・列・関数」の存在を確認する（ファイルは1つのトランザクションなので、固有物が揃えば全体が適用済み）。
import { createClient } from "@supabase/supabase-js";

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
const db = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
const results = [];
const ok = (name, cond, detail = "") => {
  results.push(cond);
  console.log(`${cond ? "✅" : "❌"} ${name}${detail ? ` — ${detail}` : ""}`);
};

// 列の存在: 存在しない列を select すると PostgREST がエラーを返す
const hasColumns = async (table, cols) => {
  const { error } = await db.from(table).select(cols.join(",")).limit(1);
  return !error;
};
ok("094: store_location_research", await hasColumns("store_location_research", ["id", "household_id"]));
ok("095: store_location_research.official_sites", await hasColumns("store_location_research", ["official_sites"]));
ok("096: store_location_proposals / store_location_proposal_events", (await hasColumns("store_location_proposals", ["id"])) && (await hasColumns("store_location_proposal_events", ["id"])));
ok("097: lottery_bulk_groups の新しい列（title/origin/basis/dissolved_at/updated_at）", await hasColumns("lottery_bulk_groups", ["title", "origin", "basis", "dissolved_at", "updated_at"]));
ok("097: lottery_exclusions / lottery_group_events", (await hasColumns("lottery_exclusions", ["id"])) && (await hasColumns("lottery_group_events", ["id"])));
ok("098: lottery_operations", await hasColumns("lottery_operations", ["op_id", "params_hash", "result"]));

// 関数: PostgREST の OpenAPI（公開されている rpc の一覧）で確認する
const res = await fetch(`${url}/rest/v1/`, { headers: { apikey: key, Authorization: `Bearer ${key}` } });
const spec = await res.json();
const rpcs = new Set(Object.keys(spec.paths ?? {}).filter((p) => p.startsWith("/rpc/")).map((p) => p.slice(5)));
const need = {
  "096": ["propose_store_location", "decide_store_location_proposal", "apply_store_location_proposal", "revert_store_location_proposal"],
  "097": ["exclude_lottery_tx", "group_lotteries_tx", "ungroup_lottery_tx", "dissolve_lottery_group_tx", "duplicate_lottery_tx"],
  "098": ["lottery_op_result", "duplicate_lottery_op_tx", "save_lottery_and_duplicate_tx"],
};
for (const [v, names] of Object.entries(need)) {
  const missing = names.filter((n) => !rpcs.has(n));
  ok(`${v}: 関数 ${names.length}個`, missing.length === 0, missing.length ? `欠落: ${missing.join(",")}` : "");
}
// 匿名（ログインなし）からは、新しい表のデータが1行も読めないこと（RLS・権限）
const anon = createClient(url, process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
for (const t of ["store_location_research", "store_location_proposals", "store_location_proposal_events", "lottery_exclusions", "lottery_group_events", "lottery_operations", "lottery_bulk_groups"]) {
  const { data, error } = await anon.from(t).select("*").limit(1);
  ok(`匿名は ${t} を読めない`, !!error || (data ?? []).length === 0, error ? `拒否（${error.code ?? error.message}）` : "0行");
}
console.log(results.every(Boolean) ? "\n✅ 094〜098 は適用済みです" : "\n❌ 未適用または不完全な項目があります");
process.exit(results.every(Boolean) ? 0 : 1);
