// E2E・ビルドに渡す環境変数の分離（Stage 8D-5）。
// 実API評価用の開発専用設定（AGENT_*）が .env.local にあっても、E2E のサーバーには渡さない（空文字で明示的に上書きする）。
// Next.js は .env.local を自動で読むが、すでに定義された環境変数（空文字を含む）は上書きしないため、
// キーの有無・実APIの許可の有無で、画面（「実APIは無効です」など）やテストの結果が変わらない。
export const ISOLATED_AGENT_ENV = {
  AGENT_REAL_API: "",
  AGENT_ANTHROPIC_API_KEY: "",
  AGENT_MAX_COST_JPY_PER_RUN: "",
  AGENT_MAX_RUNS_PER_DAY: "",
  AGENT_MODEL: "",
  AGENT_MAX_SEARCHES: "",
  AGENT_MAX_FETCHES: "",
  AGENT_MAX_STEPS: "",
};
