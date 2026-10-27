// 商品画像の復元: バックアップ内の storage/product-images/ を、Supabase Storage の同じパスへ戻す。
// 既に存在するファイルは上書きしない（アプリで差し替えた最新の画像を古いバックアップで壊さないため）。
// 復元先は .env.local の接続先（先に DB の product_images が復元済みであること）。既定はドライラン。
//   node scripts/restore-images.mjs --dir <バックアップのフォルダ>          # 確認のみ
//   node scripts/restore-images.mjs --dir <バックアップのフォルダ> --apply   # 不足分だけアップロード
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { createClient } from "@supabase/supabase-js";

try {
  process.loadEnvFile(".env.local");
} catch {
  /* 環境変数が既に設定されている場合 */
}
const args = process.argv.slice(2);
const dirIdx = args.indexOf("--dir");
if (dirIdx < 0 || !args[dirIdx + 1]) throw new Error("--dir <バックアップのフォルダ> を指定してください");
const dir = args[dirIdx + 1];
const apply = args.includes("--apply");

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !key) throw new Error(".env.local に URL と SUPABASE_SERVICE_ROLE_KEY が必要です");
const linked = (existsSync("supabase/.temp/project-ref") ? readFileSync("supabase/.temp/project-ref", "utf8") : "").trim();
if (!linked || !url.includes(linked)) throw new Error("接続先がリンク済みのトレカ専用プロジェクトと一致しません。中止します。");

const manifest = JSON.parse(readFileSync(join(dir, "_manifest.json"), "utf8"));
if (!manifest.images) throw new Error("このバックアップには商品画像が含まれていません");
const supabase = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
const MIME = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", webp: "image/webp" };

let uploaded = 0;
let skipped = 0;
let missingFile = 0;
for (const [path, meta] of Object.entries(manifest.images.files)) {
  const file = join(dir, "storage", "product-images", path);
  if (!existsSync(file)) {
    console.error(`  バックアップにファイルがありません: ${path}`);
    missingFile++;
    continue;
  }
  const buf = readFileSync(file);
  if (createHash("sha256").update(buf).digest("hex") !== meta.sha256) {
    console.error(`  内容が一致しないためスキップ: ${path}`);
    missingFile++;
    continue;
  }
  const exists = await supabase.storage.from("product-images").download(path);
  if (!exists.error) {
    skipped++;
    continue;
  }
  if (!apply) {
    console.log(`  復元予定: ${path}`);
    uploaded++;
    continue;
  }
  const { error } = await supabase.storage.from("product-images").upload(path, buf, { contentType: MIME[path.split(".").pop()?.toLowerCase() ?? ""] ?? "application/octet-stream", upsert: false });
  if (error) {
    console.error(`  失敗: ${path}: ${error.message}`);
    missingFile++;
  } else uploaded++;
}
console.log(`${apply ? "復元" : "ドライラン"}: ${apply ? "アップロード" : "復元予定"} ${uploaded}枚 / 既に存在 ${skipped}枚 / 問題 ${missingFile}枚`);
if (!apply) console.log("実際に復元するには --apply を付けてください。");
if (missingFile > 0) process.exit(1);
