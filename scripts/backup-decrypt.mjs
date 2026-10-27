// 暗号化バックアップ(.tcgbak)を、restore.mjs / verify-backup.mjs / restore-drill.mjs が読める形式のフォルダへ復号する。
//   node scripts/backup-decrypt.mjs <ファイル.tcgbak> --out <出力フォルダ>
// パスフレーズは環境変数 BACKUP_PASSPHRASE（.env.local 可）。復号したフォルダは個人データを含むため、使い終わったら削除する。
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { basename, join, resolve, sep } from "node:path";
import { decryptFiles } from "./lib/backup-crypto.mjs";

try {
  process.loadEnvFile(".env.local");
} catch {
  /* noop */
}
const a = process.argv.slice(2);
const file = a.find((x) => !x.startsWith("--") && x !== a[a.indexOf("--out") + 1]);
const out = a.includes("--out") ? a[a.indexOf("--out") + 1] : undefined;
if (!file || !out) {
  console.error("使い方: node scripts/backup-decrypt.mjs <ファイル.tcgbak> --out <出力フォルダ>");
  process.exit(2);
}
if (!process.env.BACKUP_PASSPHRASE) {
  console.error("BACKUP_PASSPHRASE が必要です（バックアップ作成時のパスフレーズ）。");
  process.exit(2);
}
const dest = resolve(out);
if (existsSync(dest) && readdirSync(dest).length > 0) {
  console.error("出力フォルダが空ではありません。中止します。");
  process.exit(2);
}
mkdirSync(dest, { recursive: true });
const files = decryptFiles(readFileSync(file), process.env.BACKUP_PASSPHRASE);
for (const [name, text] of Object.entries(files)) {
  const target = resolve(dest, basename(name)); // パス区切りを含む名前は無視（意図しない場所へ書かない）
  if (!target.startsWith(dest + sep)) continue;
  writeFileSync(target, text);
}
console.log(`復号しました: ${dest}（${Object.keys(files).length}ファイル）\n次: node scripts/verify-backup.mjs --dir "${dest}" → 復元は docs/backup-and-ops.md`);
void join;
