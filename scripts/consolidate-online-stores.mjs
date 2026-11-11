// オンライン店舗の統一（Stage 7S）。同じ系列内の「オンライン」「通販」「通販店」などを1店舗（標準名「通販」・営業形態 online_only）に寄せる。
//   node scripts/consolidate-online-stores.mjs             調査のみ（既定）
//   node scripts/consolidate-online-stores.mjs --execute   バックアップを作って実行
// 統合は DB 関数 _repoint_store（参照の付け替え。1トランザクション）。統合元の名称は統合先の別名に残す。
// 統合しない（要判断として報告する）: 統合元と統合先で店舗URLが異なる（独立した通販サイトの可能性）。アーカイブ済みは対象外。
import { createClient } from "@supabase/supabase-js";
import { mkdirSync, writeFileSync } from "node:fs";
try { process.loadEnvFile(".env.local"); } catch { /* */ }
const db = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
const execute = process.argv.includes("--execute");
const norm = (s) => s.normalize("NFKC").replace(/[\s\u3000]+/g, "").toLowerCase();
// src/lib/store-online.ts の ONLINE_NAMES と同じ
const ONLINE = new Set(["オンライン","通販","通販店","通販サイト","通販ショップ","ネット通販","ネットショップ","ネットストア","ネット店","オンライン店","オンラインストア","オンラインショップ","オンライン販売","公式オンライン","公式オンラインストア","公式通販","公式サイト","公式ストア","公式ショップ","eストア","webストア","webショップ","web","ウェブ","ウェブストア","online","onlinestore","onlineshop"].map(norm));
const isOnlineName = (n) => ONLINE.has(norm(n));
const all = async (t, sel) => { const out = []; for (let from = 0; ; from += 1000) { const { data, error } = await db.from(t).select(sel).range(from, from + 999); if (error) throw new Error(`${t}: ${error.message}`); out.push(...data); if (data.length < 1000) break; } return out; };
const [CH, ST, LO, AP, AL] = await Promise.all([all("chains", "id,name,household_id,archived_at"), all("stores", "*"), all("lotteries", "id,chain_id,store_id"), all("applications", "id,applied_store_id"), all("store_aliases", "*")]);
const chName = new Map(CH.map((c) => [c.id, c.name]));
const refs = (id) => LO.filter((l) => l.store_id === id).length + AP.filter((a) => a.applied_store_id === id).length;
const byChain = new Map();
for (const s of ST.filter((s) => !s.archived_at && (s.sales_kind === "online_only" || isOnlineName(s.name)))) byChain.set(s.chain_id, [...(byChain.get(s.chain_id) ?? []), s]);
const plan = [];
for (const [cid, group] of byChain) {
  const sorted = [...group].sort((a, b) => (b.sales_kind === "online_only") - (a.sales_kind === "online_only") || refs(b.id) - refs(a.id) || a.created_at.localeCompare(b.created_at));
  const target = sorted[0], others = sorted.slice(1);
  const urls = new Set(group.map((s) => s.store_url).filter(Boolean));
  const hasPhysical = ST.some((s) => s.chain_id === cid && !s.archived_at && !group.includes(s) && s.name !== "応募時に店舗選択");
  plan.push({ cid, chain: chName.get(cid), target, others, conflictUrl: urls.size > 1, hasPhysical });
}
let todo = 0;
for (const p of plan) {
  const act = [];
  if (p.target.name !== "通販") act.push(`名称「${p.target.name}」→「通販」`);
  if (p.target.sales_kind !== "online_only") act.push(`営業形態 ${p.target.sales_kind}→online_only`);
  for (const o of p.others) act.push(`統合:「${o.name}」(${o.sales_kind}, 参照${refs(o.id)})`);
  if (p.conflictUrl) act.push("⚠店舗URLが異なるため統合せず要判断");
  if (act.length) todo++;
  console.log(`${p.chain} [${p.hasPhysical ? "実店舗あり→「系列名 通販」" : "通販のみ→「系列名」"}] ${p.target.name} ${act.length ? "| " + act.join(" / ") : "| 変更なし"}`);
}
console.log(`\n対象系列${plan.length} 変更あり${todo}`);
if (!execute) { console.log("調査のみ。--execute で実行します"); process.exit(0); }
mkdirSync("backups", { recursive: true });
const file = `backups/online-stores-7s-${new Date().toISOString().replace(/[:.]/g, "-")}.json`;
const ids = new Set(plan.flatMap((p) => [p.target.id, ...p.others.map((o) => o.id)]));
writeFileSync(file, JSON.stringify({ stores: ST.filter((s) => ids.has(s.id)), aliases: AL.filter((a) => ids.has(a.store_id)), lotteries: LO.filter((l) => ids.has(l.store_id)), applications: AP.filter((a) => ids.has(a.applied_store_id)) }, null, 1));
let merged = 0, renamed = 0, skipped = 0;
for (const p of plan) {
  if (p.conflictUrl && p.others.length) { skipped++; continue; }
  const t = p.target;
  const addAlias = async (name) => {
    if (name === "通販") return;
    const na = norm(name).slice(0, 80);
    if (AL.some((a) => a.store_id === t.id && a.normalized_alias === na)) return;
    await db.from("store_aliases").insert({ household_id: t.household_id, store_id: t.id, alias: name.slice(0, 80), normalized_alias: na });
  };
  for (const o of p.others) {
    const r = await db.rpc("_repoint_store", { p_from: o.id, p_to: t.id });
    if (r.error) { console.error(`統合失敗 ${p.chain}「${o.name}」: ${r.error.message}`); continue; }
    await addAlias(o.name);
    await db.from("store_aliases").delete().eq("store_id", o.id);
    await db.from("store_trip_distances").delete().eq("store_id", o.id);
    const left = refs(o.id); // 参照が残っていないことを確認してから削除（ここでは付け替え後の再取得で確認）
    const [{ count: l1 }, { count: l2 }] = await Promise.all([db.from("lotteries").select("id", { count: "exact", head: true }).eq("store_id", o.id), db.from("applications").select("id", { count: "exact", head: true }).eq("applied_store_id", o.id)]);
    if ((l1 ?? 0) + (l2 ?? 0) > 0) { console.error(`参照が残っているため削除しません ${p.chain}「${o.name}」(${left})`); continue; }
    const d = await db.from("stores").delete().eq("id", o.id);
    if (d.error) { console.error(`店舗の削除に失敗（付け替えは完了）${p.chain}「${o.name}」: ${d.error.message}`); continue; }
    // 統合先に住所・都道府県が無ければ補う
    if (!t.prefecture && o.prefecture) await db.from("stores").update({ prefecture: o.prefecture }).eq("id", t.id);
    merged++;
  }
  const upd = {};
  const oldName = t.name;
  if (t.name !== "通販") upd.name = "通販";
  if (t.sales_kind !== "online_only") upd.sales_kind = "online_only";
  if (Object.keys(upd).length) {
    const u = await db.from("stores").update(upd).eq("id", t.id);
    if (u.error) { console.error(`更新失敗 ${p.chain}: ${u.error.message}`); continue; }
    await addAlias(oldName);
    renamed++;
  }
}
console.log(`完了: 統合${merged}店舗 / 名称・営業形態の更新${renamed}店舗 / 要判断で保留${skipped}系列。バックアップ ${file}`);
