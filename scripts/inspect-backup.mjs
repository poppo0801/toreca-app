// 完全バックアップ（.tcgbak2）の中身を一覧表示する／指定先へ展開する。BACKUP_PASSPHRASE で復号する。
//   node scripts/inspect-backup.mjs <ファイル> [--extract <出力フォルダ>]
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import JSZip from "jszip";
import { decryptBuffer } from "./lib/backup-crypto.mjs";
try { process.loadEnvFile(".env.local"); } catch { /* 環境変数が設定済みの場合 */ }
const [file, flag, out] = process.argv.slice(2);
if (!file) { console.error("使い方: node scripts/inspect-backup.mjs <ファイル> [--extract <出力フォルダ>]"); process.exit(2); }
if (!process.env.BACKUP_PASSPHRASE) {
  // Stage 8C 以降、.env.local は開発用でパスフレーズを置かない。控えたパスフレーズを、その場の環境変数として渡す（履歴に残さない）
  console.error("BACKUP_PASSPHRASE が未設定です。PowerShell: $env:BACKUP_PASSPHRASE = Read-Host（入力）→ 実行 → 終了後に Remove-Item Env:BACKUP_PASSPHRASE");
  process.exit(2);
}
const zip = await JSZip.loadAsync(decryptBuffer(readFileSync(file), process.env.BACKUP_PASSPHRASE));
const entries = Object.values(zip.files).filter((f) => !f.dir);
if (flag === "--extract" && out) {
  for (const f of entries) {
    const p = join(out, f.name);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, await f.async("nodebuffer"));
  }
  console.log(`${entries.length}ファイルを ${out} に展開しました（平文です。確認後に必ず削除してください）`);
} else {
  const groups = {};
  for (const f of entries) {
    const g = f.name.split("/").slice(0, f.name.startsWith("storage/") ? 2 : 1).join("/");
    const n = (await f.async("nodebuffer")).length;
    groups[g] = { files: (groups[g]?.files ?? 0) + 1, bytes: (groups[g]?.bytes ?? 0) + n };
  }
  console.table(Object.fromEntries(Object.entries(groups).map(([k, v]) => [k, { files: v.files, MB: +(v.bytes / 1048576).toFixed(2) }])));
}
