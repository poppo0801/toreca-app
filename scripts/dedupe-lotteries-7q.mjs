// 重複して登録された抽選の再整理（Stage 7Q。7P の改訂版）。既定は調査のみ（dry-run）。DBは変更しない。
//
//   node scripts/dedupe-lotteries-7q.mjs                     # 重複グループの調査と整理計画を表示
//   node scripts/dedupe-lotteries-7q.mjs --execute           # バックアップ(backups/dedupe-7q-*.json)を取得し、整理を実行
//   node scripts/dedupe-lotteries-7q.mjs --restore <ファイル> # 整理を元に戻す（バックアップから復元）
//
// 判定は src/lib/lottery-match.ts の findDuplicates（Stage 7Q）と同じ方針:
//   系列が同じ・商品構成が同じ（集合として一致）・店舗の区分が同じ（同じ店舗／双方オンライン／双方が店舗選択式／双方が店舗未確定）で、
//   明確に別の開催回（応募期間が重ならない等）でなく、両方の締切が分かっていれば、応募期間・情報元URLが違っても同じ抽選。
//   店舗固定式と店舗未確定の組、店舗選択式と店舗固定式・店舗未確定、商品構成が違う組は自動では統合しない（報告のみ）。
// 残す側: 応募記録・★・手動登録・手動修正のある抽選を優先して残す。消す側に応募/当落/購入/スルー/例外/通知/優先収集メモ・★・手動登録・手動修正が1つでもあれば、
//   そのグループは統合せず「要判断」として報告する（応募・当落・お気に入りは動かさない）。
// 処理: 残す抽選に情報源URLを統合し、統合元の記録（merged_sources: URL・収集日時・収集時の系列名・統合元の抽選ID・元データ）を残す
//   → 不要な抽選に紐づく収集候補を「重複」として残す抽選へ付け替え → 不要な抽選をアーカイブ（物理削除しない。復元可能）。
import { createClient } from "@supabase/supabase-js";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";

try {
  process.loadEnvFile(".env.local");
} catch {
  /* 環境変数が既に設定されている場合 */
}
const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !key) throw new Error(".env.local に URL と SUPABASE_SERVICE_ROLE_KEY が必要です");
const linked = existsSync("supabase/.temp/project-ref") ? readFileSync("supabase/.temp/project-ref", "utf8").trim() : "";
if (!linked || !url.includes(linked)) throw new Error("接続先がリンク済みのトレカ専用プロジェクトと一致しません。中止します。");
const db = createClient(url, key, { auth: { persistSession: false } });
const args = process.argv.slice(2);
const execute = args.includes("--execute");
const restoreIdx = args.indexOf("--restore");

const nm = (s) => (s ?? "").normalize("NFKC").replace(/[\s　]+/g, "").toLowerCase();
const chainKey = (s) => nm(s).replace(/株式会社|有限会社|\(株\)/g, "").replace(/(オンラインショップ|オンラインストア|オンライン|通販部|通販|公式|ショップ|ストア)$/g, "");
const onlineName = (s) => /^(オンライン|通販|ネット通販|ネットショップ|オンラインストア|オンラインショップ|公式オンライン|公式通販)$/i.test(nm(s));
const day = (l) => (l.apply_deadline_at ?? l.apply_deadline_date ?? "").slice(0, 10);
const jstDay = (l) => (l.apply_deadline_at ? new Date(new Date(l.apply_deadline_at).getTime() + 9 * 3600e3).toISOString().slice(0, 10) : (l.apply_deadline_date ?? ""));

if (restoreIdx >= 0) {
  const file = args[restoreIdx + 1];
  const b = JSON.parse(readFileSync(file, "utf8"));
  for (const l of b.lotteries) await db.from("lotteries").update({ archived_at: l.archived_at, source_urls: l.source_urls, merged_sources: l.merged_sources ?? [] }).eq("id", l.id);
  for (const c of b.candidates) await db.from("collection_candidates").update({ status: c.status, lottery_id: c.lottery_id, reasons: c.reasons, job_state: c.job_state, triage: c.triage, triage_reason: c.triage_reason }).eq("id", c.id);
  console.log(`復元しました: 抽選${b.lotteries.length}件・候補${b.candidates.length}件`);
  process.exit(0);
}

// 「信頼性なし」で除外した系列（collection_exclusions の有効な chain ルール）と --skip-chain <名称>: 既存の抽選カードには触れない
const exRules = (await db.from("collection_exclusions").select("key,chain_id").eq("scope", "chain").eq("active", true)).data ?? [];
const skipNames = args.flatMap((a, i) => (args[i - 1] === "--skip-chain" ? [nm(a)] : []));
const [L, IT, CH, ST, PR] = await Promise.all([
  db.from("lotteries").select("*").is("archived_at", null),
  db.from("lottery_items").select("lottery_id,product_id"),
  db.from("chains").select("id,name"),
  db.from("stores").select("id,name,sales_kind"),
  db.from("products").select("id,official_name"),
]);
for (const r of [L, IT, CH, ST, PR]) if (r.error) throw new Error("読み取りに失敗しました");
const excludedChainIds = new Set(exRules.map((r) => r.chain_id ?? r.key));
const isExcludedChain = (l) => excludedChainIds.has(l.chain_id) || skipNames.some((n) => nm(CH.data.find((c) => c.id === l.chain_id)?.name ?? "").includes(n));
const lots = L.data.filter((l) => !isExcludedChain(l));
const skippedLots = L.data.length - lots.length;
const items = {};
for (const x of IT.data) (items[x.lottery_id] ??= []).push(x.product_id);
const chainName = (id) => CH.data.find((c) => c.id === id)?.name ?? "";
const storeOf = (id) => ST.data.find((s) => s.id === id);
const isOnline = (l) => { const s = storeOf(l.store_id); return !!s && (onlineName(s.name) || s.sales_kind === "online_only"); };

// 同一判定 → 連結成分
const urlId = (u) => {
  try {
    const x = new URL(u);
    const m = /^\/[A-Za-z0-9_]{1,15}\/status\/(\d{5,25})/.exec(x.pathname);
    if (/(^|\.)(x|twitter)\.com$/.test(x.hostname) && m) return "x:" + m[1];
    return "u:" + x.hostname.replace(/^www\./, "") + x.pathname.replace(/\/+$/, "");
  } catch {
    return null;
  }
};
const shareUrl = (a, b) => {
  const ka = new Set((a.source_urls ?? []).map(urlId).filter(Boolean));
  return (b.source_urls ?? []).map(urlId).some((k) => k && ka.has(k));
};
const sameSet = (a, b) => {
  const x = new Set(items[a.id] ?? []);
  const y = new Set(items[b.id] ?? []);
  return x.size > 0 && x.size === y.size && [...x].every((v) => y.has(v));
};
const sameChain = (a, b) => !!chainKey(chainName(a.chain_id)) && chainKey(chainName(a.chain_id)) === chainKey(chainName(b.chain_id));
const PLACEHOLDER = "応募時に店舗選択";
/** 店舗区分: select=店舗選択式 / online=通販 / fixed=店舗固定式 / unconfirmed=店舗未確定 */
const cls = (l) => (l.store_mode === "select_on_apply" || storeOf(l.store_id)?.name === PLACEHOLDER ? "select" : isOnline(l) ? "online" : l.store_id ? "fixed" : "unconfirmed");
const storeBucket = (a, b) => {
  const x = cls(a), y = cls(b);
  if (x === "fixed" && y === "fixed") return a.store_id === b.store_id ? "same" : null;
  if (x === y) return "same";
  if ((x === "fixed" && y === "unconfirmed") || (x === "unconfirmed" && y === "fixed")) return "weak";
  return null;
};
const TODAY = new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 10);
const startDay = (l) => (l.apply_start_at ? new Date(new Date(l.apply_start_at).getTime() + 9 * 3600e3).toISOString().slice(0, 10) : (l.apply_start_date ?? ""));
const otherRound1 = (m, t) => {
  if (m.deadline && t.deadline && m.deadline === t.deadline) return false;
  if (m.deadline && t.deadline && t.deadline < TODAY && m.deadline > t.deadline) return true;
  if (m.deadline && t.deadline && m.deadline < TODAY && m.deadline !== t.deadline) return true;
  if (m.start && t.deadline && m.start > t.deadline) return true;
  if (t.start && m.deadline && t.start > m.deadline) return true;
  return false;
};
const rng = (l) => ({ start: startDay(l) || null, deadline: jstDay(l) || null });
const clearlyOther = (a, b) => otherRound1(rng(a), rng(b)) || otherRound1(rng(b), rng(a));
const same = (a, b) => {
  if (a.id === b.id || !sameChain(a, b) || !sameSet(a, b)) return false;
  if (storeBucket(a, b) !== "same" || !jstDay(a) || !jstDay(b)) return false;
  return !clearlyOther(a, b);
};
const parent = new Map(lots.map((l) => [l.id, l.id]));
const find = (x) => (parent.get(x) === x ? x : (parent.set(x, find(parent.get(x))), parent.get(x)));
for (const a of lots) for (const b of lots) if (same(a, b)) parent.set(find(a.id), find(b.id));
const groups = {};
for (const l of lots) (groups[find(l.id)] ??= []).push(l);
const dupGroups = Object.values(groups).filter((g) => g.length > 1);

const ids = dupGroups.flat().map((l) => l.id);
const relTables = ["applications", "skip_rules", "skip_rule_exceptions", "limit_exemptions", "application_rules", "notification_deliveries", "collection_memos"];
const rel = {};
for (const t of relTables) {
  const r = await db.from(t).select("lottery_id").in("lottery_id", ids.length ? ids : ["00000000-0000-0000-0000-000000000000"]);
  for (const x of r.data ?? []) ((rel[x.lottery_id] ??= {})[t] = (rel[x.lottery_id][t] ?? 0) + 1);
}
const mg = (await db.from("lottery_management").select("lottery_id,is_managed").in("lottery_id", ids.length ? ids : ["00000000-0000-0000-0000-000000000000"])).data ?? [];
const cands = ids.length ? ((await db.from("collection_candidates").select("id,lottery_id,status,job_state,triage,triage_reason,reasons,source_url").in("lottery_id", ids)).data ?? []) : [];

const appCount = {};
for (const l of lots) appCount[l.id] = rel[l.id]?.applications ?? 0;
const score = (l) => (appCount[l.id] ?? 0) * 200 + (mg.find((m) => m.lottery_id === l.id)?.is_managed ? 150 : 0) + (l.source_kind === "manual" ? 100 : 0) + (l.updated_by_profile_id ? 50 : 0) + (l.result_date || l.result_at ? 5 : 0) + (l.conditions_text ? 5 : 0) + Math.min(10, (l.memo ?? "").length / 50) + (l.source_urls ?? []).length + (l.announcement_url ? 2 : 0) + (l.apply_method !== "unknown" ? 1 : 0) + (l.store_id ? 3 : 0);
const blockers = (l) => {
  const b = [];
  if (l.source_kind !== "auto") b.push("手動登録");
  if (l.updated_by_profile_id) b.push("手動修正あり");
  if (mg.find((m) => m.lottery_id === l.id)?.is_managed) b.push("★管理対象");
  for (const [t, n] of Object.entries(rel[l.id] ?? {})) b.push(`${t}:${n}`);
  return b;
};

const plan = [];
for (const g of dupGroups) {
  const sorted = [...g].sort((a, b) => score(b) - score(a) || a.created_at.localeCompare(b.created_at));
  const keeper = sorted[0];
  const removable = sorted.slice(1);
  const blocked = removable.map((l) => ({ l, b: blockers(l) })).filter((x) => x.b.length > 0);
  plan.push({ keeper, removable, blocked });
}

// 統合しない近い組（同じ系列で商品が共通するが、自動整理の条件を満たさない）
const near = [];
for (let i = 0; i < lots.length; i++)
  for (let j = i + 1; j < lots.length; j++) {
    const a = lots[i];
    const b = lots[j];
    if (!sameChain(a, b) || find(a.id) === find(b.id)) continue;
    if (a.store_id && b.store_id && a.store_id !== b.store_id) continue; // 店舗が明確に違う独立した抽選
    if (!(items[a.id] ?? []).some((p) => (items[b.id] ?? []).includes(p))) continue;
    const why = [];
    const bk = storeBucket(a, b);
    if (!bk) why.push(`店舗の区分・店舗が異なる（${cls(a)}/${cls(b)}）`);
    if (bk === "weak") why.push("店舗固定式と店舗未確定（同じ告知か判断できない）");
    if (!sameSet(a, b)) why.push("商品構成が異なる");
    if (clearlyOther(a, b)) why.push(`別の開催回の可能性（応募期間が重ならない/終了済み。締切 ${jstDay(a)} / ${jstDay(b)}）`);
    else if (jstDay(a) !== jstDay(b)) why.push(`締切が異なる（${jstDay(a)} / ${jstDay(b)}）`);
    if (!jstDay(a) || !jstDay(b)) why.push("締切が不明");
    near.push({ a, b, why: why.join("・") || "条件不足" });
  }

console.log(`除外系列のため対象外の抽選: ${skippedLots}件（触れません）`);
console.log(`重複グループ: ${dupGroups.length}`);
for (const p of plan) {
  const label = (l) => `${l.id.slice(0, 6)}(${chainName(l.chain_id)}/${storeOf(l.store_id)?.name ?? "-"} ${jstDay(l)} ${l.source_kind} 情報源${(l.source_urls ?? []).length}件)`;
  console.log(`- 残す: ${label(p.keeper)}`);
  for (const l of p.removable) console.log(`    整理: ${label(l)}${p.blocked.find((x) => x.l.id === l.id) ? `  ★統合しない（要判断）: ${p.blocked.find((x) => x.l.id === l.id).b.join("・")}` : ""}`);
}

console.log(`\n統合しなかった近い組: ${near.length}`);
for (const n of near) {
  const lb = (l) => `${l.id.slice(0, 6)}(${chainName(l.chain_id)}/${storeOf(l.store_id)?.name ?? "店舗未確定"} ${l.source_kind} 締切${jstDay(l)} 商品${(items[l.id] ?? []).length}件)`;
  console.log(`  - ${lb(n.a)} ⇔ ${lb(n.b)}  → ${n.why}（応募${appCount[n.a.id] ?? 0}/${appCount[n.b.id] ?? 0}）`);
}

if (!execute) {
  console.log("\n調査のみです（DBは変更していません）。実行するには --execute を付けてください。");
  process.exit(0);
}

// ---- 実行: バックアップ → 統合 → 付け替え → アーカイブ
const targets = plan.filter((p) => p.blocked.length === 0);
const removeIds = targets.flatMap((p) => p.removable.map((l) => l.id));
const keepIds = targets.map((p) => p.keeper.id);
if (removeIds.length === 0) {
  console.log("整理できるグループがありません。");
  process.exit(0);
}
const backup = {
  at: new Date().toISOString(),
  lotteries: [...removeIds, ...keepIds].map((id) => lots.find((l) => l.id === id)).map((l) => ({ id: l.id, archived_at: l.archived_at, source_urls: l.source_urls, merged_sources: l.merged_sources ?? [] })),
  candidates: cands.filter((c) => removeIds.includes(c.lottery_id)),
  full: { lotteries: lots.filter((l) => removeIds.includes(l.id) || keepIds.includes(l.id)), items: IT.data.filter((i) => removeIds.includes(i.lottery_id)) },
};
mkdirSync("backups", { recursive: true });
const file = `backups/dedupe-7q-${backup.at.replace(/[:.]/g, "-")}.json`;
writeFileSync(file, JSON.stringify(backup, null, 1));
console.log(`バックアップ: ${file}`);

let merged = 0;
let relinked = 0;
for (const p of targets) {
  const urls = [...new Set([...(p.keeper.source_urls ?? []), ...p.removable.flatMap((l) => l.source_urls ?? [])])].slice(0, 10);
  // 統合元の記録（URL・収集日時・収集時の系列名・統合元の抽選ID・元データ）。同じ統合元は重複して保存しない
  const ms = Array.isArray(p.keeper.merged_sources) ? [...p.keeper.merged_sources] : [];
  for (const l of p.removable) {
    if (ms.some((m) => m.fromLotteryId === l.id)) continue;
    ms.push({ url: null, collectedAt: l.created_at, chainName: chainName(l.chain_id), mergedAt: new Date().toISOString(), reason: "重複整理（Stage 7Q）: 同じ系列・商品・店舗区分で、別の開催回と確認できない", fromLotteryId: l.id, snapshot: { store: { id: l.store_id, name: storeOf(l.store_id)?.name ?? "" }, storeMode: l.store_mode, items: items[l.id] ?? [], applyDeadline: l.apply_deadline_at ?? l.apply_deadline_date, applyStart: l.apply_start_at ?? l.apply_start_date, sourceUrls: l.source_urls ?? [], sourceKind: l.source_kind, createdAt: l.created_at } });
  }
  const u1 = await db.from("lotteries").update({ source_urls: urls, merged_sources: ms.slice(-30) }).eq("id", p.keeper.id);
  if (u1.error) throw new Error("情報源URLの統合に失敗しました");
  for (const l of p.removable) {
    const cs = cands.filter((c) => c.lottery_id === l.id);
    for (const c of cs) {
      const r = await db.from("collection_candidates").update({ status: "duplicate", lottery_id: p.keeper.id, job_state: "completed", triage: "auto_exclude", triage_reason: "重複整理", reasons: [`重複整理: 同じ抽選（${p.keeper.id.slice(0, 6)}）に統合しました`] }).eq("id", c.id);
      if (r.error) throw new Error("候補の付け替えに失敗しました");
      relinked++;
    }
    const a = await db.from("lotteries").update({ archived_at: new Date().toISOString() }).eq("id", l.id);
    if (a.error) throw new Error("アーカイブに失敗しました");
    merged++;
  }
}
console.log(`整理しました: 抽選${merged}件をアーカイブ・候補${relinked}件を付け替え（バックアップ ${file} から復元できます）`);
const skipped = plan.filter((p) => p.blocked.length > 0);
if (skipped.length > 0) console.log(`統合しなかったグループ: ${skipped.length}（要判断）`);
