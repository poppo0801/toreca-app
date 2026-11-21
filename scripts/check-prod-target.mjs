// 本番の接続先確認（Stage 10F）。**データは読まない**（`select 1` のみ・読み取り専用）。接続先を `--remote=<ref>` で明示し、CLIが表示する接続先が期待する ref であることを確認する。
//   npm run prod -- scripts/check-prod-target.mjs --yes-production
// 本番の設定は .env.production-ops から（scripts/prod.mjs 経由）。ref はリンク先（supabase/.temp/project-ref）。出力に鍵・データは含めない。
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { remoteQueryArgs, verifyQueryTarget } from "./lib/backup-target.mjs";
import { loadProductionEnv } from "./lib/prod-env.mjs";
import { PRODUCTION_REFS } from "./lib/target.mjs";

loadProductionEnv("check-prod-target.mjs");
const linked = existsSync("supabase/.temp/project-ref") ? readFileSync("supabase/.temp/project-ref", "utf8").trim() : "";
const url = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "";
if (!linked || !PRODUCTION_REFS.includes(linked) || !url.includes(linked)) {
  console.error("接続先の確認に失敗: リンク先・既知の本番ref・設定のURLが一致しません（中止）");
  process.exit(3);
}
const dir = mkdtempSync(join(tmpdir(), "tcg-tgt-"));
const file = join(dir, "q.sql");
writeFileSync(file, "select 1 as ok");
try {
  const r = spawnSync("npx", remoteQueryArgs(linked, file), { encoding: "utf8", shell: process.platform === "win32" });
  const v = verifyQueryTarget(`${r.stderr}\n${r.stdout}`, linked);
  console.log(`CLIの接続先表示: ${v.line ?? "(なし)"}`);
  if (r.status !== 0) {
    console.error(`クエリが失敗しました（終了コード ${r.status}）: ${String(r.stderr || r.stdout).replace(/eyJ[\w-]+\.[\w-]+\.[\w-]+/g, "***").split("\n").slice(-3).join(" / ").slice(0, 300)}`);
    process.exit(4);
  }
  if (!v.ok) {
    console.error(`接続先の検証に失敗: ${v.reason}`);
    process.exit(5);
  }
  console.log(`OK: 本番（${linked}）への明示接続を確認しました（読み取り専用・データは読んでいません）`);
} finally {
  rmSync(dir, { recursive: true, force: true });
}
