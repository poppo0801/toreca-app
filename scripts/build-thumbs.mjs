// 商品画像の一覧用サムネイル（高さ288pxのWebP）を、すでに登録済みの画像から作る。既定はドライラン。
//   node scripts/build-thumbs.mjs            # ドライラン: 作る対象と見込みサイズを報告（何も書き込まない）
//   node scripts/build-thumbs.mjs --apply    # 実行: サムネイルを新しいパスに保存し、product_images.thumb_path だけ更新
// 元画像（storage_path）は読むだけで、変更・削除しない。サムネイルが元より小さくならない画像は作らない。何度実行しても同じ（冪等）。
// 秘密鍵は .env.local のみ。出力にURLや鍵は出さない。
import { existsSync, readFileSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";
import sharp from "sharp";

try {
  process.loadEnvFile(".env.local");
} catch {
  /* noop */
}
const apply = process.argv.includes("--apply");
const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !key) throw new Error(".env.local に NEXT_PUBLIC_SUPABASE_URL と SUPABASE_SERVICE_ROLE_KEY が必要です");
const linked = existsSync("supabase/.temp/project-ref") ? readFileSync("supabase/.temp/project-ref", "utf8").trim() : "";
if (!linked || !url.includes(linked)) throw new Error("接続先がトレカ専用プロジェクトと一致しません。中止します。");
const db = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });

const { data: rows, error } = await db.from("product_images").select("id,household_id,product_id,kind,storage_path,thumb_path,sha256");
if (error) throw error;
let made = 0, skipped = 0, failed = 0, before = 0, after = 0;
for (const r of rows) {
  if (r.thumb_path) { skipped++; continue; }
  const { data, error: e } = await db.storage.from("product-images").download(r.storage_path);
  if (e || !data) { failed++; continue; }
  const orig = Buffer.from(await data.arrayBuffer());
  const t = await sharp(orig).rotate().resize({ height: 288, withoutEnlargement: true }).webp({ quality: 82, alphaQuality: 90 }).toBuffer();
  if (t.length >= orig.length) { skipped++; continue; }
  before += orig.length;
  after += t.length;
  if (apply) {
    const tp = `${r.household_id}/${r.product_id}/thumb-${r.kind}-${r.sha256.slice(0, 12)}.webp`;
    const up = await db.storage.from("product-images").upload(tp, t, { contentType: "image/webp", upsert: true });
    if (up.error) { failed++; continue; }
    const { error: ue } = await db.from("product_images").update({ thumb_path: tp }).eq("id", r.id).is("thumb_path", null);
    if (ue) { failed++; continue; }
  }
  made++;
}
const kb = (n) => `${Math.round(n / 1024)}KB`;
console.log(`${apply ? "実行" : "ドライラン"}: 対象 ${rows.length} 件 / サムネイル${apply ? "作成" : "作成予定"} ${made} / 済み・不要 ${skipped} / 失敗 ${failed}`);
console.log(`元画像 合計 ${kb(before)} → サムネイル 合計 ${kb(after)}（${before ? Math.round((1 - after / before) * 100) : 0}% 削減）`);
