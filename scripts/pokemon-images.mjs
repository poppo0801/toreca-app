// ポケモン公式絵 → 配信用WebP → Supabase Storage（非公開バケット pokemon-images）。
//   node scripts/pokemon-images.mjs manifest "<PNGフォルダ>"                 … 整理だけ（書き込みなし）。件数・欠番・曖昧を表示し、manifest を eval/real-data/ に保存（Git管理外）
//   node scripts/pokemon-images.mjs upload "<PNGフォルダ>" --yes-upload      … 変換して Storage へ保存（既定は dry-run。接続先がローカルのときだけ。本番は下記）
// **画像の利用権限（ライセンス）の確認が済むまで、本番へはアップロードしない。** 本番へ置くときは、必ず `npm run prod -- scripts/pokemon-images.mjs upload … --yes-production --yes-upload --rights-confirmed` の入口を使う。
// 画像ファイルはGitに含めない（.gitignore）。保存先: `<世帯ID>/official/0001.webp`（世帯のフォルダ単位のStorage RLSで、世帯のメンバーだけが読める）。
import { mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { buildManifest } from "./lib/pokemon-images.mjs";

const [cmd, dir] = process.argv.slice(2);
if (!["manifest", "upload"].includes(cmd) || !dir) {
  console.error('使い方: node scripts/pokemon-images.mjs manifest|upload "<PNGフォルダ>" [--yes-upload]');
  process.exit(2);
}
const NAMES = readFileSync("src/lib/zukan/pokemon151.ts", "utf8").match(/"[^"]+"/g)?.map((s) => s.slice(1, -1)).slice(0, 151) ?? [];
const { entries, stats } = buildManifest(readdirSync(dir), NAMES);
const emptyFiles = entries.filter((e) => statSync(join(dir, e.file)).size === 0).map((e) => e.no);
mkdirSync("eval/real-data", { recursive: true });
writeFileSync("eval/real-data/pokemon-images-manifest.json", JSON.stringify({ stats, entries }, null, 1));
console.log(JSON.stringify({ ...stats, unparsed: stats.unparsed.length, gapNumbers: stats.gapNumbers.length, ambiguousNumbers: entries.filter((e) => e.ambiguous).length, emptyFiles }));
if (cmd === "manifest") process.exit(0);

// ---- upload
try {
  process.loadEnvFile(".env.local");
} catch {
  /* 環境変数で渡されていればよい */
}
const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !key) {
  console.error("接続先の設定がありません");
  process.exit(2);
}
const isLocal = /^http:\/\/(127\.0\.0\.1|localhost)/.test(url);
if (!isLocal && !process.argv.includes("--rights-confirmed")) {
  // 本番へは、利用者が画像の利用について確認・了承した旨の明示（--rights-confirmed）が無ければ置かない（`npm run prod -- … --yes-production` の入口経由のみ）
  console.error("接続先が本番です。画像の利用権限を利用者が確認・了承した場合のみ --rights-confirmed を付けて実行してください");
  process.exit(3);
}
if (!process.argv.includes("--yes-upload")) {
  console.log("dry-run: --yes-upload を付けるとアップロードします");
  process.exit(0);
}
const require = createRequire(import.meta.url);
const sharp = require("sharp");
const { createClient } = require("@supabase/supabase-js");
const db = createClient(url, key, { auth: { persistSession: false } });
const { data: hh } = await db.from("households").select("id");
if (!hh || hh.length !== 1) {
  console.error("世帯を1つに特定できません");
  process.exit(4);
}
const hid = hh[0].id;
let ok = 0;
let bytes = 0;
const failed = [];
for (const e of entries) {
  try {
    // 元ファイルが空（ダウンロード失敗で0バイト）のものは、変換せず原因を明示して報告する（再取得が必要）
    if (statSync(join(dir, e.file)).size === 0) throw new Error("元ファイルが0バイト（ダウンロード失敗。再取得が必要）");
    const buf = await sharp(join(dir, e.file)).resize(160, 160, { fit: "inside", withoutEnlargement: true }).webp({ quality: 78 }).toBuffer();
    const { error } = await db.storage.from("pokemon-images").upload(`${hid}/${e.key}`, buf, { contentType: "image/webp", upsert: true });
    if (error) throw error;
    ok++;
    bytes += buf.length;
  } catch (err) {
    failed.push({ no: e.no, reason: String(err?.message ?? err).slice(0, 80) });
  }
}
console.log(JSON.stringify({ uploaded: ok, failed: failed.length, failedDetail: failed.slice(0, 10), totalMB: Math.round(bytes / 1048576) }));
