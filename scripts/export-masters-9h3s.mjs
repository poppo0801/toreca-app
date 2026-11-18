// Stage 9H-3S: マスター・抽選・抽選候補の実態分析用の書き出し（**読み取り専用**。何も書き込まない）。
//   本番:   npm run prod -- scripts/export-masters-9h3s.mjs --yes-production
//   開発DB: node scripts/export-masters-9h3s.mjs
// 出力: backups/masters-9h3s/snapshot-<日時>.json（Git管理外）。個人情報（会員番号・住所・メモ・アカウント名）は含めない。
// 目的: 重複マスター・名寄せの対象・一括再評価の対象件数を、オフラインで分析する（分析は src/lib/master-identity/ のテストで行う）。
import { createClient } from "@supabase/supabase-js";
import { mkdirSync, writeFileSync } from "node:fs";

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
if (!url || !key) throw new Error("接続先の設定がありません。中止します。");
const local = /^http:\/\/(127\.0\.0\.1|localhost)/.test(url);
if (!isProd && !local) throw new Error("本番への接続は npm run prod 経由のみです。中止します。");
console.log(`接続先: ${isProd ? "本番（読み取り専用）" : "ローカル開発DB"}`);
const db = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });

async function all(table, cols, orderBy = "id") {
  const out = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await db.from(table).select(cols).order(orderBy).range(from, from + 999);
    if (error) {
      console.log(`  ! ${table}: ${error.message}`);
      return null;
    }
    out.push(...data);
    if (data.length < 1000) break;
  }
  return out;
}

const snap = { exportedAt: new Date().toISOString(), target: isProd ? "production" : "local" };
snap.chains = await all("chains", "id,household_id,name,is_provisional,archived_at,created_at,brand_group");
snap.chain_aliases = await all("chain_aliases", "id,chain_id,alias,created_at");
snap.stores = await all("stores", "id,chain_id,name,prefecture,is_provisional,archived_at,sales_kind,created_at");
snap.products = await all("products", "id,official_name,product_code,release_date,category,is_provisional,archived_at,created_at,packs_per_box");
snap.product_aliases = await all("product_aliases", "id,product_id,alias,created_at");
snap.lotteries = await all(
  "lotteries",
  "id,chain_id,store_id,source_kind,registration_path,confirmed_at,archived_at,exclusion_reason_code,apply_deadline_at,apply_deadline_date,apply_start_at,apply_start_date,result_date,result_at,store_mode,lottery_kind,event_state,auto_dedupe_key,created_at,updated_at,updated_by_profile_id,unconfirmed_fields,source_urls,bulk_group_id,lottery_form,campaign_id",
);
snap.lottery_items = await all("lottery_items", "id,lottery_id,product_id,quantity,unit");
snap.lottery_management = await all("lottery_management", "lottery_id,is_managed,managed_source,managed_at,reviewed_at,updated_by_profile_id", "lottery_id");
snap.applications = await all("applications", "id,lottery_id,state,result_status,origin,fulfillment_status,selected_item_id");
snap.collection_candidates = await all("collection_candidates", "id,status,job_state,kind,title,lottery_id,triage,manual_state,due_at,created_at,reasons,source_url,draft,dedupe_key");
snap.collection_settings = await all("collection_settings", "id,prefectures,include_online,product_mode,product_ids,max_distance_km");
snap.purchase_items = await all("purchase_items", "id,product_id");
snap.sales = await all("sales", "id,product_id");
snap.box_lots = await all("box_lots", "id,product_id");
snap.card_masters = await all("card_masters", "id,product_id");
snap.chain_merge_history = await all("chain_merge_history", "id,from_chain_id,into_chain_id,merged_at");
snap.product_merge_history = await all("product_merge_history", "id,from_product_id,into_product_id,merged_at");

// 外側の参照: 通知・ルール・メモなど抽選を参照する表（件数のみ）
snap.lottery_refs = {};
for (const t of ["limit_exemptions", "skip_rules", "skip_rule_exceptions", "collection_memos", "notification_deliveries", "application_rules", "ai_extraction_feedback"]) {
  const rows = await all(t, "id,lottery_id");
  if (rows) {
    const m = {};
    for (const r of rows) if (r.lottery_id) m[r.lottery_id] = (m[r.lottery_id] ?? 0) + 1;
    snap.lottery_refs[t] = m;
  }
}

mkdirSync("backups/masters-9h3s", { recursive: true });
const file = `backups/masters-9h3s/snapshot-${isProd ? "prod" : "local"}-${new Date().toISOString().replace(/[:.]/g, "-")}.json`;
writeFileSync(file, JSON.stringify(snap));
const n = (k) => (Array.isArray(snap[k]) ? snap[k].length : "取得失敗");
console.log(`保存: ${file}`);
console.log(`系列 ${n("chains")}（別名 ${n("chain_aliases")}）／店舗 ${n("stores")}／商品 ${n("products")}（別名 ${n("product_aliases")}）／抽選 ${n("lotteries")}／明細 ${n("lottery_items")}／応募 ${n("applications")}／候補 ${n("collection_candidates")}`);
