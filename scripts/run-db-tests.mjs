// RUN_DB_TESTS=1 を付けて結合テスト（実Supabase）のみ実行。
// ファイル並列を無効化する: 各スイートの終了時にテスト世帯を purge するため、並列だと他スイートのデータを消してしまう。
import { spawnSync } from "node:child_process";
const r = spawnSync("npx", ["vitest", "run", "--no-file-parallelism", "--testTimeout=120000", "--hookTimeout=120000", "tests/rls.integration.test.ts", "tests/lottery.integration.test.ts", "tests/rules-notifications.integration.test.ts", "tests/notification-ops.integration.test.ts", "tests/stage35.integration.test.ts", "tests/stage4a.integration.test.ts"], {
  stdio: "inherit",
  shell: true,
  env: { ...process.env, RUN_DB_TESTS: "1" },
});
process.exit(r.status ?? 1);
