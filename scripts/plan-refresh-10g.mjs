// Stage 10G R0: 全情報相当＋抽選候補の対象一覧と統計を、**オフライン**で作る（本番へは接続しない。入力は読み取り専用の書き出し）。
//   node scripts/plan-refresh-10g.mjs [--now=ISO]   → backups/refresh-10g/r0.json（Git管理外）。標準出力は件数のみ（原文・URL・IDは出さない）
// 対象: ①全情報タブ相当（アーカイブされておらず、★・応募なし、受付中または期限不明）の抽選 ②確認待ち（review/pending）で応募受付が終了していない候補。
// 保護の判定は最小限: 応募記録（取消含む）がある／★管理中／通知・ルール・メモ等の参照がある → 保護あり。**応募・当選・購入の内容は読まない・外部へ出さない**。
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";

const nowArg = (process.argv.find((a) => a.startsWith("--now=")) ?? "").slice(6);
const NOW = nowArg ? new Date(nowArg) : new Date();
const latest = (dir, prefix) => `${dir}/${readdirSync(dir).filter((f) => f.startsWith(prefix)).sort().at(-1)}`;
const s = JSON.parse(readFileSync(latest("backups/masters-9h3s", "snapshot-prod"), "utf8"));
const ev = JSON.parse(readFileSync(latest("backups/refresh-10g", "evidence-"), "utf8"));
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
for (const a of s.applications) (apps.get(a.lottery_id) ?? apps.set(a.lottery_id, []).get(a.lottery_id)).push(a);
const refCount = (id) => Object.values(s.lottery_refs ?? {}).reduce((n, m) => n + (m[id] ?? 0), 0);
const evById = new Map(ev.rows.map((r) => [r.id, r]));
const candsOfLottery = new Map();
for (const c of s.collection_candidates) if (c.lottery_id) (candsOfLottery.get(c.lottery_id) ?? candsOfLottery.set(c.lottery_id, []).get(c.lottery_id)).push(c);

const hostKind = (u) => {
  try {
    const h = new URL(u).hostname.toLowerCase();
    if (/(^|\.)(t\.co|x\.com|twitter\.com)$/.test(h)) return "x_or_short";
    return "public";
  } catch {
    return "invalid";
  }
};
const targets = [];
for (const l of s.lotteries.filter((x) => !x.archived_at)) {
  const a = apps.get(l.id) ?? [];
  const tab = a.some((x) => x.state !== "cancelled" && x.result_status === "won") ? "当選" : a.some((x) => x.state !== "cancelled" && x.result_status === "pending") ? "応募済み" : mgmt.get(l.id) ? "要チェック" : "全情報";
  const dl = day(l.apply_deadline_date, l.apply_deadline_at);
  if (tab !== "全情報" || (dl && dl < today)) continue;
  const st = stores.get(l.store_id);
  const evidence = (candsOfLottery.get(l.id) ?? []).map((c) => evById.get(c.id)).filter(Boolean).sort((x, y) => String(y.fetchedAt).localeCompare(String(x.fetchedAt)))[0] ?? null;
  const urls = (l.source_urls ?? []).filter((u) => hostKind(u) !== "invalid");
  targets.push({
    kind: "lottery",
    id: l.id,
    protection: a.length > 0 || refCount(l.id) > 0 || mgmt.get(l.id) ? "protected" : "none",
    hasText: !!evidence,
    evidenceId: evidence?.id ?? null,
    urlKinds: [...new Set(urls.map(hostKind))],
    publicUrls: urls.filter((u) => hostKind(u) === "public").slice(0, 2),
    existing: { chain: chains.get(l.chain_id) ?? "", store: st?.name ?? null, prefecture: st?.prefecture ?? "", storeMode: l.store_mode === "select_on_apply" ? "select_on_apply" : "fixed", products: itemsOf.get(l.id) ?? [], applyStart: day(l.apply_start_date, l.apply_start_at), applyDeadline: dl, resultDate: l.result_date ?? day(null, l.result_at), lotteryForm: l.lottery_form ?? null, registrationPath: l.registration_path ?? null },
  });
}
for (const c of s.collection_candidates.filter((x) => x.job_state === "review" && x.status === "pending")) {
  if (isApplicationClosed({ dueAt: c.due_at, draft: c.draft }, NOW)) continue;
  const inp = c.draft?.input ?? {};
  const e = evById.get(c.id) ?? null;
  const urls = [c.source_url, ...(c.draft?.sourceUrls ?? [])].filter(Boolean);
  targets.push({
    kind: "candidate",
    id: c.id,
    protection: c.lottery_id ? "protected" : "none",
    hasText: !!e,
    evidenceId: e?.id ?? null,
    urlKinds: [...new Set(urls.map(hostKind))],
    publicUrls: urls.filter((u) => hostKind(u) === "public").slice(0, 2),
    existing: { chain: inp.chain?.name ?? "", store: inp.store?.name || null, prefecture: "", storeMode: "fixed", products: (inp.items ?? []).map((i) => i.product?.name).filter(Boolean), applyStart: String(inp.applyStart?.date ?? "").slice(0, 10) || null, applyDeadline: String(inp.applyDeadline?.date ?? "").slice(0, 10) || null, resultDate: null, lotteryForm: null, registrationPath: null },
  });
}

const rank = (t) => (t.protection === "none" ? 0 : 4) + (t.hasText ? 0 : 2) + (t.hasText || t.urlKinds.includes("public") ? 0 : 1);
const ordered = [...targets].sort((a, b) => rank(a) - rank(b) || (a.kind === b.kind ? 0 : a.kind === "candidate" ? -1 : 1) || a.id.localeCompare(b.id));
// 初回30件: 原文あり・保護なしを優先。原文なしは公開ページの再取得が見込めるものだけ
const selected = ordered.filter((t) => t.hasText || t.urlKinds.includes("public")).slice(0, 30);

const by = (arr, f) => arr.reduce((m, x) => ((m[f(x)] = (m[f(x)] ?? 0) + 1), m), {});
const stats = {
  today,
  total: targets.length,
  byKind: by(targets, (t) => t.kind),
  withStoredText: targets.filter((t) => t.hasText).length,
  withStoredTextByKind: by(targets.filter((t) => t.hasText), (t) => t.kind),
  protection: by(targets, (t) => `${t.kind}:${t.protection}`),
  sourceKinds: by(targets, (t) => (t.urlKinds.length ? [...t.urlKinds].sort().join("+") : "no_url")),
  noTextButPublicUrl: targets.filter((t) => !t.hasText && t.urlKinds.includes("public")).length,
  noTextNoPublicUrl: targets.filter((t) => !t.hasText && !t.urlKinds.includes("public")).length,
  selected: selected.length,
  selectedByKind: by(selected, (t) => t.kind),
  selectedWithText: selected.filter((t) => t.hasText).length,
  selectedProtected: selected.filter((t) => t.protection !== "none").length,
  deferred: targets.length - selected.length,
  snapshotCounts: { lotteries: s.lotteries.length, candidates: s.collection_candidates.length, evidenceRows: ev.rows.length },
};
mkdirSync("backups/refresh-10g", { recursive: true });
writeFileSync("backups/refresh-10g/r0.json", JSON.stringify({ at: NOW.toISOString(), stats, targets, selectedIds: selected.map((t) => t.id) }, null, 1));
console.log(JSON.stringify(stats, null, 1));
