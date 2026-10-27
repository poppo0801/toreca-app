// 商品マスターの一括取り込み（Excel + 画像）。既定はドライラン（DBに書き込まない）。何度実行しても重複しない（冪等）。
//   npm run import:products                       # ドライラン: 件数・差分・画像不足を報告
//   npm run import:products -- --apply            # 実際に登録（新規・未設定項目の補完・不足画像の追加のみ）
//   オプション:
//     --dir data/import/products     取り込み元（product_master*.xlsx / *.xlsx と画像）
//     --overwrite-fields M6,M7       既存値と違うExcelの値で更新するコード（手動編集済み項目は対象外）
//     --overwrite-images             取り込み由来の画像のうち内容が違うものを差し替える（アプリで手動アップロードした画像は常に保護）
//     --household <id>               世帯が複数ある場合に指定
// 秘密鍵は .env.local のみ（ブラウザ・ログに出さない）。Excel・画像・レポートは data/import/（.gitignore済み）に置き、コミットしない。
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createClient } from "@supabase/supabase-js";
import { KIND_LABEL, normName, parseProducts, planImport, scanImages } from "./lib/product-import.mjs";
import { readXlsx } from "./lib/xlsx-read.mjs";

try {
  process.loadEnvFile(".env.local");
} catch {
  /* noop */
}
const args = process.argv.slice(2);
const opt = (n) => (args.includes(`--${n}`) ? args[args.indexOf(`--${n}`) + 1] : undefined);
const apply = args.includes("--apply");
const dir = opt("dir") ?? "data/import/products";
const overwriteFields = (opt("overwrite-fields") ?? "").split(",").map((s) => s.trim()).filter(Boolean);
const overwriteImages = args.includes("--overwrite-images");

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !key) throw new Error(".env.local に NEXT_PUBLIC_SUPABASE_URL と SUPABASE_SERVICE_ROLE_KEY が必要です");
const linked = existsSync("supabase/.temp/project-ref") ? readFileSync("supabase/.temp/project-ref", "utf8").trim() : "";
if (!linked || !url.includes(linked)) throw new Error("接続先がトレカ専用プロジェクトと一致しません。中止します。");
const db = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });

const xlsx = readdirSync(dir).filter((f) => /\.xlsx$/i.test(f) && !f.startsWith("~$")).sort();
if (xlsx.length === 0) throw new Error(`${dir} に .xlsx がありません`);
if (xlsx.length > 1) console.log(`注意: 複数のExcelがあります。最後のもの（${xlsx[xlsx.length - 1]}）を使います: ${xlsx.join(", ")}`);
const book = readXlsx(join(dir, xlsx[xlsx.length - 1]));
const sheet = book.find((s) => s.name.includes("商品マスター")) ?? book[0];
const parsed = parseProducts(sheet.rows);
const scanned = scanImages(dir);

const must = (r, what) => {
  if (r.error) throw new Error(`${what}: ${r.error.message}`);
  return r.data;
};
const { data: hh } = await db.from("households").select("id");
const hid = opt("household") ?? (hh?.length === 1 ? hh[0].id : null);
if (!hid) throw new Error("世帯を特定できません（--household を指定してください）");
const existing = {
  products: must(await db.from("products").select("*").eq("household_id", hid), "products"),
  aliases: must(await db.from("product_aliases").select("product_id,normalized_alias").eq("household_id", hid), "aliases"),
  images: must(await db.from("product_images").select("product_id,kind,sha256,source").eq("household_id", hid), "images"),
};
const plan = planImport(parsed.products, scanned.images, existing, { overwriteFields, overwriteImages });

// ---------------------------------------------------------------- 報告
const errors = [...parsed.issues, ...scanned.issues].filter((i) => i.level === "error");
const lines = [];
const p = (s = "") => lines.push(s);
p(`商品マスター取り込み ${apply ? "【実行】" : "【ドライラン】"} ${new Date().toISOString()}`);
p(`Excel: ${xlsx[xlsx.length - 1]}（シート「${sheet.name}」） / 商品 ${parsed.products.length}件 / 画像ファイル ${scanned.images.length}件`);
p(`新規登録 ${plan.create.length} / 補完更新 ${plan.update.length} / 変更なし ${plan.unchanged.length} / 要確認 ${plan.review.length} / 既存値との差異 ${plan.conflicts.length}`);
p(`略称の追加 ${plan.aliasAdd.length}（競合 ${plan.aliasConflict.length}）`);
p(`画像: 追加 ${plan.imageAdd.length} / 差し替え ${plan.imageReplace.length} / 変更なし ${plan.imageUnchanged.length} / 保護(上書きしない) ${plan.imageProtected.length} / 対応商品なし ${plan.imageOrphan.length}`);
for (const i of [...parsed.issues, ...scanned.issues]) p(`  [${i.level}] ${i.row ? `${i.row}行目` : i.file}: ${i.message}`);
if (plan.create.length) p(`新規: ${plan.create.map((x) => x.code).join(", ")}`);
for (const r of plan.review) p(`  [要確認] ${r.code} ${r.name}: ${r.reason}`);
for (const c of plan.conflicts) p(`  [差異] ${c.code}: ${c.diffs.map((d) => `${d.field} 現在=${d.current} / Excel=${d.excel}`).join("; ")}${c.applied ? "（更新対象）" : "（更新しません）"}`);
for (const a of plan.aliasConflict) p(`  [略称競合] ${a.code}「${a.alias}」: ${a.reason}`);
for (const o of plan.imageOrphan) p(`  [画像] ${o.file}: ${o.reason}`);
for (const o of plan.imageProtected) p(`  [画像保護] ${o.file}: ${o.reason}`);
if (plan.imageMissing.length) {
  p(`画像不足（エラーではありません。後から追加して再取り込みできます）: ${plan.imageMissing.length}商品`);
  for (const m of plan.imageMissing) p(`  ${m.code} ${m.name}: ${m.missing.map((k) => KIND_LABEL[k]).join("・")}`);
}
console.log(lines.join("\n"));
writeFileSync(join(dir, "_import-report.txt"), lines.join("\n") + "\n");

if (errors.length) {
  console.error(`\nエラー ${errors.length}件があります。該当行/ファイルは取り込まれません（他は続行できます）。`);
}
if (!apply) {
  console.log("\nドライランのため、DBには何も書き込んでいません。実行するには --apply を付けてください。");
  process.exit(0);
}

// ---------------------------------------------------------------- 実行（削除はしない。新規・補完・不足画像の追加のみ）
const result = { created: 0, updated: 0, aliases: 0, imagesAdded: 0, imagesReplaced: 0, failed: [] };
const idByCode = new Map(existing.products.filter((x) => x.product_code).map((x) => [x.product_code.toLowerCase(), x.id]));
const toRow = (x) => ({
  official_name: x.name,
  product_code: x.code,
  product_code_kind: x.codeKind,
  category: x.category ?? "",
  release_date: x.releaseDate,
  list_price_pack: x.listPricePack,
  list_price_box: x.listPriceBox,
  packs_per_box: x.packsPerBox,
  list_price_unit: x.listPriceUnit,
  memo: x.memo,
  source_url: x.sourceUrl,
  sales_form: x.salesForm,
  is_provisional: false,
});

for (const x of plan.create) {
  const { data, error } = await db.from("products").insert({ ...toRow(x), household_id: hid }).select("id").single();
  if (error) result.failed.push(`${x.code}: ${error.message}`);
  else {
    idByCode.set(x.code.toLowerCase(), data.id);
    result.created++;
  }
}
for (const u of plan.update) {
  const { error } = await db.from("products").update(u.fill).eq("id", u.productId);
  if (error) result.failed.push(`${u.code}: ${error.message}`);
  else result.updated++;
}
for (const a of plan.aliasAdd) {
  const productId = a.productId ?? idByCode.get(a.code.toLowerCase());
  if (!productId) continue;
  const { error } = await db.from("product_aliases").insert({ household_id: hid, product_id: productId, alias: a.alias, normalized_alias: normName(a.alias) });
  if (error) result.failed.push(`略称 ${a.code}/${a.alias}: ${error.message}`);
  else result.aliases++;
}
const upload = async (img, replace) => {
  const productId = idByCode.get(img.code);
  if (!productId) return;
  const path = `${hid}/${productId}/${img.kind}.png`;
  const up = await db.storage.from("product-images").upload(path, readFileSync(img.path), { contentType: "image/png", upsert: true });
  if (up.error) return result.failed.push(`画像 ${img.file}: ${up.error.message}`);
  const row = { household_id: hid, product_id: productId, kind: img.kind, storage_path: path, sha256: img.sha256, width: img.width, height: img.height, source: "import" };
  const { error } = replace
    ? await db.from("product_images").update({ storage_path: path, sha256: img.sha256, width: img.width, height: img.height }).eq("product_id", productId).eq("kind", img.kind)
    : await db.from("product_images").insert(row);
  if (error) result.failed.push(`画像記録 ${img.file}: ${error.message}`);
  else if (replace) result.imagesReplaced++;
  else result.imagesAdded++;
};
for (const img of plan.imageAdd) await upload(img, false);
for (const img of plan.imageReplace) await upload(img, true);

console.log(`\n実行結果: 新規 ${result.created} / 補完更新 ${result.updated} / 略称 ${result.aliases} / 画像追加 ${result.imagesAdded} / 画像差し替え ${result.imagesReplaced}`);
if (result.failed.length) {
  console.error(`失敗 ${result.failed.length}件:\n  ${result.failed.join("\n  ")}`);
  process.exit(1);
}
