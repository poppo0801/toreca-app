// 商品画像の実サイズ調査（読み取り専用）。表示サイズ(高さ約96px)に対して元画像がどれだけ大きいかを集計する。
//   node scripts/image-audit.mjs
// 秘密鍵は .env.local のみ。出力は件数・サイズの集計だけ（URLや鍵は出さない）。
import { existsSync, readFileSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";
import sharp from "sharp";

try {
  process.loadEnvFile(".env.local");
} catch {
  /* noop */
}
const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !key) throw new Error(".env.local に NEXT_PUBLIC_SUPABASE_URL と SUPABASE_SERVICE_ROLE_KEY が必要です");
const linked = existsSync("supabase/.temp/project-ref") ? readFileSync("supabase/.temp/project-ref", "utf8").trim() : "";
if (!linked || !url.includes(linked)) throw new Error("接続先がトレカ専用プロジェクトと一致しません。中止します。");
const db = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });

const { data: rows, error } = await db.from("product_images").select("*");
if (error) throw error;
const sizes = [];
let totalBytes = 0;
const t0 = Date.now();
for (const r of rows) {
  const t = Date.now();
  const { data, error: e } = await db.storage.from("product-images").download(r.storage_path);
  if (e || !data) continue;
  const buf = Buffer.from(await data.arrayBuffer());
  const meta = await sharp(buf).metadata();
  sizes.push({ bytes: buf.length, w: meta.width, h: meta.height, ms: Date.now() - t, format: meta.format });
  totalBytes += buf.length;
}
const sorted = [...sizes].sort((a, b) => a.bytes - b.bytes);
const pick = (p) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))];
const kb = (n) => `${Math.round(n / 1024)}KB`;
console.log(`画像 ${rows.length} 件（取得できた ${sizes.length} 件） / サムネイル登録済み ${rows.filter((r) => r.thumb_path).length} 件`);
console.log(`合計 ${(totalBytes / 1024 / 1024).toFixed(1)}MB / 平均 ${kb(totalBytes / Math.max(1, sizes.length))} / 中央値 ${kb(pick(0.5)?.bytes ?? 0)} / 90%点 ${kb(pick(0.9)?.bytes ?? 0)} / 最大 ${kb(sorted.at(-1)?.bytes ?? 0)}`);
const hs = sizes.map((s) => s.h).sort((a, b) => a - b);
console.log(`高さ(px) 中央値 ${hs[Math.floor(hs.length / 2)]} / 最大 ${hs.at(-1)}（一覧の表示は高さ約96px）`);
const fmt = {};
for (const s of sizes) fmt[s.format] = (fmt[s.format] ?? 0) + 1;
console.log("形式", JSON.stringify(fmt), `/ 取得にかかった時間(平均) ${Math.round((Date.now() - t0) / Math.max(1, sizes.length))}ms/件（ローカル→Storage）`);
