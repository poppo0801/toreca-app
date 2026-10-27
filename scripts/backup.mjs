// 論理バックアップ: トレカ専用プロジェクトの全テーブルをJSONで書き出す（復旧用ではなくデータ退避/CSV移行の下地）。
// DB全体の復旧用バックアップは Supabase のバックアップ機能（docs/backup-and-ops.md）を使う。
// 出力先 backups/ は個人データを含むため .gitignore 済み。service_role キーはこのスクリプトでのみ使用する。
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";

// ローカルでは .env.local、なければ環境変数から読む
try {
  process.loadEnvFile(".env.local");
} catch {
  /* 環境変数が既に設定されている場合 */
}
const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !key) throw new Error(".env.local に URL と SUPABASE_SERVICE_ROLE_KEY が必要です");

// 家計簿など別プロジェクトへ誤接続しないための照合（ローカルはリンク済みのプロジェクト、CIは EXPECTED_SUPABASE_PROJECT_REF）
const linked = (process.env.EXPECTED_SUPABASE_PROJECT_REF ?? (existsSync("supabase/.temp/project-ref") ? readFileSync("supabase/.temp/project-ref", "utf8") : "")).trim();
if (!linked) throw new Error("接続先の照合ができません（supabase link 済みか、EXPECTED_SUPABASE_PROJECT_REF が必要です）。中止します。");
if (!url.includes(linked)) throw new Error("接続先がリンク済みのトレカ専用プロジェクトと一致しません。中止します。");

// push_subscriptions は購読鍵を含むためバックアップ対象外（端末で通知を有効にし直せば復元できる）
const TABLES = [
  "households", "household_members", "profiles", "chains", "stores", "products", "product_aliases",
  "product_prices", "family_groups", "address_groups", "identities", "service_accounts",
  "profile_target_rules", "campaigns", "lotteries", "lottery_items", "lottery_management", "applications",
  "purchases", "purchase_items", "skip_rules", "skip_rule_exceptions", "application_rules", "limit_exemptions",
  "chain_requirements", "account_eligibilities", "eligibility_purchases", "notification_settings", "notification_deliveries", "audit_logs",
  "application_item_results", "sales",
];

const supabase = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
// 出力先は BACKUP_OUT_DIR（local-backup.mjs が一時ディレクトリを指定。平文は暗号化後に削除される）。既定は backups/
const dir = `${process.env.BACKUP_OUT_DIR ?? "backups"}/${stamp}`;
mkdirSync(dir, { recursive: true });

const counts = {};
const sha256 = {};
for (const table of TABLES) {
  const rows = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await supabase.from(table).select("*").order({ household_members: "user_id", lottery_management: "lottery_id" }[table] ?? "id").range(from, from + 999);
    if (error) throw new Error(`${table}: ${error.message}`);
    rows.push(...data);
    if (data.length < 1000) break;
  }
  const body = JSON.stringify(rows, null, 2);
  writeFileSync(`${dir}/${table}.json`, body);
  counts[table] = rows.length;
  sha256[table] = createHash("sha256").update(body).digest("hex"); // 破損・改変の検出用（verify-backup.mjs）
}
writeFileSync(`${dir}/_manifest.json`, JSON.stringify({ createdAt: new Date().toISOString(), project: linked, counts, sha256 }, null, 2));
console.log(`バックアップ完了: ${dir}`);
console.table(counts);
