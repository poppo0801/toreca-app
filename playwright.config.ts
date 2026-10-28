import { defineConfig, devices } from "@playwright/test";

const PORT = 3100;
/** mock: ローカルモック（認証なし） / supabase: 実Supabaseへのログインフロー（scripts/run-e2e-supabase.mjs 経由） */
const mode = process.env.E2E_MODE === "supabase" ? "supabase" : "mock";
/** 本番などデプロイ済みのURLに対して実行する場合に指定（ローカルのビルド・起動は行わない） */
const remoteBaseUrl = process.env.E2E_BASE_URL;

export default defineConfig({
  testDir: "./e2e",
  testMatch: mode === "supabase" ? "supabase.spec.ts" : "lotteries.spec.ts",
  outputDir: "./e2e/.results",
  workers: mode === "supabase" ? 1 : undefined,
  // 実DB・本番URLは通信遅延があるため、画面の反映を待つ上限を長めにする（テストの内容は変えない）
  expect: { timeout: mode === "supabase" ? 10_000 : 5_000 },
  use: { baseURL: remoteBaseUrl ?? `http://localhost:${PORT}` },
  webServer: remoteBaseUrl
    ? undefined
    : {
    command: `npm run build && npx next start -p ${PORT}`,
    url: `http://localhost:${PORT}`,
    // 別モードのビルドを使い回さない
    reuseExistingServer: false,
    timeout: 240_000,
    // AI読み取りはテストではモックエンジン（固定のサンプル）を使う。実際のAI APIは呼ばない
    env: { NEXT_PUBLIC_DATA_SOURCE: mode, AI_PROVIDER: "mock" },
  },
  projects: [
    { name: "mobile", use: { ...devices["Pixel 7"] } },
    // 実DBを使うE2E(supabase)は同じ世帯を共有するため mobile のみ。表示系は mock で PC・iPhone 相当も確認する
    ...(mode === "mock"
      ? [
          { name: "desktop", use: { viewport: { width: 1280, height: 800 } } },
          // iPhone 相当の画面サイズ・タッチ（WebKit を別途入れずに済むよう Chromium でエミュレート。Safe Area の実機確認は docs/iphone-setup.md）
          { name: "iphone", use: { ...devices["iPhone 14"], defaultBrowserType: "chromium" as const } },
        ]
      : []),
  ],
});
