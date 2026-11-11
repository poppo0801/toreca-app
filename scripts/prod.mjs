// 本番を対象にする作業の、唯一の入口（Stage 8C）。
//   npm run prod -- <scripts/xxx.mjs> [引数...] --yes-production
// - 本番の設定は .env.production-ops（Git管理外）からだけ読む。通常の .env.local（開発用）には本番の値を置かない。
// - 開発用スクリプトは本番に向かない（各スクリプトは scripts/lib/target.mjs でローカルを要求する）。ここを通した場合だけ本番に作用する。
// - 破壊的な操作の前は npm run backup:full（docs/RESTORE.md）。接続先（プロジェクトID）を表示してから実行する。
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { assertProductionTarget, describeTarget } from "./lib/target.mjs";

const args = process.argv.slice(2);
const confirmed = args.includes("--yes-production");
const rest = args.filter((a) => a !== "--yes-production");
const script = rest[0];
if (!script || !/^scripts\/[\w./-]+\.mjs$/.test(script) || !existsSync(script)) {
  console.error("使い方: npm run prod -- scripts/<名前>.mjs [引数...] --yes-production");
  process.exit(1);
}
if (!existsSync(".env.production-ops")) {
  console.error(".env.production-ops がありません（本番用の設定。docs/DEV_ENVIRONMENT.md）。");
  process.exit(1);
}
process.loadEnvFile(".env.production-ops");
assertProductionTarget(script);
const t = describeTarget();
console.log(`本番（${t.host}）を対象にします: ${script} ${rest.slice(1).join(" ")}`);
if (!confirmed) {
  console.error("本番への作用を確認しました。実行するには末尾に --yes-production を付けてください（本番DBの変更・削除は事前に backup:full）。");
  process.exit(2);
}
// 子プロセスは本番の環境変数を引き継ぐ（スクリプト側の loadEnvFile(".env.local") は既存の環境変数を上書きしない）
const r = spawnSync("node", [script, ...rest.slice(1)], { stdio: "inherit", env: { ...process.env, TOREMANE_TARGET: "production" } });
process.exit(r.status ?? 1);
