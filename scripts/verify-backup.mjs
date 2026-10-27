// バックアップの健全性確認: 全テーブルのファイルが揃い、JSONとして読め、件数・SHA-256がマニフェストと一致し、
// 復元に必須のテーブル（世帯・プロフィール）が空でないことを確かめる。個人データの中身は出力しない。
//   node scripts/verify-backup.mjs [--dir backups/<日時>]   （省略時は backups/ の最新）
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const args = process.argv.slice(2);
const i = args.indexOf("--dir");
const dir =
  i >= 0
    ? args[i + 1]
    : (() => {
        const dirs = existsSync("backups") ? readdirSync("backups").filter((d) => existsSync(join("backups", d, "_manifest.json"))).sort() : [];
        if (dirs.length === 0) throw new Error("backups/ にバックアップがありません");
        return join("backups", dirs[dirs.length - 1]);
      })();

const REQUIRED_NON_EMPTY = ["households", "household_members", "profiles"];
const manifest = JSON.parse(readFileSync(join(dir, "_manifest.json"), "utf8"));
const problems = [];
let rowsTotal = 0;
for (const [table, expected] of Object.entries(manifest.counts)) {
  const file = join(dir, `${table}.json`);
  if (!existsSync(file)) {
    problems.push(`${table}: ファイルがありません`);
    continue;
  }
  const body = readFileSync(file, "utf8");
  let rows;
  try {
    rows = JSON.parse(body);
  } catch {
    problems.push(`${table}: JSONとして読めません`);
    continue;
  }
  if (!Array.isArray(rows) || rows.length !== expected) problems.push(`${table}: 件数がマニフェストと一致しません（${Array.isArray(rows) ? rows.length : "?"} / ${expected}）`);
  if (manifest.sha256?.[table] && createHash("sha256").update(body).digest("hex") !== manifest.sha256[table]) problems.push(`${table}: SHA-256が一致しません（破損・改変の疑い）`);
  rowsTotal += expected;
}
for (const t of REQUIRED_NON_EMPTY) if (!(manifest.counts[t] > 0)) problems.push(`${t}: 0件です（本番データが取得できていない可能性）`);
// 商品画像の実ファイル: 全て揃い、サイズとSHA-256がマニフェストと一致し、product_images の件数と合うこと
if (manifest.images) {
  const entries = Object.entries(manifest.images.files ?? {});
  if (entries.length !== manifest.images.count) problems.push(`商品画像: 件数がマニフェスト内で食い違っています`);
  if ((manifest.counts.product_images ?? 0) !== entries.length) problems.push(`商品画像: product_images(${manifest.counts.product_images})と画像ファイル(${entries.length})の件数が一致しません`);
  for (const [path, meta] of entries) {
    const file = join(dir, "storage", "product-images", path);
    if (!existsSync(file)) {
      problems.push(`商品画像: ファイルがありません（${path}）`);
      continue;
    }
    const buf = readFileSync(file);
    if (buf.length !== meta.bytes || createHash("sha256").update(buf).digest("hex") !== meta.sha256) problems.push(`商品画像: 内容が一致しません（${path}）`);
  }
} else {
  console.warn("注意: このバックアップには商品画像の実ファイルが含まれていません（画像対応前の形式）");
}
if (!manifest.sha256) problems.push("マニフェストにSHA-256がありません（旧形式のバックアップ）");

if (problems.length > 0) {
  console.error(`バックアップの検証に失敗しました（${dir}）:`);
  for (const p of problems) console.error(`  - ${p}`);
  process.exit(1);
}
console.log(`バックアップの検証OK: ${dir}（${Object.keys(manifest.counts).length}テーブル・${rowsTotal}行・SHA-256一致${manifest.images ? `・商品画像${manifest.images.count}枚` : ""}）`);
