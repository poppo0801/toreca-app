// Stage 9H-3J: 重複した系列（同じ系列の別表記）の検出（読み取り専用。何も書き込まない・統合しない）。
//   本番:   npm run prod -- scripts/find-duplicate-chains.mjs --yes-production
//   開発DB: node scripts/find-duplicate-chains.mjs
// 系列の正規形（表記揺れ・括弧書きの読み・販売チャネル語・英語/カタカナ表記）が一致する系列を、グループとして表示する。
// 統合は行わない。安全な移行手順（人間が確認してから実施）は、出力の最後と docs/stage9h3j.md に示す。
// 出力: backups/eval-9h3j/duplicate-chains-<日時>.json（Git管理外。系列名・件数のみ。個人情報・世帯IDは含めない）
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

// src/lib/chain-normalize.ts の正規化と同じ規則（簡易版。照合の目安。実際の統合は人間が確認する）
const SYN = [
  [/^(ブックオフ|bookoff)(スーパーバザー)?/, "bookoff"],
  [/^(ツタヤ|tsutaya)/, "tsutaya"],
  [/^(ゲオ|geo)(?![a-z])/, "geo"],
  [/^(ヤマダ電機|ヤマダデンキ|yamada)/, "yamada"],
  [/^(ビックカメラ|biccamera)/, "biccamera"],
  [/^(ヨドバシ|ヨドバシカメラ|yodobashi)/, "yodobashi"],
  [/^(イオン|aeon)(?!九州)/, "aeon"],
  [/^(古本市場|ふるいち)/, "furuichi"],
  [/^(イエローサブマリン|イエサブ|yellowsubmarine)/, "yellowsubmarine"],
];
const CH = /(ネット通販サイト|ネット通販|ネットショッピング|ネットショップ|ネットストア|通販サイト|オンラインショッピング|オンラインショップ|オンラインストア|オンライン通販|オンライン|通販部|通販|公式サイト|公式ストア|公式ショップ|公式|ショップ|ストア|web|ウェブ)+$/;
const fold = (s) => s.normalize("NFKC").toLowerCase().replace(/(株式会社|有限会社|\(株\)|（株）)/g, "").replace(/[・･.．,，、。'’"“”`´\-‐–—―_/／\\|｜:：;；!！?？~〜～#＃*＊&＆+＋=＝]/g, "").replace(/[\s　]+/g, "");
function keyOf(raw) {
  const nk = raw.normalize("NFKC");
  const base = nk.replace(/[（(［\[【〈<][^）)］\]】〉>]*[）)］\]】〉>]/g, " ");
  let core = fold(base) || fold(nk);
  const st = core.replace(CH, "");
  if (st && st !== core) core = st;
  for (const [re, c] of SYN) if (re.test(core)) { core = core.replace(re, c); break; }
  return core;
}

const chains = (await db.from("chains").select("id,name,is_provisional,archived_at,household_id").limit(5000)).data ?? [];
const aliases = (await db.from("chain_aliases").select("chain_id,alias").limit(10000)).data ?? [];
const stores = (await db.from("stores").select("chain_id").limit(50000)).data ?? [];
const lots = (await db.from("lotteries").select("chain_id").limit(50000)).data ?? [];
const count = (rows, id) => rows.filter((r) => r.chain_id === id).length;
const groups = new Map();
for (const c of chains.filter((x) => !x.archived_at)) {
  const k = `${c.household_id}|${keyOf(c.name)}`;
  groups.set(k, [...(groups.get(k) ?? []), c]);
}
const dup = [...groups.values()].filter((g) => g.length > 1);
const report = dup.map((g) => ({
  chains: g.map((c) => ({ id: c.id, name: c.name, provisional: !!c.is_provisional, aliases: aliases.filter((a) => a.chain_id === c.id).map((a) => a.alias), stores: count(stores, c.id), lotteries: count(lots, c.id) })),
}));
mkdirSync("backups/eval-9h3j", { recursive: true });
const out = `backups/eval-9h3j/duplicate-chains-${new Date().toISOString().replace(/[:.]/g, "-")}.json`;
writeFileSync(out, JSON.stringify({ target: isProd ? "production" : "local", groups: report }, null, 1));
console.log(`重複の疑いがある系列グループ: ${report.length}件（系列 ${chains.length}件中）`);
for (const g of report) console.log("  - " + g.chains.map((c) => `${c.name}${c.provisional ? "(仮)" : ""}[店舗${c.stores}・抽選${c.lotteries}]`).join(" / "));
console.log(`書き出し: ${out}`);
console.log(`
【安全な移行手順（人間が確認してから実施。この処理は何も変更しません）】
  1. npm run backup:full で完全バックアップを取る（復元手順: docs/RESTORE.md）
  2. 各グループで「残す系列」を決める（登録・確認済みの系列、店舗・抽選の多い方を優先。仮登録(provisional)は統合される側）
  3. 統合される側の名前を、残す系列の別名（chain_aliases）に追加する → 以後の収集・登録で同じ系列として照合される
  4. 統合される側の店舗・抽選は、アプリの系列の統合機能（または承認済みの手順の SQL）で、残す系列へ付け替える。重複する店舗は先に店舗を統合する
  5. 統合される側の系列は削除せず、アーカイブする（人間が登録・確認した情報を削除しない）。応募履歴・購入記録は付け替えのみで、消さない
  6. 実行前後で、系列・店舗・抽選・応募の件数が一致することを確認する`);
