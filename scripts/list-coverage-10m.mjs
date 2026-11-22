// Stage 10M: 一覧の全項目の発見の実データ評価（実AI・有料。ハード上限: 呼び出し40回・費用20円・1件3円）。**本番には接続しない**（入力はローカルの書き出し）。
//   node scripts/list-coverage-10m.mjs run --confirm=yes
import { spawnSync } from "node:child_process";

try {
  process.loadEnvFile(".env.local");
} catch {
  /* 無ければ関門が止める */
}
if (process.argv[2] !== "run" || !process.argv.includes("--confirm=yes")) {
  console.error("使い方: node scripts/list-coverage-10m.mjs run --confirm=yes");
  process.exit(2);
}
const key = process.env.AGENT_ANTHROPIC_API_KEY;
const env = { ...process.env, TOREMANE_ENV: "local", JUDGMENT_10M_REAL: "1", JUDGMENT_REAL_EVAL: "allow", JUDGMENT_REAL_CONFIRM: "yes", JUDGMENT_APPROVED_TOTAL_JPY: "50", JUDGMENT_APPROVED_PER_CASE_JPY: "3", JUDGMENT_REUSE_EXISTING_KEY: "allow", ...(key ? { JUDGMENT_REUSE_FALLBACK_KEY: key } : {}) };
const r = spawnSync("npx", ["vitest", "run", "--silent=false", "src/lib/judgment/list-coverage-real.test.ts"], { stdio: "inherit", shell: true, env });
process.exit(r.status ?? 1);
