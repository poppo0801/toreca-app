// Stage 9F-2: 正誤チェック用の事例集の書き出し（読み取り専用）。
//   本番:   npm run prod -- scripts/export-review-set.mjs --yes-production [--count=30] [--with-body]
//   開発DB: node scripts/export-review-set.mjs   （.env.local＝ローカルDBでの動作確認）
// 本番の個別の候補（題・情報源URL・AIの抽出結果・判断理由）と、重複の比較対象の抽選（系列・店舗・商品・応募期間・情報源URL）を、選定した約30件だけ書き出す。
//   書き出さないもの: 応募履歴・個人情報・認証情報・世帯ID・プロフィールID・メモ・会員情報。選定した事例以外の個別データは出力しない。
//   --with-body: 情報源のうち https の公開ページ（X・非公開・社内宛を除く）の本文を、1件ずつ間隔を空けて取得する（本番のDBには書き込まない外部サイトの読み取り。取得日時を記録）。
//                既定は取得しない。保存されていない本文は、チェックツールが「本文なし」と明示する。
// 書き込み・更新・削除は一切しない（select のみ）。出力: backups/review-sets/review-set-<対象>-<日時>.json（Git管理外）
import { createClient } from "@supabase/supabase-js";
import { mkdirSync, writeFileSync } from "node:fs";
import { buildCase, buildRegisteredDuplicateCase, htmlToText, isFetchableSourceUrl, pickCandidates } from "./lib/review-set-build.mjs";

const args = process.argv.slice(2);
const opt = (name, def) => args.find((a) => a.startsWith(`--${name}=`))?.split("=")[1] ?? def;
const total = Math.max(5, Math.min(60, Number(opt("count", "30")) || 30));
const withBody = args.includes("--with-body");
const dupGroupsWanted = Number(opt("dup-groups", "3"));
// Stage 9H-2: 評価済みの事例を除いて選ぶ（未使用の新規事例の書き出し）。--exclude-answers=<評価結果.json>（ローカルのファイルを読むだけ）
const excludeFile = opt("exclude-answers", "");
const excludedCaseIds = new Set();
if (excludeFile) {
  const a = JSON.parse((await import("node:fs")).readFileSync(excludeFile, "utf8"));
  for (const r of a.results ?? []) excludedCaseIds.add(r.caseId);
  console.log(`評価済みの事例 ${excludedCaseIds.size}件を除いて選びます`);
}

const isProd = process.env.TOREMANE_TARGET === "production";
if (!isProd) {
  try {
    process.loadEnvFile(".env.local");
  } catch {
    /* 環境変数が既に設定されている場合 */
  }
}
const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !key) throw new Error("接続先の設定がありません。中止します。");
const local = /^http:\/\/(127\.0\.0\.1|localhost)/.test(url);
if (!isProd && !local) throw new Error("本番への接続は npm run prod 経由のみです。中止します。");
console.log(`接続先: ${isProd ? "本番（読み取り専用）" : "ローカル開発DB（動作確認）"}  件数の目安: ${total}  本文の取得: ${withBody ? "する" : "しない"}`);
const db = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });

async function all(table, cols, filter = (q) => q) {
  const rows = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await filter(db.from(table).select(cols)).range(from, from + 999);
    if (error) throw new Error(`${table}: ${error.message}`);
    rows.push(...data);
    if (data.length < 1000) break;
  }
  return rows;
}

// 1) 軽量な候補一覧（本文・草稿なし）
const liteAll = await all("collection_candidates", "id,status,triage,triage_reason,reasons,kind,source_url,dedupe_key,origin_host,service_host,lottery_id,created_at,fetched_at,title");
const lite = liteAll.filter((c) => !excludedCaseIds.has(`k-${String(c.id).slice(0, 8)}`));

// 2) 特殊事例（店舗選択式・複数商品・店舗不明）の判定には草稿が必要。対象の状態の草稿だけ読む（メモリ上のみ。選ばなかった事例は出力しない）
const draftRows = await all("collection_candidates", "id,draft", (q) => q.in("status", ["auto_registered", "pending", "duplicate"]));
const draftById = new Map(draftRows.map((r) => [r.id, r.draft]));
const specialIds = new Set();
const specialTags = new Map();
for (const [id, d] of draftById) {
  const i = d && typeof d === "object" ? d.input : null;
  if (!i) continue;
  const tags = [];
  if (i.storeMode === "select_on_apply") tags.push("店舗選択式");
  if (Array.isArray(i.items) && i.items.length > 1) tags.push("複数商品");
  if (!i.store?.name && i.storeMode !== "select_on_apply") tags.push("店舗不明");
  if (tags.length) {
    specialIds.add(id);
    specialTags.set(id, tags);
  }
}

// 3) 登録済みの重複疑い（同じ系列・店舗・商品・締切）。比較対象の表示にも使うので、有効な抽選の表示用情報を作る
const lots = await all("lotteries", "id,chain_id,store_id,store_mode,source_kind,apply_start_date,apply_deadline_date,source_urls,created_at,archived_at", (q) => q.is("archived_at", null));
const items = await all("lottery_items", "lottery_id,product_id");
const chains = await all("chains", "id,name");
const stores = await all("stores", "id,name");
const products = await all("products", "id,official_name");
const nameOf = (rows, k = "name") => new Map(rows.map((r) => [r.id, r[k]]));
const chainName = nameOf(chains);
const storeName = nameOf(stores);
const prodName = nameOf(products, "official_name");
const prodsOf = new Map();
for (const it of items) prodsOf.set(it.lottery_id, [...(prodsOf.get(it.lottery_id) ?? []), it.product_id]);
const view = (l) => ({
  id: l.id,
  chain: chainName.get(l.chain_id) ?? null,
  store: l.store_mode === "select_on_apply" ? "（応募時に店舗を選択）" : (storeName.get(l.store_id) ?? null),
  products: (prodsOf.get(l.id) ?? []).map((p) => prodName.get(p)).filter(Boolean),
  applyStart: l.apply_start_date ?? null,
  applyDeadline: l.apply_deadline_date ?? null,
  sourceKind: l.source_kind,
  storeMode: l.store_mode,
  urls: (l.source_urls ?? []).slice(0, 4),
  createdAt: l.created_at,
});
const lotView = new Map(lots.map((l) => [l.id, view(l)]));
const groups = new Map();
for (const l of lots.filter((x) => x.store_mode === "fixed")) {
  const p = (prodsOf.get(l.id) ?? []).slice().sort().join(",");
  if (!p) continue;
  const k = `${l.chain_id}|${l.store_id}|${p}|${l.apply_deadline_date ?? ""}`;
  groups.set(k, [...(groups.get(k) ?? []), l]);
}
const dupGroups = [...groups.values()].filter((g) => g.length > 1).slice(0, dupGroupsWanted);

// 4) 選定
const dupCases = dupGroups.length;
const picked = pickCandidates(lite, Math.max(5, total - dupCases), specialIds);
const liteById = new Map(lite.map((c) => [c.id, c]));
const cases = [];
const body = async (u) => {
  if (!withBody || !u || !isFetchableSourceUrl(u)) return { bodyText: null, bodyNote: withBody ? "このURLは本文を取得できません（X・非公開・https以外）。情報元URLで確認してください。" : undefined };
  await new Promise((r) => setTimeout(r, 1500));
  try {
    const res = await fetch(u, { redirect: "follow", signal: AbortSignal.timeout(10_000), headers: { "User-Agent": "toremane-review-export/1.0" } });
    if (!res.ok) return { bodyText: null, bodyNote: `本文を取得できませんでした（HTTP ${res.status}）。情報元URLで確認してください。` };
    const ct = res.headers.get("content-type") ?? "";
    if (!/text\/html|text\/plain/.test(ct)) return { bodyText: null, bodyNote: "HTML以外のため本文を取得していません。情報元URLで確認してください。" };
    const text = htmlToText((await res.text()).slice(0, 2_000_000));
    return { bodyText: text || null, bodyFetchedAt: new Date().toISOString(), bodyNote: "書き出し時点のページ本文です（AIが読んだ時点と異なる可能性があります）。" };
  } catch {
    return { bodyText: null, bodyNote: "本文を取得できませんでした（接続失敗・時間切れ）。情報元URLで確認してください。" };
  }
};
for (const p of picked) {
  const row = { ...liteById.get(p.id), draft: draftById.get(p.id) ?? null };
  if (!row.draft && ["auto_registered", "pending", "duplicate"].includes(row.status)) row.draft = null;
  Object.assign(row, await body(row.source_url));
  const tags = [...new Set([...(p.tags ?? []), ...(specialTags.get(p.id) ?? [])])];
  // 比較対象: 草稿の重複・紐づく抽選のうち、有効な抽選として取得できているもの
  cases.push(buildCase(row, { category: p.category, tags }, lotView));
}
dupGroups.forEach((g, i) => cases.push(buildRegisteredDuplicateCase(lotView.get(g[0].id), lotView.get(g[1].id), i)));

const counts = cases.reduce((m, c) => ((m[c.category] = (m[c.category] ?? 0) + 1), m), {});
const generatedAt = new Date().toISOString();
const setId = `rs-${generatedAt.slice(0, 10)}-${cases.map((c) => c.caseId).join("").length.toString(36)}${Math.abs([...cases.map((c) => c.caseId).join(",")].reduce((h, ch) => (Math.imul(h, 31) + ch.charCodeAt(0)) | 0, 7)).toString(36)}`;
const set = { format: "toremane-review-set", version: 1, setId, generatedAt, target: isProd ? "production" : "local", withBody, note: "AIの判断に人間の評価は含まれません。評価は tools/review/index.html で入力し、別ファイルに書き出します。", counts, cases };
mkdirSync("backups/review-sets", { recursive: true });
const file = `backups/review-sets/review-set-${set.target}-${generatedAt.replace(/[:.]/g, "-")}.json`;
writeFileSync(file, JSON.stringify(set, null, 2));
console.log(`事例 ${cases.length}件`, JSON.stringify(counts));
console.log(`特殊事例の候補（草稿から判定）: ${specialIds.size}件／登録済みの重複疑いの組: ${dupGroups.length}件`);
console.log(`保存: ${file}`);
console.log("次: tools/review/index.html をブラウザで開き、このファイルを「事例集を開く」で選んでください。");
