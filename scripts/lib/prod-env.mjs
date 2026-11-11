// 本番を読み取る運用スクリプト（バックアップ・本番検証）用の環境読み込み（Stage 8C）。
// 本番の設定は .env.production-ops にだけ置く（開発用の .env.local にはローカルDBの値のみ）。
// 読み込んだ結果が本番でなければ止める（ローカルDBを本番としてバックアップする事故を防ぐ）。
import { assertProductionTarget } from "./target.mjs";

export function loadProductionEnv(label) {
  try {
    process.loadEnvFile(".env.production-ops");
  } catch {
    /* 環境変数が既に設定されている場合（scripts/prod.mjs 経由など） */
  }
  assertProductionTarget(label);
}
