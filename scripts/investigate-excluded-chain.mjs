// 除外系列（信頼性なし）の調査（読み取り専用。Stage 7Q）。
//   node scripts/investigate-excluded-chain.mjs [系列名の一部=luruna]
import { createClient } from "@supabase/supabase-js";

try {
  process.loadEnvFile(".env.local");
} catch {
  /* 環境変数が既に設定されている場合 */
}
const db = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
const needle = (process.argv[2] ?? "luruna").toLowerCase();
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
const day = (iso) => (iso ? new Date(new Date(iso).getTime() + 9 * 3600e3).toISOString().slice(0, 16).replace("T", " ") : "-");
const nm = (s) => (s ?? "").normalize("NFKC").replace(/[\s　]+/g, "").toLowerCase();

const [CH, AL, EX, LOG] = await Promise.all([
  all("chains", "id,name,is_provisional,archived_at,created_at"),
  all("chain_aliases", "chain_id,alias,created_at"),
  all("collection_exclusions", "*"),
  all("collection_exclusion_log", "*"),
]);
const chains = CH.filter((c) => nm(c.name).includes(needle) || AL.some((a) => a.chain_id === c.id && nm(a.alias).includes(needle)));
console.log("== 系列マスター ==");
for (const c of chains) console.log(`${c.id.slice(0, 8)} ${c.name} 仮=${c.is_provisional} archived=${c.archived_at ?? "-"} 作成${day(c.created_at)} 別名[${AL.filter((a) => a.chain_id === c.id).map((a) => a.alias).join(",")}]`);
const ids = new Set(chains.map((c) => c.id));

console.log("\n== 除外ルール(collection_exclusions) ==");
for (const e of EX.filter((e) => ids.has(e.chain_id) || ids.has(e.key) || nm(e.label).includes(needle))) console.log(`${e.id.slice(0, 8)} scope=${e.scope} key=${e.key.slice(0, 8)} label=${e.label} reason=${e.reason_code} active=${e.active} 作成${day(e.created_at)} 解除${day(e.released_at)} メモ=${e.reason_note}`);

console.log("\n== 除外履歴(collection_exclusion_log) ==");
for (const l of LOG.filter((l) => JSON.stringify(l.detail ?? {}).toLowerCase().includes(needle))) console.log(`${day(l.created_at)} reason=${l.reason_code} rule=${l.rule_table}/${(l.rule_id ?? "").slice(0, 8)} cand=${(l.candidate_id ?? "").slice(0, 8)} detail=${JSON.stringify(l.detail).slice(0, 260)}`);

const LOT = await all("lotteries", "id,chain_id,store_id,source_kind,registration_path,created_at,archived_at,apply_deadline_at,apply_deadline_date,source_urls,store_mode");
console.log("\n== 該当系列の抽選 ==");
for (const l of LOT.filter((l) => ids.has(l.chain_id))) console.log(`${l.id.slice(0, 6)} ${l.source_kind}/${l.registration_path} 作成${day(l.created_at)} archived=${l.archived_at ? "1" : "0"} 締切${l.apply_deadline_at ? day(l.apply_deadline_at) : l.apply_deadline_date} urls=${(l.source_urls ?? []).join(" ")}`);

const CAND = await all("collection_candidates", "id,status,source_url,title,created_at,resolved_at,lottery_id,reasons,triage_reason,draft");
console.log("\n== 該当系列の収集候補（draft の系列名・系列IDが一致）==");
const hit = CAND.filter((c) => {
  const i = c.draft?.input;
  return (i && (ids.has(i.chain?.id) || nm(i.chain?.name).includes(needle))) || nm(c.title).includes(needle);
});
for (const c of hit) console.log(`${c.id.slice(0, 6)} ${c.status} 作成${day(c.created_at)} 解決${day(c.resolved_at)} 系列=${c.draft?.input?.chain?.name}/${(c.draft?.input?.chain?.id ?? "").slice(0, 6)} lot=${(c.lottery_id ?? "").slice(0, 6)} ${c.source_url} 理由=${(c.reasons ?? []).join("｜").slice(0, 120)}`);
console.log(`候補 ${hit.length} 件`);
