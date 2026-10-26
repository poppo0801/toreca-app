// RUN_DB_TESTS=1 を付けて RLS 結合テストのみ実行（OS差異回避のためnode経由）
import { spawnSync } from "node:child_process";
const r = spawnSync("npx", ["vitest", "run", "tests/rls.integration.test.ts"], {
  stdio: "inherit",
  shell: true,
  env: { ...process.env, RUN_DB_TESTS: "1" },
});
process.exit(r.status ?? 1);
