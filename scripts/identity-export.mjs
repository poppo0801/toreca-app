// JUDGMENT_IDENTITY_EFFICIENCY §2: 同一性（重複・既存との照合）の評価用データの書き出し（本番・読み取りのみ）。
//   npm run prod -- scripts/identity-export.mjs --yes-production
// 書き出す物（Git管理外 eval/identity/*.local.json）: 抽選（非表示を含む）の系列・店舗・商品・期間・情報源URL・作成/非表示の時刻・応募の有無（真偽だけ）、
// 候補と抽選の結び付き（lottery_id・状態・理由の文）、重複の非表示の記録（master_reeval_items の archive_duplicate）。
// 書き出さない物: 応募のアカウント・個人の住所・メモ・連絡先・秘密。書き込みは一切しない。
import { mkdirSync, writeFileSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";
import { assertProductionTarget } from "./lib/target.mjs";

assertProductionTarget("identity-export.mjs");
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
const [L, IT, CH, ST, PR, AP, CA, RI] = await Promise.all([
  all("lotteries", "id,chain_id,store_id,store_mode,selectable_stores,apply_start_date,apply_start_at,apply_deadline_date,apply_deadline_at,result_date,result_at,source_urls,announcement_url,source_kind,event_state,created_at,archived_at,household_id"),
  all("lottery_items", "lottery_id,product_id"),
  all("chains", "id,name"),
  all("stores", "id,name,prefecture,sales_kind"),
  all("products", "id,official_name"),
  all("applications", "lottery_id"),
  all("collection_candidates", "id,status,kind,lottery_id,created_at,source_url,x_post_id,reasons,title", (q) => q.gte("created_at", "2026-11-01T00:00:00Z")),
  all("master_reeval_items", "target_type,target_id,action,status,proposal,created_at", (q) => q.eq("action", "archive_duplicate")).catch(() => []),
]);
const jst = (at, d) => (at ? new Date(new Date(at).getTime() + 9 * 3600e3).toISOString().slice(0, 16).replace("T", " ") : (d ?? null));
const chain = new Map(CH.map((c) => [c.id, c.name]));
const store = new Map(ST.map((s) => [s.id, s]));
const prod = new Map(PR.map((p) => [p.id, p.official_name]));
const items = {};
for (const x of IT) (items[x.lottery_id] ??= []).push(prod.get(x.product_id) ?? "");
const applied = new Set(AP.map((a) => a.lottery_id));
const lotteries = L.map((l) => ({
  id: l.id,
  chain: chain.get(l.chain_id) ?? "",
  store: store.get(l.store_id)?.name ?? "",
  prefecture: store.get(l.store_id)?.prefecture ?? null,
  storeMode: l.store_mode ?? "fixed",
  selectableStores: Array.isArray(l.selectable_stores) ? l.selectable_stores.map((s) => (typeof s === "string" ? s : (s?.name ?? ""))).slice(0, 30) : [],
  products: items[l.id] ?? [],
  applyStart: jst(l.apply_start_at, l.apply_start_date),
  applyDeadline: jst(l.apply_deadline_at, l.apply_deadline_date),
  result: jst(l.result_at, l.result_date),
  sourceUrls: l.source_urls ?? [],
  announcementUrl: l.announcement_url ?? null,
  sourceKind: l.source_kind,
  eventState: l.event_state,
  createdAt: l.created_at,
  archivedAt: l.archived_at,
  hasApplications: applied.has(l.id),
}));
const candidates = CA.map((c) => ({ id: c.id, status: c.status, kind: c.kind, lotteryId: c.lottery_id, createdAt: c.created_at, sourceUrl: c.source_url, xPostId: c.x_post_id, reasons: (c.reasons ?? []).slice(0, 8), title: (c.title ?? "").slice(0, 160) }));
const dupArchives = RI.map((r) => ({ targetId: r.target_id, status: r.status, keptId: r.proposal?.relatedId ?? null, createdAt: r.created_at }));
mkdirSync("eval/identity", { recursive: true });
writeFileSync("eval/identity/snapshot.local.json", JSON.stringify({ exportedAt: new Date().toISOString(), lotteries, candidates, dupArchives }));
console.log(JSON.stringify({ lotteries: lotteries.length, archived: lotteries.filter((l) => l.archivedAt).length, candidates: candidates.length, linked: candidates.filter((c) => c.lotteryId).length, byStatus: candidates.reduce((m, c) => ((m[c.status] = (m[c.status] ?? 0) + 1), m), {}), dupArchives: dupArchives.length }));
