// 重複して登録された抽選の安全な整理（Stage 6C）。既定は調査のみ（dry-run）。DBは変更しない。
//
//   node scripts/dedupe-lotteries.mjs                     # 重複グループの調査と整理計画を表示
//   node scripts/dedupe-lotteries.mjs --execute           # バックアップ(backups/dedupe-6c-*.json)を取得し、整理を実行
//   node scripts/dedupe-lotteries.mjs --restore <ファイル> # 整理を元に戻す（バックアップから復元）
//
// 同一とみなす条件（すべて）: 系列が同じ（「通販」「オンライン」等の語を除いた名称が同じ）・商品が共通・応募締切日が同じ・
//   店舗が同じ、または双方が「オンライン」等の販売形態。商品と締切日だけが一致する別の店舗・別の系列は統合しない。
// 整理できる条件（残す側以外のすべて）: 自動登録（source_kind=auto）・手動修正なし・★管理でない・応募/当落/購入/スルー/例外/通知/優先収集メモの記録が無い。
//   1つでも当てはまらないグループは、自動では統合せず「要判断」として報告する。
// 処理: 残す抽選に情報源URLを統合 → 不要な抽選に紐づく収集候補を「重複」として残す抽選へ付け替え → 不要な抽選をアーカイブ（物理削除しない。復元可能）。
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
  for (const l of b.lotteries) await db.from("lotteries").update({ archived_at: l.archived_at, source_urls: l.source_urls }).eq("id", l.id);
  for (const c of b.candidates) await db.from("collection_candidates").update({ status: c.status, lottery_id: c.lottery_id, reasons: c.reasons, job_state: c.job_state, triage: c.triage, triage_reason: c.triage_reason }).eq("id", c.id);
  console.log(`復元しました: 抽選${b.lotteries.length}件・候補${b.candidates.length}件`);
  process.exit(0);
}

const [L, IT, CH, ST, PR] = await Promise.all([
  db.from("lotteries").select("*").is("archived_at", null),
  db.from("lottery_items").select("lottery_id,product_id"),
  db.from("chains").select("id,name"),
  db.from("stores").select("id,name,sales_kind"),
  db.from("products").select("id,official_name"),
]);
for (const r of [L, IT, CH, ST, PR]) if (r.error) throw new Error("読み取りに失敗しました");
const lots = L.data;
const items = {};
for (const x of IT.data) (items[x.lottery_id] ??= []).push(x.product_id);
const chainName = (id) => CH.data.find((c) => c.id === id)?.name ?? "";
const storeOf = (id) => ST.data.find((s) => s.id === id);
const isOnline = (l) => { const s = storeOf(l.store_id); return !!s && (onlineName(s.name) || s.sales_kind === "online_only"); };

// 同一判定 → 連結成分
const same = (a, b) => {
  if (a.id === b.id) return false;
  if (chainKey(chainName(a.chain_id)) !== chainKey(chainName(b.chain_id)) || !chainKey(chainName(a.chain_id))) return false;
  if (!(items[a.id] ?? []).some((p) => (items[b.id] ?? []).includes(p))) return false;
  if (!jstDay(a) || jstDay(a) !== jstDay(b)) return false;
  return a.store_id === b.store_id || (isOnline(a) && isOnline(b));
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

const score = (l) => (l.source_kind === "manual" ? 100 : 0) + (l.updated_by_profile_id ? 50 : 0) + (l.result_date || l.result_at ? 5 : 0) + (l.conditions_text ? 5 : 0) + Math.min(10, (l.memo ?? "").length / 50) + (l.source_urls ?? []).length + (l.announcement_url ? 2 : 0) + (l.apply_method !== "unknown" ? 1 : 0);
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

console.log(`重複グループ: ${dupGroups.length}`);
for (const p of plan) {
  const label = (l) => `${l.id.slice(0, 6)}(${chainName(l.chain_id)}/${storeOf(l.store_id)?.name ?? "-"} ${jstDay(l)} ${l.source_kind} 情報源${(l.source_urls ?? []).length}件)`;
  console.log(`- 残す: ${label(p.keeper)}`);
  for (const l of p.removable) console.log(`    整理: ${label(l)}${p.blocked.find((x) => x.l.id === l.id) ? `  ★統合しない（要判断）: ${p.blocked.find((x) => x.l.id === l.id).b.join("・")}` : ""}`);
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
  lotteries: [...removeIds, ...keepIds].map((id) => lots.find((l) => l.id === id)).map((l) => ({ id: l.id, archived_at: l.archived_at, source_urls: l.source_urls })),
  candidates: cands.filter((c) => removeIds.includes(c.lottery_id)),
  full: { lotteries: lots.filter((l) => removeIds.includes(l.id) || keepIds.includes(l.id)), items: IT.data.filter((i) => removeIds.includes(i.lottery_id)) },
};
mkdirSync("backups", { recursive: true });
const file = `backups/dedupe-6c-${backup.at.replace(/[:.]/g, "-")}.json`;
writeFileSync(file, JSON.stringify(backup, null, 1));
console.log(`バックアップ: ${file}`);

let merged = 0;
let relinked = 0;
for (const p of targets) {
  const urls = [...new Set([...(p.keeper.source_urls ?? []), ...p.removable.flatMap((l) => l.source_urls ?? [])])].slice(0, 10);
  const u1 = await db.from("lotteries").update({ source_urls: urls }).eq("id", p.keeper.id);
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
