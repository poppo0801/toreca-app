// Stage 9X: 再調査の対象一覧を、最新の読み取り専用の書き出しから作る（**オフライン**。本番へは接続しない）。
//   node scripts/plan-recheck-9x.mjs [--now=ISO]   → backups/eval-9x/targets.json
// 対象: ①全情報タブ相当（アーカイブされておらず、★・応募なし、受付中または期限不明）の抽選 ②確認待ち（review）で応募受付が終了していない候補。
// Stage 9W で調査済みの候補は除く（結果は再利用）。
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";

const nowArg = (process.argv.find((a) => a.startsWith("--now=")) ?? "").slice(6);
const NOW = nowArg ? new Date(nowArg) : new Date();
const dir = "backups/masters-9h3s";
const file = readdirSync(dir).filter((f) => f.startsWith("snapshot-prod")).sort().at(-1);
const s = JSON.parse(readFileSync(`${dir}/${file}`, "utf8"));
const { isApplicationClosed } = await import(new URL("../src/lib/collector/closed.ts", import.meta.url).href);
const today = new Date(NOW.getTime() + 9 * 3600_000).toISOString().slice(0, 10);
const day = (d, at) => (d ? String(d).slice(0, 10) : at ? new Date(Date.parse(at) + 9 * 3600_000).toISOString().slice(0, 10) : null);
const chains = new Map(s.chains.map((c) => [c.id, c.name]));
const stores = new Map(s.stores.map((x) => [x.id, x]));
const prod = new Map(s.products.map((p) => [p.id, p.official_name]));
const itemsOf = new Map();
for (const i of s.lottery_items) (itemsOf.get(i.lottery_id) ?? itemsOf.set(i.lottery_id, []).get(i.lottery_id)).push(prod.get(i.product_id) ?? "");
const mgmt = new Map(s.lottery_management.map((m) => [m.lottery_id, m.is_managed]));
const apps = new Map();
for (const a of s.applications) if (a.state !== "cancelled") (apps.get(a.lottery_id) ?? apps.set(a.lottery_id, []).get(a.lottery_id)).push(a);
const done9w = new Set(["87e20a12", "1721697c", "25e5b205", "319896c4", "b6fb9095"]);
const targets = [];
for (const l of s.lotteries.filter((x) => !x.archived_at)) {
  const a = apps.get(l.id) ?? [];
  const tab = a.some((x) => x.result_status === "won") ? "当選" : a.some((x) => x.result_status === "pending") ? "応募済み" : mgmt.get(l.id) ? "要チェック" : "全情報";
  const dl = day(l.apply_deadline_date, l.apply_deadline_at);
  const st0 = day(l.apply_start_date, l.apply_start_at);
  if (tab !== "全情報" || (dl && dl < today)) continue;
  const st = stores.get(l.store_id);
  targets.push({ kind: "lottery", key: `L:${l.id.slice(0, 8)}`, meta: { id: l.id, tab, prefecture: st?.prefecture ?? "", salesKind: st?.sales_kind ?? "", started: !st0 || st0 <= today, registrationPath: l.registration_path, createdAt: l.created_at },
    existing: { id: l.id, chain: chains.get(l.chain_id) ?? "", store: st?.name ?? null, storeMode: l.store_mode === "select_on_apply" ? "select_on_apply" : "fixed", products: itemsOf.get(l.id) ?? [], applyStart: st0, applyDeadline: dl, resultDate: l.result_date ?? day(null, l.result_at), sourceUrls: (l.source_urls ?? []).filter((u) => { try { return !/(^|\.)t\.co$/.test(new URL(u).host); } catch { return false; } }).slice(0, 4), humanFields: [] } });
}
for (const c of s.collection_candidates.filter((x) => x.job_state === "review" && x.status === "pending")) {
  if (isApplicationClosed({ dueAt: c.due_at, draft: c.draft }, NOW)) continue;
  const inp = c.draft?.input ?? {};
  const k = c.id.slice(0, 8);
  targets.push({ kind: "candidate", key: `C:${k}`, meta: { id: c.id, skipped9w: done9w.has(k), reasons: (c.reasons ?? []).slice(0, 3) },
    existing: { id: c.id, chain: inp.chain?.name ?? "", store: inp.store?.name || null, storeMode: "fixed", products: (inp.items ?? []).map((i) => i.product?.name).filter(Boolean), applyStart: String(inp.applyStart?.date ?? "").slice(0, 10) || null, applyDeadline: String(inp.applyDeadline?.date ?? "").slice(0, 10) || null, resultDate: null, sourceUrls: [c.source_url].filter(Boolean), humanFields: [] } });
}
// 同じ情報源（URL）を共有する対象を隣に並べる（取得結果の再利用が効くように）
targets.sort((a, b) => String(a.existing.sourceUrls[0] ?? "~").localeCompare(String(b.existing.sourceUrls[0] ?? "~")));
const todo = targets.filter((t) => !t.meta.skipped9w);
mkdirSync("backups/eval-9x", { recursive: true });
writeFileSync("backups/eval-9x/targets.json", JSON.stringify({ at: NOW.toISOString(), snapshot: file, total: targets.length, lotteries: targets.filter((t) => t.kind === "lottery").length, candidates: targets.filter((t) => t.kind === "candidate").length, reusedFrom9w: targets.length - todo.length, targets: todo }, null, 1));
const withUrl = todo.filter((t) => t.existing.sourceUrls.length > 0).length;
console.log(JSON.stringify({ snapshot: file, today, totalTargets: targets.length, lotteries: targets.filter((t) => t.kind === "lottery").length, candidates: targets.filter((t) => t.kind === "candidate").length, reusedFrom9w: targets.length - todo.length, toRun: todo.length, withSourceUrl: withUrl, withoutSourceUrl: todo.length - withUrl }));
