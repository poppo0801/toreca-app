// Stage 9F: 除外・重複・自動登録の理由の分類集計（読み取り専用・件数のみ）。
//   本番:   npm run prod -- scripts/analyze-collection-9f.mjs --yes-production
//   開発DB: node scripts/analyze-collection-9f.mjs   （.env.local＝ローカルDBでの動作確認）
// 取得する列は status / triage / triage_reason / reasons / job_state / fail_kind / created_at のみ（システムが生成した理由の文言。告知の本文・応募履歴・個人情報は読まない）。
// 出力は分類ごとの件数だけ（理由の文言そのものは出力しない）。書き込みなし。正誤の判定は人の確認が必要なため「未測定」として分ける。
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

const rows = [];
for (let from = 0; ; from += 1000) {
  const { data, error } = await db.from("collection_candidates").select("status,triage,triage_reason,reasons,job_state,fail_kind,created_at").range(from, from + 999);
  if (error) throw new Error(`collection_candidates: ${error.message}`);
  rows.push(...data);
  if (data.length < 1000) break;
}

// 除外の理由の分類。「収集条件による除外」は利用者の設定どおりの正常な除外（理由の文言はシステム生成）。それ以外は誤除外の疑いとして人の確認が必要
const GROUPS = [
  ["user_condition_region", "収集条件: 対象外の地域・距離", /対象外の地域|直線で約|上限.*を超えて/],
  ["user_condition_tcg", "収集条件: 他TCG・除外する商品", /他TCG|除外する商品|対象外のTCG|ポケモン以外|別のTCG/],
  ["user_condition_method", "収集条件: 受取・応募方法・通販の設定", /受取方法が収集条件|応募方法が収集条件|通販・発送の抽選は収集しない|除外する応募条件|必要な応募条件/],
  ["ended_or_before", "応募期間外（終了・開始前）", /応募締切を過ぎ|まだ応募開始前|応募受付が終了/],
  ["excluded_chain", "除外設定の系列", /除外.*系列|系列.*除外/],
  ["merged", "同じ抽選の候補へ統合", /統合しました|へ統合/],
  ["user_excluded", "利用者が対象外にした", /利用者が.*対象外|利用者が除外/],
  ["not_lottery", "抽選の告知ではない", /抽選.*(ではありません|ではない|認識できません|ありません)|告知ではない/],
];
const classify = (texts) => {
  for (const [id, , re] of GROUPS) if (texts.some((t) => re.test(t))) return id;
  return "other_unclassified";
};
const label = Object.fromEntries([...GROUPS.map(([i, l]) => [i, l]), ["other_unclassified", "その他（分類できない。誤除外の疑いは人の確認が必要）"]]);
const count = (arr, f) => arr.reduce((m, r) => ((m[f(r)] = (m[f(r)] ?? 0) + 1), m), {});
const named = (o) => Object.fromEntries(Object.entries(o).map(([k, n]) => [label[k] ?? k, n]).sort((a, b) => b[1] - a[1]));
const texts = (c) => [...(c.reasons ?? []), c.triage_reason ?? ""].map(String);

// 登録済み抽選: 同じ系列・店舗・商品・締切の複数登録を、登録元の組み合わせ・情報源URLの共有で切り分ける（件数のみ。店舗名・商品名は出力しない）
async function allRows(table, cols, filter = (q) => q) {
  const out = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await filter(db.from(table).select(cols)).range(from, from + 999);
    if (error) throw new Error(`${table}: ${error.message}`);
    out.push(...data);
    if (data.length < 1000) break;
  }
  return out;
}
const lots = await allRows("lotteries", "id,chain_id,store_id,store_mode,source_kind,apply_deadline_date,source_urls,archived_at", (q) => q.is("archived_at", null));
const items = await allRows("lottery_items", "lottery_id,product_id");
const stores = await allRows("stores", "id,is_provisional,sales_kind");
const storeById = new Map(stores.map((s) => [s.id, s]));
const prodsOf = new Map();
for (const it of items) prodsOf.set(it.lottery_id, [...(prodsOf.get(it.lottery_id) ?? []), it.product_id]);
const sigGroups = new Map();
for (const l of lots.filter((x) => x.store_mode === "fixed")) {
  const p = (prodsOf.get(l.id) ?? []).slice().sort().join(",");
  if (!p) continue;
  const k = `${l.chain_id}|${l.store_id}|${p}|${l.apply_deadline_date ?? ""}`;
  sigGroups.set(k, [...(sigGroups.get(k) ?? []), l]);
}
const dupGroups = [...sigGroups.values()].filter((g) => g.length > 1);
const urlKey = (u) => String(u).replace(/#.*$/, "").replace(/\/$/, "");
const kindCombo = (g) => [...g.map((x) => x.source_kind)].sort().join("+");
const sharesUrl = (g) => g.some((a, i) => g.slice(i + 1).some((b) => (a.source_urls ?? []).some((u) => (b.source_urls ?? []).map(urlKey).includes(urlKey(u)))));
const onlineOrProvisional = (g) => {
  const s = storeById.get(g[0].store_id);
  return !!s && (s.is_provisional === true || s.sales_kind === "online_only");
};
const duplicateGroups = {
  total: dupGroups.length,
  byRegistrationKinds: count(dupGroups, kindCombo),
  sharingSourceUrl: dupGroups.filter(sharesUrl).length,
  onOnlineOrProvisionalStore: dupGroups.filter(onlineOrProvisional).length,
  note: "同じ系列・店舗・商品・締切の複数登録の組。auto+auto は自動登録どうし（自動の重複防止をすり抜けた疑い）、manual を含む組は手動登録（重複の警告は出るが登録は許可される）。実際に重複かは告知の内容を見ないと決められない",
};

const excluded = rows.filter((c) => c.status === "excluded");
const duplicate = rows.filter((c) => c.status === "duplicate");
const failed = rows.filter((c) => c.status === "failed");
const out = {
  generatedAt: new Date().toISOString(),
  target: isProd ? "production" : "local",
  notMeasured: ["除外の正誤（実際に有効な抽選が除外されたか）は告知の内容を見ないと決められない。件数は分類のみ", "重複判定の正誤"],
  excluded: { total: excluded.length, byGroup: named(count(excluded, (c) => classify(texts(c)))), byTriage: count(excluded, (c) => c.triage ?? "(なし)") },
  duplicate: { total: duplicate.length, merged: duplicate.filter((c) => texts(c).some((t) => /統合/.test(t))).length, byTriage: count(duplicate, (c) => c.triage ?? "(なし)") },
  registeredDuplicateGroups: duplicateGroups,
  failed: { total: failed.length, byFailKind: count(failed, (c) => c.fail_kind ?? "(なし)"), byJobState: count(failed, (c) => c.job_state ?? "(なし)") },
  autoRegistered: { total: rows.filter((c) => c.status === "auto_registered").length },
};
console.log(JSON.stringify(out, null, 2));
mkdirSync("backups/analysis", { recursive: true });
const file = `backups/analysis/collection-9f-${isProd ? "production" : "local"}-${out.generatedAt.replace(/[:.]/g, "-")}.json`;
writeFileSync(file, JSON.stringify(out, null, 2));
console.log(`保存: ${file}`);
