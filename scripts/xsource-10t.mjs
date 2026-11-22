// Stage 10T: 応募ページの構造取得の実測（実AI・有料。ハード上限: 呼び出し90回・費用50円・1件3円・取得60回）。**本番には接続しない**（入力はローカルの書き出し）。
//   node scripts/xsource-10t.mjs run --confirm=yes
import { spawnSync } from "node:child_process";

try {
  process.loadEnvFile(".env.local");
} catch {
  /* 無ければ関門が止める */
}
if (process.argv[2] !== "run" || !process.argv.includes("--confirm=yes")) {
  console.error("使い方: node scripts/xsource-10t.mjs run --confirm=yes");
  process.exit(2);
}
const key = process.env.AGENT_ANTHROPIC_API_KEY;
const env = { ...process.env, TOREMANE_ENV: "local", JUDGMENT_10T_REAL: "1", JUDGMENT_REAL_EVAL: "allow", JUDGMENT_REAL_CONFIRM: "yes", JUDGMENT_APPROVED_TOTAL_JPY: "50", JUDGMENT_APPROVED_PER_CASE_JPY: "3", JUDGMENT_REUSE_EXISTING_KEY: "allow", ...(key ? { JUDGMENT_REUSE_FALLBACK_KEY: key } : {}) };
const r = spawnSync("npx", ["vitest", "run", "--silent=false", "src/lib/judgment/xsource/xsource-10t-real.test.ts"], { stdio: "inherit", shell: true, env });
process.exit(r.status ?? 1);
