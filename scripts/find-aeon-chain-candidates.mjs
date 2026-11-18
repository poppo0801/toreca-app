// Stage 9H-3L: イオン関連の独立系列（イオンオンライン／イオンビッグ／イオンキッズリパブリック）の誤登録候補の検出（読み取り専用。何も書き込まない・自動修正しない）。
//   本番:   npm run prod -- scripts/find-aeon-chain-candidates.mjs --yes-production
//   開発DB: node scripts/find-aeon-chain-candidates.mjs
// 「イオン」系列などに登録されている店舗・抽選のうち、店舗名・系列名・情報元から、独立系列に当たる可能性があるものを一覧にする。
// 出力: backups/eval-9h3l/aeon-chain-candidates-<日時>.json（Git管理外。系列名・店舗名・件数・IDの先頭8桁のみ。世帯ID・個人情報は含めない）
// 修正は、一覧を人間が確認し、承認された手順（バックアップ→系列の作成→店舗・抽選の付け替え→元の系列はそのまま）で行う。応募・当選の履歴は付け替えのみで消さない。
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

// src/lib/chain-normalize.ts の INDEPENDENT_CHAINS と同じ規則（within）。
const ENT = [
  { key: "aeonkidsrepublic", name: "イオンキッズリパブリック", re: /(イオン|aeon)?(キッズリパブリック|kidsrepublic|キッズキパブリック)/ },
  { key: "aeonbig", name: "イオンビッグ", re: /(イオン|aeon)(ザ|the)?ビッグ|ザビッグ|thebig/ },
  { key: "aeonstyleonline", name: "イオンスタイルオンライン", re: /(イオン|aeon)スタイル(オンライン|online)/ },
  { key: "aeononline", name: "イオンオンライン", re: /(イオン|aeon)(オンライン|online)/ },
];
const fold = (s) => String(s ?? "").normalize("NFKC").toLowerCase().replace(/[・･.．,，、。'’"“”`´\-‐–—―_/／\|｜:：;；!！?？~〜～#＃*＊&＆+＋=＝]/g, "").replace(/[\s　]+/g, "");
const entityOf = (s) => ENT.find((e) => e.re.test(fold(s))) ?? null;
// 全体を1つの名称として見たときの系列名（先頭一致）。部分文字列に独立系列名が含まれるだけの文章は、店舗名・情報元の根拠として別に扱う
const startsEntity = (s) => ENT.find((e) => new RegExp(`^(${e.re.source})`).test(fold(s))) ?? null;

const chains = (await db.from("chains").select("id,name,archived_at,household_id").limit(5000)).data ?? [];
const stores = (await db.from("stores").select("id,name,chain_id").limit(50000)).data ?? [];
const lots = (await db.from("lotteries").select("id,chain_id,store_id,source_urls,archived_at").limit(50000)).data ?? [];
const apps = (await db.from("applications").select("lottery_id").limit(100000)).data ?? [];
const chainById = new Map(chains.map((c) => [c.id, c]));
const storeById = new Map(stores.map((s) => [s.id, s]));
const appCount = new Map();
for (const a of apps) appCount.set(a.lottery_id, (appCount.get(a.lottery_id) ?? 0) + 1);

const out = [];
for (const l of lots.filter((x) => !x.archived_at)) {
  const chain = chainById.get(l.chain_id);
  const store = storeById.get(l.store_id);
  if (!chain) continue;
  const chainEnt = startsEntity(chain.name);
  const reasons = [];
  let suggested = null;
  // 1) 店舗名が独立系列の名称（イオンビッグ○○店・キッズリパブリック○○店・イオンオンライン）で、登録先の系列が別（イオンなど）
  const storeEnt = store ? entityOf(store.name) : null;
  if (storeEnt && (!chainEnt || chainEnt.key !== storeEnt.key)) { suggested = storeEnt; reasons.push(`店舗名「${store.name}」が${storeEnt.name}に当たる`); }
  // 2) 系列名が「イオン」で、店舗が「オンライン」（イオンオンラインの可能性。イオンスタイルオンラインかは運営元・応募先URLの確認が必要）
  if (!suggested && /^(イオン|aeon)$/i.test(fold(chain.name)) && store && /^(オンライン|通販|online)$/i.test(fold(store.name))) { suggested = ENT.find((e) => e.key === "aeononline"); reasons.push("系列「イオン」の店舗が「オンライン」（イオンオンライン／イオンスタイルオンラインのどちらかは、運営元・応募先URLで要確認）"); }
  // 3) 情報元URLに独立系列を示す語（URLの文字列）がある場合は、補助的な根拠として示す
  const urlHit = (l.source_urls ?? []).find((u) => /kids-?republic|aeonbig|the-?big/i.test(u));
  if (suggested && urlHit) reasons.push("情報元URLにも関連する語がある");
  if (!suggested) continue;
  out.push({ lottery: String(l.id).slice(0, 8), currentChain: chain.name, currentStore: store?.name ?? "", suggestedChain: suggested.name, reasons, applications: appCount.get(l.id) ?? 0, needsOperatorCheck: suggested.key === "aeononline" });
}
const existing = chains.filter((c) => !c.archived_at && startsEntity(c.name)).map((c) => ({ name: c.name, key: startsEntity(c.name).key }));
mkdirSync("backups/eval-9h3l", { recursive: true });
const file = `backups/eval-9h3l/aeon-chain-candidates-${new Date().toISOString().replace(/[:.]/g, "-")}.json`;
writeFileSync(file, JSON.stringify({ target: isProd ? "production" : "local", existingIndependentChains: existing, candidates: out }, null, 1));
console.log(`既存の独立系列: ${existing.map((e) => e.name).join("・") || "なし"}`);
console.log(`誤登録の疑い: ${out.length}件（修正はしません。人間が確認してください）`);
for (const c of out) console.log(`  - 抽選${c.lottery}: ${c.currentChain} / ${c.currentStore} → 候補「${c.suggestedChain}」（応募${c.applications}件）${c.reasons.join("／")}`);
console.log(`書き出し: ${file}`);
console.log("\n【修正の手順（人間の承認後。この処理は何も変更しません）】\n  1. npm run backup:full\n  2. 独立系列の系列マスターを作成（または既存の系列を使う）\n  3. 該当の店舗（必要なら新しい店舗）と抽選を付け替える。応募・当選・購入の履歴は付け替えのみで、消さない\n  4. 元の系列（イオン）は残す。付け替え前後で、抽選・応募の件数が一致することを確認する");
