// JUDGMENT_IDENTITY_EFFICIENCY: 評価と本番の入力を揃えるため、本番の商品マスターの名前（公開の商品名だけ）を書き出す（本番・読み取りのみ）。
//   npm run prod -- scripts/product-master-export.mjs --yes-production   → eval/intensive/products.local.json（Git管理外）
import { writeFileSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";
import { assertProductionTarget } from "./lib/target.mjs";

assertProductionTarget("product-master-export.mjs");
const db = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
const r = await db.from("products").select("official_name,created_at").order("created_at", { ascending: false }).limit(200);
if (r.error) throw new Error(r.error.message);
writeFileSync("eval/intensive/products.local.json", JSON.stringify({ at: new Date().toISOString(), names: r.data.map((x) => ({ name: x.official_name, createdAt: x.created_at })) }, null, 1));
console.log(`商品名 ${r.data.length} 件を書き出しました`);
