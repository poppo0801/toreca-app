// 共通ブランド（カードボックス）の店舗を、所属が確認できた系列（直営/その他）へ移す（Stage 7R）。
//   node scripts/move-brand-store.mjs --store <店舗IDの先頭> --to direct|other            調査のみ（既定）
//   node scripts/move-brand-store.mjs --store <店舗IDの先頭> --to direct|other --execute  バックアップを作って実行
// 所属は人が公式情報で確認した結果を指定する（推測で移さない）。店舗と、その店舗の抽選の系列IDを移す。削除はしない。
import { createClient } from "@supabase/supabase-js";
import { mkdirSync, writeFileSync } from "node:fs";
try { process.loadEnvFile(".env.local"); } catch { /* */ }
const db = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
const arg = (k) => { const i = process.argv.indexOf(k); return i >= 0 ? process.argv[i + 1] : null; };
const sid = arg("--store"), to = arg("--to"), execute = process.argv.includes("--execute");
if (!sid || !["direct", "other"].includes(to ?? "")) { console.error("--store <ID先頭> --to direct|other を指定してください"); process.exit(1); }
const { data: chains } = await db.from("chains").select("id,name,household_id,brand_group,operation_kind").not("brand_group", "is", null);
const target = chains.find((c) => c.operation_kind === to);
const { data: stores } = await db.from("stores").select("id,name,chain_id,household_id").like("id", `${sid}%`);
if (!target || stores?.length !== 1) { console.error("移し先の系列、または店舗を一意に特定できません"); process.exit(1); }
const st = stores[0];
const from = chains.find((c) => c.id === st.chain_id);
if (!from?.brand_group || from.brand_group !== target.brand_group || from.household_id !== target.household_id) { console.error("同じブランドの系列間の移動だけ可能です"); process.exit(1); }
const { data: lots } = await db.from("lotteries").select("*").eq("store_id", st.id);
const { data: dupName } = await db.from("stores").select("id").eq("chain_id", target.id).eq("name", st.name);
console.log(`店舗 ${st.name}（${from.name} → ${target.name}）／抽選${lots.length}件／移し先に同名の店舗: ${dupName.length}件`);
if (dupName.length > 0) { console.error("移し先に同名の店舗があるため中止（統合は別途判断）"); process.exit(1); }
if (!execute) { console.log("調査のみ。--execute で実行します"); process.exit(0); }
mkdirSync("backups", { recursive: true });
const file = `backups/move-brand-store-${new Date().toISOString().replace(/[:.]/g, "-")}.json`;
writeFileSync(file, JSON.stringify({ store: st, lotteries: lots }, null, 1));
const a = await db.from("stores").update({ chain_id: target.id }).eq("id", st.id);
if (a.error) throw new Error(a.error.message);
if (lots.length) { const b = await db.from("lotteries").update({ chain_id: target.id }).eq("store_id", st.id); if (b.error) throw new Error(b.error.message); }
console.log(`完了（バックアップ ${file}）。元に戻す場合は店舗と抽選の chain_id を ${from.id} に戻す`);
