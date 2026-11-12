// 開発サーバーの起動（Stage 8C）。起動前に接続先を検証し、本番の Supabase に繋がる状態なら起動しない。
import { spawnSync } from "node:child_process";
import { assertLocalTarget, describeTarget } from "./lib/target.mjs";

try {
  process.loadEnvFile(".env.local");
} catch {
  /* 無ければ mock モード（認証なし・架空データ）で動く */
}
if (process.env.NEXT_PUBLIC_DATA_SOURCE === "supabase" || process.env.NEXT_PUBLIC_SUPABASE_URL) {
  assertLocalTarget("npm run dev");
  const t = describeTarget();
  console.log(`[dev] 接続先: ${t.kind}（${t.host}）`);
} else {
  console.log("[dev] mock モード（DBなし）");
}
const r = spawnSync("npx", ["next", "dev", ...process.argv.slice(2)], { stdio: "inherit", shell: true });
process.exit(r.status ?? 0);
