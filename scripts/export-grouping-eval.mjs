// 抽選グループ判定の実データ評価用の入力・正解の書き出し（読み取り専用。Stage 8F-2）。
//   npm run prod -- scripts/export-grouping-eval.mjs --yes-production --out=eval/lottery-grouping-real [--max=30]
// 本番DBは読むだけ（何も書き込まない）。正解の根拠は利用者自身の手動のグループ化・手動の分離だけ（AIの判定結果は使わない）。
// 出力: <out>/cases.json（入力）・<out>/gold.json（正解。AIに渡さない）。抽選IDは連番に置換し、住所・個人情報・鍵は含まない。
// 取得するのは評価に必要な項目だけ（応募・当選の記録、利用者・世帯の情報、認証情報は読まない）。書き出した後、内容を確認してから凍結（npm run eval:grouping-real -- freeze）→ 承認 → 実行の順に進める。
import { mkdirSync, writeFileSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";
import { buildCases, textsOfDraft } from "./lib/grouping-eval-export.mjs";

const arg = (k) => process.argv.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3);
const out = arg("out");
if (!out) throw new Error("--out が必要です");
const max = Number(arg("max") ?? 30);

const db = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
const all = async (table, cols, f = (q) => q) => {
  const rows = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await f(db.from(table).select(cols)).range(from, from + 999);
    if (error) throw error;
    rows.push(...data);
    if (data.length < 1000) break;
  }
  return rows;
};
const LOT = "id,chain_id,store_id,store_mode,campaign_id,apply_start_precision,apply_start_date,apply_start_at,apply_deadline_precision,apply_deadline_date,apply_deadline_at,result_precision,result_date,result_at,apply_method,receive_method,requirement_tags,conditions_text,source_urls,bulk_group_id,archived_at,created_at";
const lotteries = await all("lotteries", LOT);
const ids = lotteries.map((l) => l.id);
const chunks = (a, n = 200) => Array.from({ length: Math.ceil(a.length / n) }, (_, i) => a.slice(i * n, i * n + n));
const byIds = async (table, cols, col, list) => (await Promise.all(chunks(list).map(async (c) => (await db.from(table).select(cols).in(col, c)).data ?? []))).flat();

const items = await byIds("lottery_items", "lottery_id,product_id,quantity", "lottery_id", ids);
const products = await all("products", "id,official_name");
const stores = await all("stores", "id,name");
const chains = await all("chains", "id,name");
const groups = await all("lottery_bulk_groups", "id,origin,chain_id,title", (q) => q.is("dissolved_at", null));
const events = (await all("lottery_group_events", "lottery_id,detail,action,origin")).filter((e) => e.action === "removed" && e.origin === "manual");
const cands = await byIds("collection_candidates", "lottery_id,draft", "lottery_id", ids);
const evidenceByLottery = {};
for (const c of cands) if (c.lottery_id) evidenceByLottery[c.lottery_id] = [...(evidenceByLottery[c.lottery_id] ?? []), ...textsOfDraft(c.draft)].slice(0, 6);

const result = buildCases({
  lotteries, items, groups, events, evidenceByLottery,
  productNames: Object.fromEntries(products.map((p) => [p.id, p.official_name])),
  storeNames: Object.fromEntries(stores.map((s) => [s.id, s.name])),
  chainNames: Object.fromEntries(chains.map((c) => [c.id, c.name])),
  applied: [],
  now: new Date().toISOString(),
}, { max, pool: process.argv.includes("--pool") });
if (process.argv.includes("--pool")) {
  mkdirSync(out, { recursive: true });
  writeFileSync(out + "/pool.json", JSON.stringify({ note: "候補の洗い出し用（正解なし）", pool: result.pool }, null, 2) + "\n");
  console.log(result.pool.length + " 件の抽選を pool.json に書き出しました");
  process.exit(0);
}

const { cases, gold } = result;
mkdirSync(out, { recursive: true });
writeFileSync(`${out}/cases.json`, JSON.stringify({ version: 1, note: "実データ評価の入力（本番の記録を読み取り専用で書き出し）。正解は含まない", cases }, null, 2) + "\n");
writeFileSync(`${out}/gold.json`, JSON.stringify({ version: 1, note: "正解。AIに渡さない（採点だけが読む）。根拠は利用者の手動のグループ化・手動の分離", labels: gold }, null, 2) + "\n");
const byCat = {};
for (const c of cases) byCat[c.category] = (byCat[c.category] ?? 0) + 1;
console.log(`${cases.length} 件を ${out} に書き出しました`, byCat);
