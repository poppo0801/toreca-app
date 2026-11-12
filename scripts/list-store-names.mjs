// 店舗名の一覧（読み取り専用。Stage 8D-5: 未知の評価対象を選ぶため）。系列ごとに、店舗名と「住所の登録の有無」だけを出す（住所そのものは出さない）。
//   npm run prod -- scripts/list-store-names.mjs --yes-production
import { createClient } from "@supabase/supabase-js";

const db = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
const { data: stores, error } = await db.from("stores").select("name,prefecture,address_optional,chain_id,sales_kind,store_url,archived_at").is("archived_at", null).neq("sales_kind", "online_only").limit(3000);
if (error) throw error;
const { data: chains } = await db.from("chains").select("id,name");
const by = new Map();
for (const s of stores) {
  const c = (chains ?? []).find((x) => x.id === s.chain_id)?.name ?? "?";
  by.set(c, [...(by.get(c) ?? []), `${s.name}${s.address_optional ? "" : "*"}`]);
}
console.log(`実店舗 ${stores.length} 件（*=住所未登録）`);
for (const [c, l] of [...by].sort((a, b) => b[1].length - a[1].length)) console.log(`[${c}] ${l.length}: ${l.join(" / ")}`);
