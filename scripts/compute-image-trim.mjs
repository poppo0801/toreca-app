// 既存の商品画像について、透明な余白を除いた表示範囲（product_images.content_box）を計算して記録する。
// 画像ファイルは読み取るだけで、変更・削除・アップロードはしない。書き込むのはメタデータ(content_box)だけ。
// 既定はドライラン（--apply を付けたときだけ記録）。既に値がある画像は --force なしでは触らない。
//   node scripts/compute-image-trim.mjs            # 確認のみ
//   node scripts/compute-image-trim.mjs --apply    # 未計算の画像に記録
import { existsSync, readFileSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";
import sharp from "sharp";

try {
  process.loadEnvFile(".env.local");
} catch {
  /* 環境変数が既に設定されている場合 */
}
const apply = process.argv.includes("--apply");
const force = process.argv.includes("--force");
const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !key) throw new Error(".env.local に URL と SUPABASE_SERVICE_ROLE_KEY が必要です");
const linked = (existsSync("supabase/.temp/project-ref") ? readFileSync("supabase/.temp/project-ref", "utf8") : "").trim();
if (!linked || !url.includes(linked)) throw new Error("接続先がリンク済みのトレカ専用プロジェクトと一致しません。中止します。");

const supabase = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
const ALPHA = 12;
const MIN_TRIM = 0.04;

async function contentBox(buf) {
  const img = sharp(buf, { failOn: "none" });
  const meta = await img.metadata();
  if (!meta.hasAlpha || !meta.width || !meta.height) return null;
  const { data, info } = await img.ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  let [minX, minY, maxX, maxY] = [info.width, info.height, -1, -1];
  for (let y = 0; y < info.height; y++)
    for (let x = 0; x < info.width; x++)
      if (data[(y * info.width + x) * info.channels + (info.channels - 1)] > ALPHA) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
  if (maxX < 0) return null;
  const box = { x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1 };
  return 1 - box.w / info.width < MIN_TRIM && 1 - box.h / info.height < MIN_TRIM ? null : box;
}

const { data: rows, error } = await supabase.from("product_images").select("id,storage_path,width,height,content_box").order("id");
if (error) throw new Error(`product_images: ${error.message}（マイグレーション 20261029000017 が未適用の可能性があります）`);

let changed = 0;
let skipped = 0;
for (const r of rows) {
  if (r.content_box && !force) {
    skipped++;
    continue;
  }
  const { data: blob, error: e } = await supabase.storage.from("product-images").download(r.storage_path);
  if (e || !blob) {
    console.error(`  取得できません: ${r.storage_path}`);
    continue;
  }
  const box = await contentBox(Buffer.from(await blob.arrayBuffer()));
  console.log(`  ${r.storage_path}: ${box ? `余白を除く ${JSON.stringify(box)}（元 ${r.width}x${r.height}）` : "補正なし"}`);
  if (apply && box) {
    const { error: ue } = await supabase.from("product_images").update({ content_box: box }).eq("id", r.id);
    if (ue) console.error(`  記録に失敗: ${ue.message}`);
    else changed++;
  }
}
console.log(`${apply ? "記録" : "ドライラン"}: ${apply ? changed : "（--apply で記録）"}件 / 記録済みのためスキップ ${skipped}件 / 全${rows.length}件`);
