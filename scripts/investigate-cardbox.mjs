// カードボックス系列の調査（読み取り専用。Stage 7R）
import { createClient } from "@supabase/supabase-js";
try { process.loadEnvFile(".env.local"); } catch { /* */ }
const db = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
const all = async (t, sel, f = (q) => q) => { const out = []; for (let from = 0; ; from += 1000) { const { data, error } = await f(db.from(t).select(sel)).range(from, from + 999); if (error) throw new Error(`${t}: ${error.message}`); out.push(...data); if (data.length < 1000) break; } return out; };
const CH = await all("chains", "id,name,brand_group,operation_kind,is_provisional,archived_at,created_at");
const hit = CH.filter((c) => /カードボックス|card\s*box|cardbox/i.test(c.name) || c.brand_group);
console.log("== 系列 =="); for (const c of hit) console.log(JSON.stringify(c));
const ids = hit.map((c) => c.id);
const AL = await all("chain_aliases", "chain_id,alias");
console.log("== 別名 =="); for (const a of AL.filter((a) => ids.includes(a.chain_id))) console.log(a.chain_id.slice(0, 8), a.alias);
const ST = await all("stores", "id,chain_id,name,prefecture,is_provisional,archived_at", (q) => q.in("chain_id", ids));
console.log("== 店舗 =="); for (const s of ST) console.log(s.chain_id.slice(0, 8), s.id.slice(0, 8), s.name, s.prefecture, "仮=" + s.is_provisional, "archived=" + (s.archived_at ?? "-"));
const LO = await all("lotteries", "id,chain_id,store_id,store_mode,archived_at,created_at", (q) => q.in("chain_id", ids));
console.log("== 抽選 =="); for (const l of LO) console.log(l.chain_id.slice(0, 8), l.id.slice(0, 8), "store=" + (l.store_id ?? "-").slice(0, 8), l.store_mode, l.archived_at ? "ARCH" : "");
