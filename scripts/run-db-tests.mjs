// RUN_DB_TESTS=1 を付けて結合テスト（実Supabase）のみ実行。
// ファイル並列を無効化する: 各スイートの終了時にテスト世帯を purge するため、並列だと他スイートのデータを消してしまう。
import { spawnSync } from "node:child_process";
import { assertLocalTarget } from "./lib/target.mjs";

try {
  process.loadEnvFile(".env.local");
} catch {
  /* 環境変数が既に設定されている場合 */
}
assertLocalTarget("test:db"); // 開発用ローカルDBのみ（Stage 8C。npm run prod 経由でも本番では実行しない）
const r = spawnSync("npx", ["vitest", "run", "--no-file-parallelism", "--testTimeout=120000", "--hookTimeout=120000", "tests/rls.integration.test.ts", "tests/lottery.integration.test.ts", "tests/rules-notifications.integration.test.ts", "tests/notification-ops.integration.test.ts", "tests/stage35.integration.test.ts", "tests/stage4a.integration.test.ts", "tests/stage4b.integration.test.ts", "tests/stage45.integration.test.ts", "tests/stage5a.integration.test.ts", "tests/stage5b.integration.test.ts", "tests/stage4b5.integration.test.ts", "tests/stage5c.integration.test.ts", "tests/stage5de.integration.test.ts", "tests/stage5f.integration.test.ts", "tests/stage5g.integration.test.ts", "tests/stage5i.integration.test.ts", "tests/stage5j.integration.test.ts", "tests/stage5l.integration.test.ts", "tests/stage5m.integration.test.ts", "tests/stage4c.integration.test.ts", "tests/stage4c-worker.integration.test.ts", "tests/stage4c-stats.integration.test.ts", "tests/stage5n.integration.test.ts", "tests/stage5p.integration.test.ts", "tests/stage5p-geo.integration.test.ts", "tests/stage5r.integration.test.ts", "tests/stage5s-queue.integration.test.ts", "tests/stage5s-memo.integration.test.ts", "tests/stage5s-notice.integration.test.ts", "tests/stage5t.integration.test.ts", "tests/stage6a.integration.test.ts", "tests/stage6b.integration.test.ts", "tests/stage6c.integration.test.ts", "tests/stage6d.integration.test.ts", "tests/stage6g.integration.test.ts", "tests/stage6h.integration.test.ts", "tests/stage6i.integration.test.ts", "tests/stage6j.integration.test.ts", "tests/stage6k.integration.test.ts", "tests/stage6l.integration.test.ts", "tests/stage6l-units.integration.test.ts", "tests/stage6m-box.integration.test.ts", "tests/stage6n.integration.test.ts", "tests/stage6p.integration.test.ts", "tests/stage6q.integration.test.ts", "tests/stage6r.integration.test.ts", "tests/stage7a.integration.test.ts", "tests/stage7e.integration.test.ts", "tests/stage7f.integration.test.ts", "tests/stage7gh.integration.test.ts", "tests/stage7k.integration.test.ts", "tests/stage7l.integration.test.ts", "tests/stage7m.integration.test.ts", "tests/stage7n.integration.test.ts", "tests/stage4c-reevaluate.integration.test.ts", "tests/stage7p.integration.test.ts", "tests/stage7q.integration.test.ts", "tests/stage7q-collect.integration.test.ts", "tests/stage7r.integration.test.ts", "tests/stage7s.integration.test.ts", "tests/dev-seed.integration.test.ts", "tests/stage8d2.integration.test.ts", "tests/stage8d4.integration.test.ts", "tests/stage8d5.integration.test.ts", "tests/stage8u.integration.test.ts", "tests/stage8f.integration.test.ts"], {
  stdio: "inherit",
  shell: true,
  env: { ...process.env, RUN_DB_TESTS: "1" },
});
process.exit(r.status ?? 1);
