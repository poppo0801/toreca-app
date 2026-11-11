// 店舗所在地エージェントの評価レポートを作る（モック・架空のWeb。実APIは使わない）。結果は eval/runs/store-location-report.md
import { spawnSync } from "node:child_process";
const r = spawnSync("npx", ["vitest", "run", "src/lib/agent/store-location/store-location.test.ts", "-t", "新旧比較"], { stdio: "inherit", shell: true, env: { ...process.env, EVAL_REPORT: "1" } });
process.exit(r.status ?? 1);
