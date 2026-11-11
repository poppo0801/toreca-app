// Stage 7S 調査（読み取り専用）: オンライン店舗・所在地未登録・所属未確認系列の参照
import { createClient } from "@supabase/supabase-js";
try { process.loadEnvFile(".env.local"); } catch { /* */ }
const db = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
const all = async (t, sel) => { const out = []; for (let from = 0; ; from += 1000) { const { data, error } = await db.from(t).select(sel).range(from, from + 999); if (error) throw new Error(`${t}: ${error.message}`); out.push(...data); if (data.length < 1000) break; } return out; };
const [CH, ST, LO, AP] = await Promise.all([all("chains", "id,name,brand_group,operation_kind,archived_at"), all("stores", "id,chain_id,name,sales_kind,prefecture,address_optional,latitude,longitude,geo_status,is_provisional,archived_at,store_url"), all("lotteries", "id,chain_id,store_id,store_mode,archived_at"), all("applications", "id,lottery_id,applied_store_id")]);
const chName = new Map(CH.map((c) => [c.id, c.name]));
const ON = /通販|オンライン|ネットショップ|公式サイト|online|ネット/i;
const act = ST.filter((s) => !s.archived_at);
console.log(`系列${CH.length} 店舗${ST.length}(有効${act.length})`);
console.log("\n== オンライン系の店舗 ==");
for (const s of act.filter((s) => ON.test(s.name) || s.sales_kind !== "physical")) {
  const nl = LO.filter((l) => l.store_id === s.id).length, na = AP.filter((a) => a.applied_store_id === s.id).length;
  console.log(`${chName.get(s.chain_id)} | ${s.name} | ${s.sales_kind} | 抽選${nl} 応募${na} | ${s.id.slice(0,8)}`);
}
console.log("\n== 所在地 ==");
const phys = act.filter((s) => s.sales_kind !== "online_only" && !ON.test(s.name) && s.name !== "応募時に店舗選択" && !/未確認|未定/.test(s.name));
const noAddr = phys.filter((s) => !s.address_optional), addrNoGeo = phys.filter((s) => s.address_optional && s.latitude == null), full = phys.filter((s) => s.latitude != null);
console.log(`実店舗${phys.length}: 座標あり${full.length} / 住所あり座標なし${addrNoGeo.length} / 住所なし${noAddr.length}`);
console.log("geo_status:", Object.entries(phys.reduce((m, s) => (m[s.geo_status] = (m[s.geo_status] ?? 0) + 1, m), {})).join(","));
for (const s of phys.filter((s) => s.latitude == null)) console.log(`${chName.get(s.chain_id)} | ${s.name} | pref=${s.prefecture} | addr=${s.address_optional} | ${s.geo_status} | ${s.id.slice(0,8)}`);
console.log("\n== 所属未確認系列 ==");
for (const c of CH.filter((c) => c.operation_kind === "unconfirmed")) console.log(c.id, c.name, "archived=", c.archived_at, "店舗", ST.filter((s) => s.chain_id === c.id).length, "抽選", LO.filter((l) => l.chain_id === c.id).length);
