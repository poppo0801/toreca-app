// 収録パックマスターの更新: data/expansion-master.json（scripts/build-expansion-master.mjs の取得結果）→ expansion_marks へ**不足分を追加**する。既定は dry-run。
//
//   node scripts/build-expansion-master.mjs            # 新商品だけを公式サイトから取得（取得済みは再取得しない・上限150回・1.5秒間隔・連続失敗3回で停止）
//   node scripts/sync-expansion-master.mjs             # 追加される行を表示（DBは変更しない）
//   node scripts/sync-expansion-master.mjs --execute   # 追加（既存の行は変更しない。マスターは参照データで、利用者の記録には触れない）
//   本番: npm run prod -- scripts/sync-expansion-master.mjs --execute --yes-production
// 新商品の公開に合わせて月1回程度・手動または承認済みの定期実行で行う（無制限の巡回はしない）。
import { createClient } from "@supabase/supabase-js";
import { readFileSync } from "node:fs";
import { toRows } from "./lib/expansion-master.mjs";
import { assertTargetForRun } from "./lib/target.mjs";

try {
  process.loadEnvFile(".env.local");
} catch {
  /* 環境変数が既に設定されている場合 */
}
assertTargetForRun("sync-expansion-master.mjs");
const db = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
const execute = process.argv.includes("--execute");
const rows = toRows(JSON.parse(readFileSync("data/expansion-master.json", "utf8")));
const have = await db.from("expansion_marks").select("mark,product_id").limit(5000);
if (have.error) throw new Error(JSON.stringify(have.error));
const known = new Set(have.data.map((r) => `${r.mark}|${r.product_id}`));
const add = rows.filter((r) => !known.has(`${r.mark}|${r.productId}`));
console.log(`取得結果 ${rows.length}行 / 登録済み ${have.data.length}行 / 追加 ${add.length}行`);
for (const r of add) console.log(`  + ${r.mark}  ${r.productName}（${r.kind}${r.active ? "" : "・候補に出さない"}）`);
if (!execute || add.length === 0) {
  console.log(execute ? "追加するものはありません。" : "dry-run のため変更していません（--execute で追加）。");
  process.exit(0);
}
const ins = await db.from("expansion_marks").insert(
  add.map((r) => ({ mark: r.mark, product_id: r.productId, product_name: r.productName, set_name: r.setName, series: r.series, kind: r.kind, active: r.active, source: "公式サイト カード検索", source_url: "https://www.pokemon-card.com/card-search/", last_confirmed_on: r.confirmedOn })),
);
if (ins.error) throw new Error(JSON.stringify(ins.error));
console.log(`追加しました: ${add.length}行`);
