// Stage 8A: 完全バックアップ（.tcgbak2）の Storage ファイル（全バケット）を、.env.local が指す Supabase プロジェクトへ戻す。
//   node scripts/restore-storage.mjs --file <tcg-full-….tcgbak2>                 確認のみ（アップロード対象の件数を表示）
//   node scripts/restore-storage.mjs --file <…> --apply                           不足しているファイルだけをアップロード
//   node scripts/restore-storage.mjs --file <…> --apply --allow-production        バックアップ元と同じ本番プロジェクトへ戻す場合のみ必要
// 既にあるファイルは上書きしない（アプリで差し替えた新しい画像を古いバックアップで壊さないため）。バケットは事前にマイグレーションで作られている必要がある。
// BACKUP_PASSPHRASE が必要。キー・パスフレーズは出力しない。
import { readFileSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";
import JSZip from "jszip";
import { decryptBuffer } from "./lib/backup-crypto.mjs";

try {
  process.loadEnvFile(".env.local");
} catch {
  /* 環境変数が設定済みの場合 */
}
const args = process.argv.slice(2);
const file = args.includes("--file") ? args[args.indexOf("--file") + 1] : undefined;
const apply = args.includes("--apply");
const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!file || !process.env.BACKUP_PASSPHRASE || !url || !key) {
  console.error("使い方: node scripts/restore-storage.mjs --file <.tcgbak2> [--apply]（BACKUP_PASSPHRASE と .env.local の Supabase 設定が必要）");
  process.exit(2);
}

const zip = await JSZip.loadAsync(decryptBuffer(readFileSync(file), process.env.BACKUP_PASSPHRASE));
const manifest = JSON.parse(await zip.file("manifest.json").async("string"));
if (url.includes(manifest.project) && !args.includes("--allow-production")) {
  console.error(`接続先がバックアップ元の本番プロジェクト（${manifest.project}）です。本番へ戻す場合のみ --allow-production を付けてください（不足分の追加のみで、上書きはしません）。`);
  process.exit(2);
}
const supabase = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
const types = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", webp: "image/webp", gif: "image/gif" };
const names = Object.keys(manifest.fileSha256).filter((p) => p.startsWith("storage/"));

// 既存ファイルの確認（フォルダごとに list）
const existing = new Set();
const dirs = new Set(names.map((p) => p.split("/").slice(1, -1).join("/")));
for (const d of dirs) {
  const bucket = d.split("/")[0];
  const prefix = d.split("/").slice(1).join("/");
  for (let offset = 0; ; offset += 1000) {
    const { data, error } = await supabase.storage.from(bucket).list(prefix, { limit: 1000, offset });
    if (error) {
      console.error(`バケット ${bucket} を確認できません（マイグレーション適用済みか確認してください）: ${error.message}`);
      process.exit(1);
    }
    for (const o of data) existing.add(`${bucket}/${prefix ? `${prefix}/` : ""}${o.name}`);
    if (data.length < 1000) break;
  }
}
const todo = names.filter((p) => !existing.has(p.slice("storage/".length)));
console.log(`バックアップ内 ${names.length}ファイル / 既にある ${names.length - todo.length} / アップロード対象 ${todo.length}`);
if (!apply) {
  console.log("確認のみです。実行するには --apply を付けてください。");
  process.exit(0);
}
let ok = 0;
let ng = 0;
for (const p of todo) {
  const [, bucket, ...rest] = p.split("/");
  const path = rest.join("/");
  const buf = await zip.file(p).async("nodebuffer");
  const { error } = await supabase.storage.from(bucket).upload(path, buf, { upsert: false, contentType: types[path.split(".").pop().toLowerCase()] ?? "application/octet-stream" });
  if (error) {
    ng++;
    console.error(`失敗: ${bucket}/${path}: ${error.message}`);
  } else ok++;
}
console.log(`アップロード: 成功 ${ok} / 失敗 ${ng}`);
process.exit(ng > 0 ? 1 : 0);
