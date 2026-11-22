// ポケモン画像の非公開バケット（pokemon-images）を作る。SQL・マイグレーションは使わず、Supabase の Storage API（service role）で作成する。
//   node scripts/setup-pokemon-images-bucket.mjs                                                   … ローカルDB: 現状の確認（dry-run）
//   node scripts/setup-pokemon-images-bucket.mjs --execute                                         … ローカルDB: 作成
//   npm run prod -- scripts/setup-pokemon-images-bucket.mjs --yes-production [--execute]           … 本番（既定は dry-run。作成は --execute）
// 作るのは**非公開**バケット1つだけ（利用者向けのStorageポリシーは作らない＝匿名・ログイン済みの利用者はStorageへ直接アクセスできない。配信は /api/pokemon-image がサーバーで世帯を確認して行う）。
// 既存のバケット（product-images 等）・ポリシー・データには触れない。既に pokemon-images があれば公開設定でないことだけを確認して終了（冪等）。
import { createRequire } from "node:module";

try {
  process.loadEnvFile(".env.local");
} catch {
  /* 環境変数（scripts/prod.mjs 経由）で渡される */
}
const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !key) {
  console.error("接続先の設定がありません");
  process.exit(2);
}
const isLocal = /^http:\/\/(127\.0\.0\.1|localhost)/.test(url);
const require = createRequire(import.meta.url);
const { createClient } = require("@supabase/supabase-js");
const db = createClient(url, key, { auth: { persistSession: false } });
const ID = "pokemon-images";
const { data: buckets, error } = await db.storage.listBuckets();
if (error) {
  console.error(`バケット一覧を取得できません: ${error.message}`);
  process.exit(4);
}
const cur = buckets.find((b) => b.id === ID);
console.log(JSON.stringify({ target: isLocal ? "local" : "production", exists: !!cur, public: cur?.public ?? null, otherBuckets: buckets.filter((b) => b.id !== ID).map((b) => b.id) }));
if (cur?.public) {
  console.error("既存の pokemon-images が公開設定です。中止します（手動で確認してください）");
  process.exit(3);
}
if (cur) {
  console.log("導入済みです（非公開）。何も変更しません");
  process.exit(0);
}
if (!process.argv.includes("--execute")) {
  console.log("dry-run: --execute を付けると、非公開バケット pokemon-images（webpのみ・1ファイル512KBまで）を作成します");
  process.exit(0);
}
const { error: ce } = await db.storage.createBucket(ID, { public: false, fileSizeLimit: 524288, allowedMimeTypes: ["image/webp"] });
if (ce) {
  console.error(`作成に失敗: ${ce.message}`);
  process.exit(4);
}
const { data: after } = await db.storage.listBuckets();
console.log(JSON.stringify({ created: after.some((b) => b.id === ID), public: after.find((b) => b.id === ID)?.public ?? null }));
// ロールバック: バケット内のオブジェクトを削除してから db.storage.deleteBucket("pokemon-images")
