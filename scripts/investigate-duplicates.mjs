// 抽選の重複調査（読み取り専用。Stage 7P）。系列・店舗・商品が同じ抽選を、日付・情報元に関係なく列挙する。
//   node scripts/investigate-duplicates.mjs
import { createClient } from "@supabase/supabase-js";

try {
  process.loadEnvFile(".env.local");
} catch {
  /* 環境変数が既に設定されている場合 */
}
const db = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
const all = async (t, sel, f = (q) => q) => {
  const out = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await f(db.from(t).select(sel)).range(from, from + 999);
    if (error) throw new Error(`${t}: ${error.message}`);
    out.push(...data);
    if (data.length < 1000) break;
  }
  return out;
};
const [L, IT, CH, ST, PR, AP, MG] = await Promise.all([
  all("lotteries", "*", (q) => q.is("archived_at", null)),
  all("lottery_items", "lottery_id,product_id,quantity,unit"),
  all("chains", "id,name"),
  all("stores", "id,name,sales_kind,is_provisional,chain_id"),
  all("products", "id,official_name"),
  all("applications", "lottery_id,state,result_status"),
  all("lottery_management", "lottery_id,is_managed"),
]);
const nm = (s) => (s ?? "").normalize("NFKC").replace(/[\s　]+/g, "").toLowerCase();
const chainName = (id) => CH.find((c) => c.id === id)?.name ?? "";
const store = (id) => ST.find((s) => s.id === id);
const prod = (id) => PR.find((p) => p.id === id)?.official_name ?? id.slice(0, 6);
const items = {};
for (const x of IT) (items[x.lottery_id] ??= []).push(x.product_id);
const apps = {};
for (const a of AP) (apps[a.lottery_id] ??= []).push(`${a.state}/${a.result_status}`);
const mg = new Map(MG.map((m) => [m.lottery_id, m.is_managed]));
const jst = (l) => (l.apply_deadline_at ? new Date(new Date(l.apply_deadline_at).getTime() + 9 * 3600e3).toISOString().slice(0, 10) : (l.apply_deadline_date ?? "-"));
const day = (iso) => (iso ? new Date(new Date(iso).getTime() + 9 * 3600e3).toISOString().slice(0, 16).replace("T", " ") : "-");

// (系列, 店舗, 商品) の組ごとに分類
const byKey = {};
for (const l of L) for (const p of items[l.id] ?? []) {
  const k = `${nm(chainName(l.chain_id))}|${l.store_id ?? "null"}|${p}`;
  (byKey[k] ??= []).push(l);
}
const seen = new Set();
const groups = [];
for (const [k, ls] of Object.entries(byKey)) {
  if (ls.length < 2) continue;
  const id = ls.map((l) => l.id).sort().join(",");
  if (seen.has(id)) continue;
  seen.add(id);
  groups.push({ k, ls });
}
console.log(`有効な抽選: ${L.length} / 系列・店舗・商品が同じ組: ${groups.length}`);
for (const g of groups) {
  const [chain, sid, pid] = g.k.split("|");
  const s = store(sid);
  console.log(`\n■ ${chainName(g.ls[0].chain_id)} / ${s ? s.name : "(店舗なし)"}${s?.is_provisional ? "(仮)" : ""} / ${prod(pid)}`);
  for (const l of g.ls) {
    const its = (items[l.id] ?? []).map(prod).join(" + ");
    console.log(`  ${l.id.slice(0, 6)} ${l.source_kind} mode=${l.store_mode} 応募開始${day(l.apply_start_at)} 締切${jst(l)} 作成${day(l.created_at)} 情報元${(l.source_urls ?? []).length} 応募${(apps[l.id] ?? []).join(",") || "なし"} ★${mg.get(l.id) ? "1" : "0"} 手動修正${l.updated_by_profile_id ? "1" : "0"} 商品[${its}]`);
  }
}
