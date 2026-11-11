// 住所が未登録の実店舗の一覧（読み取り専用。Stage 8D-3: 実在店舗の評価対象を選ぶため）。
//   npm run prod -- scripts/list-stores-no-address.mjs --yes-production
// 出力は系列名・店舗名・都道府県のみ（個人情報・鍵は出さない）。何も書き込まない。
import { createClient } from "@supabase/supabase-js";

const db = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
const { data: stores, error } = await db.from("stores").select("name,prefecture,address_optional,chain_id,sales_kind,store_url,archived_at").is("archived_at", null).neq("sales_kind", "online_only").limit(2000);
if (error) throw error;
const { data: chains } = await db.from("chains").select("id,name,operation_kind");
const cname = new Map((chains ?? []).map((c) => [c.id, c.name]));
const noAddr = stores.filter((s) => !s.address_optional);
console.log(`実店舗 ${stores.length} 件 / 住所未登録 ${noAddr.length} 件 / store_url登録済み ${stores.filter((s) => s.store_url).length} 件`);
const by = new Map();
for (const s of noAddr) by.set(cname.get(s.chain_id) ?? "?", [...(by.get(cname.get(s.chain_id) ?? "?") ?? []), `${s.name}（${s.prefecture || "都道府県不明"}）`]);
for (const [c, list] of [...by].sort((a, b) => b[1].length - a[1].length).slice(0, 25)) console.log(`${c}（${list.length}）: ${list.slice(0, 6).join(" / ")}`);

// 指定した系列の全店舗名と、登録済みの公式サイトのドメイン（評価用の「同じ系列の他店舗」の凍結に使う）
const arg = process.argv.find((a) => a.startsWith("--chains="));
if (arg) {
  for (const name of arg.slice(9).split(",")) {
    const ids = (chains ?? []).filter((c) => c.name === name).map((c) => c.id);
    const list = stores.filter((s) => ids.includes(s.chain_id));
    const hosts = [...new Set(list.map((s) => { try { return s.store_url ? new URL(s.store_url).hostname : ""; } catch { return ""; } }).filter(Boolean))];
    console.log(`[${name}] ${list.length}店舗 / store_urlのドメイン: ${hosts.join(", ") || "なし"}`);
    console.log(list.map((s) => `${s.name}${s.address_optional ? "" : "(住所なし)"}`).join(" / "));
  }
}
