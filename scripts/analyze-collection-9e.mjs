// Stage 9E: 収集の実態分析（読み取り専用・件数と分類の集計のみ）。
//   本番:   npm run prod -- scripts/analyze-collection-9e.mjs --yes-production
//   開発DB: node scripts/analyze-collection-9e.mjs   （.env.local＝ローカルDBで、スクリプトの動作確認用）
// 取得するもの: 系列名・商品IDの集計に必要な最小限の列だけ。応募履歴・個人名・メール・住所・認証情報・告知の本文・条件文・メモは読まない。
// 書き込み・更新・削除は一切しない（select のみ）。出力は件数・分類・系列名（ブランド名）。結果は backups/analysis/ に保存（Git管理外）。
// 集計で分からない項目は「未測定」と出す（推測で補わない）。
import { createClient } from "@supabase/supabase-js";
import { mkdirSync, writeFileSync } from "node:fs";

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
console.log(`接続先: ${isProd ? "本番（読み取り専用）" : "ローカル開発DB（動作確認）"}`);
const db = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });

async function all(table, cols, filter = (q) => q) {
  const rows = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await filter(db.from(table).select(cols)).range(from, from + 999);
    if (error) return { error: `${table}: ${error.message}`, rows: [] };
    rows.push(...data);
    if (data.length < 1000) break;
  }
  return { rows };
}
const count = (arr, f) => arr.reduce((m, r) => ((m[f(r)] = (m[f(r)] ?? 0) + 1), m), {});
const errors = [];
const take = async (t, c, f) => {
  const r = await all(t, c, f);
  if (r.error) errors.push(r.error);
  return r.rows;
};

// 系列名の近似の正規化（アプリ内の正規化とは別実装。表記揺れの候補を数えるための近似）
const SUFFIX = /(ネット通販|オンラインストア|オンラインショップ|公式通販|公式オンライン|公式ストア|オンライン|通販|ネットショップ|ショッピング)$/;
const canon = (s) =>
  String(s)
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[\s・･.\-_()（）【】「」\[\]]/g, "")
    .replace(SUFFIX, "");

const since = new Date(Date.now() - 30 * 86400_000).toISOString();
const sinceDay = since.slice(0, 10);

const chains = await take("chains", "id,name,archived_at,is_provisional");
const aliases = await take("chain_aliases", "chain_id");
const stores = await take("stores", "id,chain_id,name,archived_at,is_provisional");
const lotteries = await take("lotteries", "id,chain_id,store_id,store_mode,source_kind,event_state,apply_deadline_precision,apply_deadline_date,auto_dedupe_key,source_urls,cautions,confidence,created_at");
const items = await take("lottery_items", "lottery_id,product_id");
const cands = await take("collection_candidates", "status,triage,triage_reason,reasons,created_at");
const sources = await take("collection_sources", "kind,enabled,status,last_new_count");
const attempts = await take("collection_source_attempts", "status,trigger,message,created_at", (q) => q.gte("created_at", since));
const runs = await take("collection_runs", "trigger,status,result,sources_total,sources_ok,sources_failed,items_found,new_count,registered_count,ai_calls,error_count,started_at", (q) => q.gte("started_at", since));
const daily = await take("collection_daily_stats", "day,discovered_new,registered_new,review_added,updated_existing,duplicates,excluded,ai_calls,ai_failed,cost_jpy", (q) => q.gte("day", sinceDay));

const out = { generatedAt: new Date().toISOString(), target: isProd ? "production" : "local", readErrors: errors, notMeasured: [] };

// 1) 系列名の表記揺れ
const live = chains.filter((c) => !c.archived_at);
const groups = new Map();
for (const c of live) {
  const k = canon(c.name);
  if (!k) continue;
  groups.set(k, [...(groups.get(k) ?? []), c]);
}
const aliasCount = count(aliases, (a) => a.chain_id);
const storeCountByChain = count(stores.filter((s) => !s.archived_at), (s) => s.chain_id);
const lotCountByChain = count(lotteries, (l) => l.chain_id);
out.chains = {
  total: chains.length,
  active: live.length,
  provisional: live.filter((c) => c.is_provisional).length,
  withoutStores: live.filter((c) => !storeCountByChain[c.id]).length,
  aliasRows: aliases.length,
  possibleVariantGroups: [...groups.values()]
    .filter((g) => g.length > 1)
    .map((g) => ({ names: g.map((c) => c.name), lotteries: g.map((c) => lotCountByChain[c.id] ?? 0), stores: g.map((c) => storeCountByChain[c.id] ?? 0) })),
  note: "possibleVariantGroups は近似の正規化で同じになる系列名の組（実際に同一系列かは人の確認が必要）",
};

// 2) 抽選の全体と、店舗が不明・仮の抽選
const storeById = new Map(stores.map((s) => [s.id, s]));
const unknownStoreRe = /不明|未確認|未定|店舗未|仮/;
const isUnknownStore = (l) => {
  const s = storeById.get(l.store_id);
  return !!s && (s.is_provisional || unknownStoreRe.test(s.name));
};
const active = lotteries.filter((l) => ["before", "open"].includes(l.event_state));
out.lotteries = {
  total: lotteries.length,
  active: active.length,
  byEventState: count(lotteries, (l) => l.event_state),
  bySourceKind: count(lotteries, (l) => l.source_kind),
  byStoreMode: count(lotteries, (l) => l.store_mode),
  storeUnknownOrProvisional: lotteries.filter(isUnknownStore).length,
  storeUnknownOrProvisionalActive: active.filter(isUnknownStore).length,
  deadlineUnknown: lotteries.filter((l) => l.apply_deadline_precision === "unknown").length,
  deadlineUnknownActive: active.filter((l) => l.apply_deadline_precision === "unknown").length,
  withDeadlineUnknownCaution: lotteries.filter((l) => JSON.stringify(l.cautions ?? []).includes("deadline_unknown")).length,
  createdLast30d: lotteries.filter((l) => l.created_at >= since).length,
  createdLast30dBySource: count(lotteries.filter((l) => l.created_at >= since), (l) => l.source_kind),
};

// 3) 店舗選択式と個別店舗の二重登録の疑い／登録済み抽選どうしの重複の疑い
const productsOf = new Map();
for (const it of items) productsOf.set(it.lottery_id, [...(productsOf.get(it.lottery_id) ?? []), it.product_id]);
const pkey = (l) => (productsOf.get(l.id) ?? []).slice().sort().join(",");
const urlsOf = (l) => (l.source_urls ?? []).map((u) => String(u).replace(/#.*$/, "").replace(/\/$/, ""));
const byChain = new Map();
for (const l of active) byChain.set(l.chain_id, [...(byChain.get(l.chain_id) ?? []), l]);
let selectWithFixed = 0;
const selectExamples = [];
let sameSignature = 0;
const sigExamples = [];
for (const [chainId, ls] of byChain) {
  const sel = ls.filter((l) => l.store_mode === "select_on_apply");
  const fixed = ls.filter((l) => l.store_mode === "fixed");
  for (const s of sel) {
    const hit = fixed.filter((f) => pkey(f) && pkey(f) === pkey(s) && (f.apply_deadline_date ?? "") === (s.apply_deadline_date ?? ""));
    if (hit.length) {
      selectWithFixed += 1;
      if (selectExamples.length < 10) selectExamples.push({ chain: live.find((c) => c.id === chainId)?.name ?? "?", individualStoreLotteries: hit.length });
    }
  }
  const sig = new Map();
  for (const f of fixed) if (pkey(f)) sig.set(`${pkey(f)}|${f.apply_deadline_date ?? ""}`, [...(sig.get(`${pkey(f)}|${f.apply_deadline_date ?? ""}`) ?? []), f]);
  for (const g of sig.values()) {
    const stores = new Set(g.map((x) => x.store_id));
    if (g.length > 1 && stores.size < g.length) {
      sameSignature += 1;
      if (sigExamples.length < 10) sigExamples.push({ chain: live.find((c) => c.id === chainId)?.name ?? "?", lotteries: g.length, distinctStores: stores.size });
    }
  }
}
const dedupeKeys = count(lotteries.filter((l) => l.auto_dedupe_key), (l) => l.auto_dedupe_key);
out.duplicates = {
  storeSelectWithMatchingIndividualLotteries: { count: selectWithFixed, examples: selectExamples, note: "同じ系列・同じ商品・同じ応募締切の、店舗選択式と店舗別が併存する数（二重登録の疑い。実際に重複かは人の確認が必要）" },
  sameStoreSameProductSameDeadline: { count: sameSignature, examples: sigExamples, note: "同じ系列・商品・締切で、同じ店舗の抽選が複数ある数（重複の疑い）" },
  autoDedupeKeyCollisions: Object.values(dedupeKeys).filter((n) => n > 1).length,
  candidateStatusDuplicate: cands.filter((c) => c.status === "duplicate").length,
};

// 4) 確認待ち（pending）の件数と原因の分類（analyze-review-queue.mjs と同じ分類）
const CAUSES = [
  ["region", "対象地域外", /対象外の地域|地域.*対象外|対象地域.*(外|不明)|都道府県が不明/],
  ["deadline", "締切・発表日などの情報不足", /応募締切が不明|締切.*(不明|未発表)|発表日|応募の日時が未発表|締切が近い/],
  ["conflict", "複数情報源の内容不一致", /矛盾|食い違/],
  ["product", "商品名の判別失敗", /商品.*(確実に判別|マスターに未登録|判別できません)|商品確認待ち/],
  ["chain_store", "系列・店舗の判別失敗", /系列を確実|店舗を確実|店舗.*特定できません|系列.*特定できません/],
  ["duplicate", "同一抽選か判定できない", /重複の疑い|同一の抽選か|似た抽選|重複/],
  ["apply", "応募URL・応募方法の不足", /応募先|応募方法|情報源URLがありません|応募URL/],
  ["receive", "受取方法・応募条件の不明", /受取方法|応募条件が分からない|居住地域/],
  ["fetch", "取得失敗（ページを読めない）", /取得できません|取得できて|robots|画像未取得|解析できていません/],
  ["mode", "複数商品の応募方式が不明", /応募方式/],
  ["lowinfo", "情報が少ない", /識別できる情報が少ない|情報が少ない/],
];
const pending = cands.filter((c) => c.status === "pending");
const causeCount = {};
for (const c of pending) {
  const texts = [...(c.reasons ?? []), c.triage_reason ?? ""];
  const hit = new Set();
  for (const t of texts) for (const [id, , re] of CAUSES) if (re.test(t)) hit.add(id);
  if (!hit.size) hit.add("other");
  for (const h of hit) causeCount[h] = (causeCount[h] ?? 0) + 1;
}
const label = Object.fromEntries([...CAUSES.map(([i, l]) => [i, l]), ["other", "その他"]]);
out.pending = {
  total: pending.length,
  byTriage: count(pending, (c) => c.triage ?? "(なし)"),
  byCause: Object.fromEntries(Object.entries(causeCount).map(([k, n]) => [label[k], n]).sort((a, b) => b[1] - a[1])),
  note: "原因は1件に複数あれば重複して数える",
};
out.candidates = { total: cands.length, byStatus: count(cands, (c) => c.status), createdLast30dByStatus: count(cands.filter((c) => c.created_at >= since), (c) => c.status) };

// 5) 情報源・取得の失敗（直近30日）・収集処理の成功／失敗
const msgClass = (m) => (/robots/.test(m) ? "robots" : /403|forbidden|アクセス制限|blocked/i.test(m) ? "アクセス制限" : /404|見つかり/.test(m) ? "ページなし" : /timeout|タイムアウト|時間/i.test(m) ? "タイムアウト" : /ログイン|認証|login/i.test(m) ? "ログイン必要" : /予算|budget|上限/.test(m) ? "解析上限" : m ? "その他" : "(なし)");
out.sources = {
  total: sources.length,
  byKind: count(sources, (s) => s.kind),
  enabled: sources.filter((s) => s.enabled).length,
  byStatus: count(sources, (s) => s.status),
  noNewLastRun: sources.filter((s) => s.enabled && s.last_new_count === 0).length,
};
const failed = attempts.filter((a) => a.status !== "ok");
out.attemptsLast30d = { total: attempts.length, byStatus: count(attempts, (a) => a.status), failedByClass: count(failed, (a) => msgClass(a.message ?? "")), byTrigger: count(attempts, (a) => a.trigger) };
out.runsLast30d = {
  total: runs.length,
  byTrigger: count(runs, (r) => r.trigger),
  byResult: count(runs, (r) => r.result ?? r.status),
  sum: ["sources_total", "sources_ok", "sources_failed", "items_found", "new_count", "registered_count", "ai_calls", "error_count"].reduce((m, k) => ((m[k] = runs.reduce((a, r) => a + (r[k] ?? 0), 0)), m), {}),
};
const sumd = (k) => Math.round(daily.reduce((a, r) => a + Number(r[k] ?? 0), 0) * 100) / 100;
out.dailyLast30d = { days: daily.length, discovered_new: sumd("discovered_new"), registered_new: sumd("registered_new"), review_added: sumd("review_added"), updated_existing: sumd("updated_existing"), duplicates: sumd("duplicates"), excluded: sumd("excluded"), ai_calls: sumd("ai_calls"), ai_failed: sumd("ai_failed"), cost_jpy: sumd("cost_jpy") };

out.notMeasured = [
  "店舗名が『不明』の抽選の真の件数（名前の語・仮フラグでの近似。実際の判別は人の確認が必要）",
  "誤登録・誤更新の率（人の確認が必要）",
  "抽選ではないページを抽選と誤認した率（収集記録に判定の正否が残らない）",
  "X投稿の取得失敗の理由（記録の粒度による）",
];

console.log(JSON.stringify(out, null, 2));
mkdirSync("backups/analysis", { recursive: true });
const file = `backups/analysis/collection-9e-${out.target}-${out.generatedAt.replace(/[:.]/g, "-")}.json`;
writeFileSync(file, JSON.stringify(out, null, 2));
console.log(`\n保存しました: ${file}（Git管理外）`);
if (errors.length) console.log(`読み取りで失敗した表: ${errors.join(" / ")}（その項目は未測定）`);
