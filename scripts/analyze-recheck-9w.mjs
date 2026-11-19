// Stage 9W: 既存の抽選・抽選候補の件数の整合性と、地域別・所在地不明の集計（**オフライン・読み取り専用**）。
//   入力: scripts/export-masters-9h3s.mjs の書き出し（backups/masters-9h3s/snapshot-prod-*.json）。本番へは接続しない。
//   node scripts/analyze-recheck-9w.mjs [--now=2026-11-19T10:00:00Z]
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";

const nowArg = (process.argv.find((a) => a.startsWith("--now=")) ?? "").slice(6);
const NOW = nowArg ? new Date(nowArg) : new Date();
const DIR = "backups/masters-9h3s";
const file = readdirSync(DIR).filter((f) => f.startsWith("snapshot-prod")).sort().at(-1);
const s = JSON.parse(readFileSync(`${DIR}/${file}`, "utf8"));
const KANSAI = ["兵庫県", "大阪府", "京都府"];
const KANTO = ["茨城県", "栃木県", "群馬県", "埼玉県", "千葉県", "東京都", "神奈川県"];
const stores = new Map(s.stores.map((x) => [x.id, x]));
const chains = new Map(s.chains.map((x) => [x.id, x.name]));
const prodName = new Map(s.products.map((p) => [p.id, p.official_name]));
const items = new Map();
for (const i of s.lottery_items) (items.get(i.lottery_id) ?? items.set(i.lottery_id, []).get(i.lottery_id)).push(prodName.get(i.product_id) ?? "");
const mgmt = new Map(s.lottery_management.map((m) => [m.lottery_id, m]));
const appsBy = new Map();
for (const a of s.applications) (appsBy.get(a.lottery_id) ?? appsBy.set(a.lottery_id, []).get(a.lottery_id)).push(a);
const today = new Date(NOW.getTime() + 9 * 3600_000).toISOString().slice(0, 10);
const dlOf = (l) => (l.apply_deadline_at ? new Date(Date.parse(l.apply_deadline_at) + 9 * 3600_000).toISOString().slice(0, 10) : l.apply_deadline_date);

function regionOf(l) {
  const st = stores.get(l.store_id);
  if (l.store_mode === "select_on_apply") return "店舗選択式";
  if (!st) return "店舗なし";
  if (st.sales_kind === "online_only") return "通販専用";
  const p = st.prefecture && st.prefecture !== '""' ? st.prefecture : "";
  if (!p) return "所在地不明";
  if (KANSAI.includes(p)) return "関西3県";
  if (KANTO.includes(p)) return "関東（所在地確認済み）";
  return "その他の地域（所在地確認済み）";
}
const rows = s.lotteries.filter((l) => !l.archived_at).map((l) => {
  const st = stores.get(l.store_id);
  const dl = dlOf(l);
  const open = !dl || dl >= today;
  const managed = !!mgmt.get(l.id)?.is_managed;
  const apps = (appsBy.get(l.id) ?? []).filter((a) => a.state !== "cancelled");
  const tab = apps.some((a) => a.result_status === "won") ? "当選" : apps.some((a) => a.result_status === "pending") ? "応募済み" : managed ? "要チェック" : "全情報";
  return { id: l.id, chain: chains.get(l.chain_id) ?? "", store: st?.name ?? "", prefecture: st?.prefecture ?? "", region: regionOf(l), open, deadline: dl ?? "", managed, apps: apps.length, tab, sourceKind: l.source_kind, path: l.registration_path, products: (items.get(l.id) ?? []).join(" / "), urls: l.source_urls ?? [], applyStart: l.apply_start_at ?? l.apply_start_date ?? "", result: l.result_date ?? "" };
});
const tally = (xs, k) => xs.reduce((m, x) => ((m[k(x)] = (m[k(x)] ?? 0) + 1), m), {});
const lotteryOut = {
  exportedFile: file, now: NOW.toISOString(), today,
  archivedExcluded: s.lotteries.length - rows.length, lotteriesNotArchived: rows.length,
  byTab: tally(rows, (r) => r.tab),
  openByTab: tally(rows.filter((r) => r.open), (r) => r.tab),
  byRegion: tally(rows, (r) => r.region),
  openByRegion: tally(rows.filter((r) => r.open), (r) => r.region),
  // 全情報タブの近似（受付中・未応募・★なし）。地域フィルター（関西3県）: 所在地不明・通販・店舗選択式は除外されず表示される
  allTabOpen: rows.filter((r) => r.tab === "全情報" && r.open).length,
  allTabOpenShownByRegionFilter: tally(rows.filter((r) => r.tab === "全情報" && r.open && ["関西3県", "所在地不明", "通販専用", "店舗選択式", "店舗なし"].includes(r.region)), (r) => r.region),
  allTabOpenHiddenByRegionFilter: tally(rows.filter((r) => r.tab === "全情報" && r.open && !["関西3県", "所在地不明", "通販専用", "店舗選択式", "店舗なし"].includes(r.region)), (r) => r.region),
};
// 抽選候補（確認待ち）
const cands = s.collection_candidates;
const review = cands.filter((c) => c.job_state === "review" && c.status !== "auto_registered");
const candOut = {
  total: cands.length, byStatus: tally(cands, (c) => `${c.status}/${c.job_state}`),
  reviewJobState: review.length,
  reviewWithDraftDeadlinePassed: review.filter((c) => { const d = c.draft?.input?.applyDeadline; return d && String(d).slice(0, 10) < today; }).length,
  reviewWithoutDraft: review.filter((c) => !c.draft).length,
};
// 所在地不明の店舗（抽選あり）
const unknownStores = new Map();
for (const r of rows.filter((x) => x.region === "所在地不明")) (unknownStores.get(`${r.chain}|${r.store}`) ?? unknownStores.set(`${r.chain}|${r.store}`, { chain: r.chain, store: r.store, lotteries: 0, open: 0 }).get(`${r.chain}|${r.store}`)).lotteries++;
for (const r of rows.filter((x) => x.region === "所在地不明" && x.open)) unknownStores.get(`${r.chain}|${r.store}`).open++;
mkdirSync("backups/recheck-9w", { recursive: true });
writeFileSync("backups/recheck-9w/lotteries-9w.json", JSON.stringify(rows, null, 1));
writeFileSync("backups/recheck-9w/reconcile.json", JSON.stringify({ lotteryOut, candOut, unknownStores: [...unknownStores.values()] }, null, 1));
console.log(JSON.stringify({ lotteryOut, candOut, unknownStoreCount: unknownStores.size }, null, 1));
