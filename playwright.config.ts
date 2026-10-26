import { defineConfig, devices } from "@playwright/test";

const PORT = 3100;
/** mock: ローカルモック（認証なし） / supabase: 実Supabaseへのログインフロー（scripts/run-e2e-supabase.mjs 経由） */
const mode = process.env.E2E_MODE === "supabase" ? "supabase" : "mock";

export default defineConfig({
  testDir: "./e2e",
  testMatch: mode === "supabase" ? "supabase.spec.ts" : "lotteries.spec.ts",
  outputDir: "./e2e/.results",
  workers: mode === "supabase" ? 1 : undefined,
  use: { baseURL: `http://localhost:${PORT}` },
  webServer: {
    command: `npm run build && npx next start -p ${PORT}`,
    url: `http://localhost:${PORT}`,
    // 別モードのビルドを使い回さない
    reuseExistingServer: false,
    timeout: 240_000,
    env: { NEXT_PUBLIC_DATA_SOURCE: mode },
  },
  projects: [
    { name: "mobile", use: { ...devices["Pixel 7"] } },
    ...(mode === "mock" ? [{ name: "desktop", use: { viewport: { width: 1280, height: 800 } } }] : []),
  ],
});
