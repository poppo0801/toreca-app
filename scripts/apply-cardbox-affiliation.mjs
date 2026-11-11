// カードボックスの所属確定（Stage 7R・利用者の指示）: 所属未確認の3店舗とロゴを直営へ移し、公式の直営店一覧の未登録店舗を直営として追加する。
//   node scripts/apply-cardbox-affiliation.mjs            調査のみ
//   node scripts/apply-cardbox-affiliation.mjs --execute  バックアップ後に実行（削除はしない）
import { createClient } from "@supabase/supabase-js";
import { mkdirSync, writeFileSync } from "node:fs";
try { process.loadEnvFile(".env.local"); } catch { /* */ }
const db = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
const execute = process.argv.includes("--execute");
// 直営店（公式の一覧）。既存の店舗名は「オーサカ店」「日本橋店」「京都店」
const DIRECT = [["オーサカ店", "大阪府"], ["日本橋店", "大阪府"], ["横浜西口店", "神奈川県"], ["横浜西口2号店", "神奈川県"], ["ヨコハマ本店", "神奈川県"], ["津店", "三重県"], ["名張店", "三重県"], ["広島店", "広島県"], ["京都店", "京都府"], ["池袋店", "東京都"]];
const { data: chains } = await db.from("chains").select("*").eq("brand_group", "カードボックス");
const by = (k) => chains.find((c) => c.operation_kind === k);
const unk = by("unconfirmed"), dir = by("direct");
const { data: allStores } = await db.from("stores").select("*").in("chain_id", chains.map((c) => c.id));
const oldStores = allStores.filter((s) => s.chain_id === unk.id);
const { data: lots } = await db.from("lotteries").select("*").eq("chain_id", unk.id);
const strayLots = lots.filter((l) => !oldStores.some((s) => s.id === l.store_id));
const have = new Set(allStores.filter((s) => s.chain_id === dir.id || s.chain_id === unk.id).map((s) => s.name));
const toAdd = DIRECT.filter(([n]) => !have.has(n));
const rel = {};
for (const [t, col] of [["chain_requirements", "chain_id"], ["profile_target_rules", "chain_id"], ["purchases", "chain_id"], ["collection_rules", "chain_id"], ["collection_candidates", "lottery_id"]].slice(0, 4)) { const r = await db.from(t).select("id", { count: "exact", head: true }).eq(col, unk.id); rel[t] = r.error ? "?" : r.count; }
console.log(`移す店舗 ${oldStores.map((s) => s.name)} ／抽選${lots.length}件(店舗なし${strayLots.length}) ／追加する直営 ${toAdd.map(([n]) => n)} ／未確認系列を参照する他データ ${JSON.stringify(rel)} ／ロゴ ${unk.logo_path ? "あり" : "なし"}`);
if (!execute) process.exit(0);
if (strayLots.length) throw new Error("店舗のない抽選があるため中止");
mkdirSync("backups", { recursive: true });
const file = `backups/cardbox-affiliation-${new Date().toISOString().replace(/[:.]/g, "-")}.json`;
writeFileSync(file, JSON.stringify({ chains, stores: allStores, lotteries: lots }, null, 1));
console.log("バックアップ", file);
const E = (r, m) => { if (r.error) throw new Error(m + ": " + r.error.message); };
// ロゴ: 未確認 → 直営（ファイルを直営IDの名前で複製してから付け替える）
if (unk.logo_path && !dir.logo_path) {
  const dl = await db.storage.from("product-images").download(unk.logo_path); E(dl, "ロゴの取得");
  const path = `${dir.household_id}/chain-logos/${dir.id}-${unk.logo_sha256.slice(0, 12)}.png`;
  E(await db.storage.from("product-images").upload(path, Buffer.from(await dl.data.arrayBuffer()), { contentType: "image/png", upsert: true }), "ロゴの保存");
  E(await db.from("chains").update({ logo_path: path, logo_sha256: unk.logo_sha256 }).eq("id", dir.id), "直営のロゴ設定");
  E(await db.from("chains").update({ logo_path: null, logo_sha256: null }).eq("id", unk.id), "未確認のロゴ解除");
  await db.storage.from("product-images").remove([unk.logo_path]);
  console.log("ロゴを直営へ移動");
}
for (const s of oldStores) E(await db.from("stores").update({ chain_id: dir.id, is_provisional: false }).eq("id", s.id), "店舗の移動");
if (lots.length) E(await db.from("lotteries").update({ chain_id: dir.id }).eq("chain_id", unk.id), "抽選の移動");
if (toAdd.length) E(await db.from("stores").insert(toAdd.map(([name, prefecture]) => ({ household_id: dir.household_id, chain_id: dir.id, name, prefecture, is_provisional: false }))), "店舗の追加");
console.log(`完了: 店舗${oldStores.length}件・抽選${lots.length}件を直営へ、${toAdd.length}店舗を追加`);
