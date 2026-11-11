// 系列ID・店舗IDの整合性チェック（読み取り専用。Stage 7R）。抽選の系列と店舗の系列が一致しているか、共通ブランドの系列の所属を確認する。
import { createClient } from "@supabase/supabase-js";
try { process.loadEnvFile(".env.local"); } catch { /* */ }
const db = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
const all = async (t, sel) => { const out = []; for (let from = 0; ; from += 1000) { const { data, error } = await db.from(t).select(sel).range(from, from + 999); if (error) throw new Error(`${t}: ${error.message}`); out.push(...data); if (data.length < 1000) break; } return out; };
const [CH, ST, LO, AP] = await Promise.all([all("chains", "id,name,brand_group,operation_kind,archived_at"), all("stores", "id,chain_id,name,archived_at"), all("lotteries", "id,chain_id,store_id,archived_at"), all("applications", "id,lottery_id,applied_store_id")]);
const stById = new Map(ST.map((s) => [s.id, s]));
const chIds = new Set(CH.map((c) => c.id));
const bad = LO.filter((l) => l.store_id && stById.get(l.store_id)?.chain_id !== l.chain_id);
console.log(`系列${CH.length} 店舗${ST.length} 抽選${LO.length} 応募${AP.length}`);
console.log(`抽選の系列と店舗の系列が不一致: ${bad.length}件`, bad.map((l) => l.id.slice(0, 8)).join(","));
console.log(`存在しない系列を指す店舗: ${ST.filter((s) => !chIds.has(s.chain_id)).length}件 / 抽選: ${LO.filter((l) => !chIds.has(l.chain_id)).length}件`);
const lotById = new Map(LO.map((l) => [l.id, l]));
const apBad = AP.filter((a) => a.applied_store_id && lotById.get(a.lottery_id) && stById.get(a.applied_store_id) && stById.get(a.applied_store_id).chain_id !== lotById.get(a.lottery_id).chain_id);
console.log(`応募店舗の系列が抽選の系列と異なる: ${apBad.length}件`);
const names = new Map(); for (const c of CH.filter((c) => !c.archived_at)) names.set(c.name, [...(names.get(c.name) ?? []), c.id]);
console.log("同名の有効な系列:", [...names].filter(([, v]) => v.length > 1).map(([k, v]) => `${k}×${v.length}`).join(",") || "なし");
for (const c of CH.filter((c) => c.brand_group)) {
  const ss = ST.filter((s) => s.chain_id === c.id && !s.archived_at); const ls = LO.filter((l) => l.chain_id === c.id && !l.archived_at);
  console.log(`ブランド系列 ${c.name} [${c.operation_kind}] 店舗${ss.length}(${ss.map((s) => s.name).join("/")}) 有効な抽選${ls.length}`);
}
