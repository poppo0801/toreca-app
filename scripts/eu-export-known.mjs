// EVIDENCE_UTILIZATION §5: 未知の情報元の探索の評価用に、本番の「既知の情報元」を読み取り専用で書き出す（ローカルの Git 管理外ファイルへ。標準出力には件数だけ）。
//   npm run prod -- scripts/eu-export-known.mjs --yes-production
// 書き出すもの: 収集の情報源・抽選・収集の候補のURL（正規化）とホスト、系列名・店舗名（公開の店名）。個人情報・応募・当選・購入の記録は含めない。
import { writeFileSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";
import { assertProductionTarget } from "./lib/target.mjs";

assertProductionTarget("eu-export-known.mjs");
const db = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
async function all(q, page = 1000) {
  const out = [];
  for (let from = 0; ; from += page) {
    const r = await q().range(from, from + page - 1);
    if (r.error) throw new Error(r.error.message.slice(0, 80));
    out.push(...(r.data ?? []));
    if ((r.data ?? []).length < page) break;
  }
  return out;
}
const canon = (u) => {
  try {
    const x = new URL(u);
    return `${x.hostname.replace(/^www\./, "")}${x.pathname.replace(/\/+$/, "")}`.toLowerCase();
  } catch {
    return null;
  }
};
const host = (u) => {
  try {
    return new URL(u).hostname.replace(/^www\./, "").toLowerCase();
  } catch {
    return null;
  }
};
const urls = new Set();
const add = (u) => {
  if (typeof u === "string" && /^https?:\/\//.test(u)) urls.add(u);
};
for (const s of await all(() => db.from("collection_sources").select("url"))) add(s.url);
for (const l of await all(() => db.from("lotteries").select("source_urls,announcement_url"))) {
  for (const u of Array.isArray(l.source_urls) ? l.source_urls : []) add(typeof u === "string" ? u : u?.url);
  add(l.announcement_url);
}
for (const c of await all(() => db.from("collection_candidates").select("source_url,last_good"))) {
  add(c.source_url);
  for (const p of c.last_good?.evidence?.linkedPages ?? []) add(p.url);
  for (const u of c.last_good?.evidence?.links ?? []) add(u);
}
const chains = (await all(() => db.from("chains").select("name"))).map((c) => c.name).filter(Boolean);
const stores = (await all(() => db.from("stores").select("name"))).map((s) => s.name).filter(Boolean);
const list = [...urls];
const out = { at: new Date().toISOString(), hosts: [...new Set(list.map(host).filter(Boolean))].sort(), urls: [...new Set(list.map(canon).filter(Boolean))].sort(), chains: [...new Set(chains)].sort(), stores: [...new Set(stores)].sort() };
writeFileSync("eval/intensive/known.local.json", JSON.stringify(out));
console.log("書き出し", JSON.stringify({ hosts: out.hosts.length, urls: out.urls.length, chains: out.chains.length, stores: out.stores.length }));
