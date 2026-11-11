// カードボックス「所属未確認」系列の廃止（Stage 7S）。
//   node scripts/retire-unconfirmed-cardbox.mjs            調査のみ（既定）
//   node scripts/retire-unconfirmed-cardbox.mjs --execute  バックアップを作り、参照が無ければ削除、あればアーカイブ
// 参照が残っている場合は移さない（所属は推測しない）。店舗・抽選は 7R の所属確定で直営へ移行済みであることを確認する。
import { createClient } from "@supabase/supabase-js";
import { mkdirSync, writeFileSync } from "node:fs";
try { process.loadEnvFile(".env.local"); } catch { /* */ }
const db = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
const execute = process.argv.includes("--execute");
const { data: chains } = await db.from("chains").select("*").eq("operation_kind", "unconfirmed");
if (!chains?.length) { console.log("所属未確認の系列はありません"); process.exit(0); }
const TABLES = ["stores", "lotteries", "campaigns", "service_accounts", "account_eligibilities", "member_numbers", "purchases", "box_lots", "box_receipts", "application_rules", "chain_requirements", "chain_conditions", "profile_target_rules", "skip_rules", "collection_exclusions", "collection_hard_sources", "collection_memos", "x_account_links", "x_account_identities", "store_trip_distances", "chain_aliases", "collection_candidates"];
mkdirSync("backups", { recursive: true });
for (const c of chains) {
  const counts = {}; const rows = {};
  for (const t of TABLES) {
    const { data, error } = await db.from(t).select("*").eq("chain_id", c.id).limit(1000);
    if (error) { counts[t] = `?(${error.message.slice(0, 40)})`; continue; }
    counts[t] = data.length; if (data.length) rows[t] = data;
  }
  // 応募記録は応募アカウント経由
  const sa = rows.service_accounts?.map((s) => s.id) ?? [];
  const apps = sa.length ? (await db.from("applications").select("id").in("service_account_id", sa)).data?.length ?? 0 : 0;
  console.log(`系列 ${c.name} (${c.id.slice(0, 8)}) archived=${c.archived_at ?? "なし"} 参照:`, JSON.stringify(Object.fromEntries(Object.entries(counts).filter(([, v]) => v !== 0))), `応募${apps}`);
  const blocking = Object.entries(counts).filter(([k, v]) => v !== 0 && !["chain_aliases", "service_accounts", "collection_candidates"].includes(k));
  const candRefs = counts.collection_candidates;
  if (blocking.length || apps > 0) { console.log("  → 履歴からの参照があるため、削除せずアーカイブ（または手動判断）"); }
  if (!execute) continue;
  const file = `backups/retire-unconfirmed-cardbox-${new Date().toISOString().replace(/[:.]/g, "-")}.json`;
  writeFileSync(file, JSON.stringify({ chain: c, rows }, null, 1));
  if (blocking.length || apps > 0 || (typeof candRefs === "number" && candRefs > 0)) {
    const r = await db.from("chains").update({ archived_at: new Date().toISOString() }).eq("id", c.id);
    console.log(r.error ? `  アーカイブ失敗: ${r.error.message}` : `  アーカイブしました（バックアップ ${file}）`);
  } else {
    await db.from("service_accounts").delete().eq("chain_id", c.id);
    await db.from("chain_aliases").delete().eq("chain_id", c.id);
    const r = await db.from("chains").delete().eq("id", c.id);
    console.log(r.error ? `  削除失敗: ${r.error.message}` : `  削除しました（バックアップ ${file}）`);
  }
}
if (!execute) console.log("調査のみ。--execute で実行します");
