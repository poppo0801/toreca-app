// Stage 9X: 画面の件数（全情報タブ）をプロフィール別に再現する（**読み取り専用**）。
//   npm run prod -- scripts/analyze-screen-9x.mjs --yes-production
// 画面の判定（src/lib/lottery-view.ts）に合わせる: タブ = 当選→応募済み→要チェック(★)→全情報。既定の絞り込み = 受付中かつ未応募・スルーしていない・地域（関西3県。所在地不明/通販/店舗なしは除外しない）。
import { createClient } from "@supabase/supabase-js";
import { assertProductionTarget } from "./lib/target.mjs";

assertProductionTarget("analyze-screen-9x.mjs");
const db = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
const all = async (t, sel = "*") => { const r = []; for (let o = 0; ; o += 1000) { const { data, error } = await db.from(t).select(sel).range(o, o + 999); if (error) throw new Error(`${t}: ${error.message}`); r.push(...(data ?? [])); if ((data ?? []).length < 1000) break; } return r; };
const [lots, stores, mgmt, apps, rules, profiles] = await Promise.all([all("lotteries"), all("stores"), all("lottery_management"), all("applications"), all("skip_rules").catch(() => []), all("profiles", "id,label,active")]);
const KANSAI = ["兵庫県", "大阪府", "京都府"];
const st = new Map(stores.map((s) => [s.id, s]));
const m = new Map(mgmt.map((x) => [x.lottery_id, x.is_managed]));
const today = new Date(Date.now() + 9 * 3600_000).toISOString().slice(0, 10);
const dl = (l) => (l.apply_deadline_at ? new Date(Date.parse(l.apply_deadline_at) + 9 * 3600_000).toISOString().slice(0, 10) : l.apply_deadline_date);
const out = { today, rules: rules.length, ruleCols: rules[0] ? Object.keys(rules[0]) : [], profiles: [] };
for (const p of profiles.filter((x) => x.active !== false)) {
  const mine = apps.filter((a) => a.profile_id === p.id && a.state !== "cancelled");
  const skipped = (l) => rules.some((r) => r.profile_id === p.id && ((r.scope_type === "lottery" && r.lottery_id === l.id) || (r.scope_type === "store" && r.store_id === l.store_id) || (r.scope_type === "chain" && r.chain_id === l.chain_id)));
  const rows = lots.filter((l) => !l.archived_at);
  const tab = (l) => { const a = mine.filter((x) => x.lottery_id === l.id); if (a.some((x) => x.result_status === "won")) return "当選"; if (a.some((x) => x.result_status === "pending")) return "応募済み"; return m.get(l.id) ? "要チェック" : "全情報"; };
  const region = (l) => { const s = st.get(l.store_id); if (!s || l.store_mode !== "fixed" || s.sales_kind === "online_only" || !s.prefecture || s.prefecture === '""') return true; return KANSAI.includes(s.prefecture); };
  const st0 = (l) => (l.apply_start_at ? new Date(Date.parse(l.apply_start_at) + 9 * 3600_000).toISOString().slice(0, 10) : l.apply_start_date);
const open = (l) => { const d = dl(l); const s0 = st0(l); return (!d || d >= today) && (!s0 || s0 <= today) && (l.event_state === "open" || !l.event_state); };
  const base = rows.filter((l) => tab(l) === "全情報" && open(l));
  out.profiles.push({ label: p.label, allTabOpen: base.length, notSkipped: base.filter((l) => !skipped(l)).length, shown: base.filter((l) => !skipped(l) && region(l)).length });
}
console.log(JSON.stringify(out, null, 1));
