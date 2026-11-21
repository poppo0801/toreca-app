// 統合AI判断の実AI評価（Stage 10E 追加修正）。**実行は費用が発生するため、承認された条件の範囲だけ**。
//   node scripts/eval-judgment-real.mjs preflight [--ids=J01,J02]     実行前の確認（API・ネットワークに接続しない。キーは表示しない）
//   node scripts/eval-judgment-real.mjs run --approved-total-jpy=<円> --approved-per-case-jpy=<円> --confirm=yes [--ids=...]
// 事前に .env.local へ開発専用の設定が必要: TOREMANE_ENV=local・JUDGMENT_REAL_EVAL=allow、および APIキー（次のどちらか）:
//   (a) JUDGMENT_EVAL_API_KEY（評価専用。常にこちらが優先）
//   (b) 既存キーの再利用: JUDGMENT_REUSE_EXISTING_KEY=allow（ANTHROPIC_API_KEY、無ければ開発用に設定済みのキーを使う。値は表示しない・コピーしない）
// 第1段階（架空・匿名化済みの事例のみ・Web検索なし）。保存された実原文・本番DBの読み取りは別途承認（このスクリプトは行わない）。
import { spawnSync } from "node:child_process";
import { assertLocalTarget } from "./lib/target.mjs";

try {
  process.loadEnvFile(".env.local");
} catch {
  /* 無ければ関門が止める */
}
const [cmd, ...rest] = process.argv.slice(2);
const arg = (name) => rest.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);
// 既存キーの再利用（明示許可のときだけ）: 開発用に設定済みのキーを、評価の関門へ別名で渡す（値は子プロセスの環境にだけ置く。表示・保存しない）
const reuseEnv = process.env.JUDGMENT_REUSE_EXISTING_KEY === "allow" && process.env.AGENT_ANTHROPIC_API_KEY ? { JUDGMENT_REUSE_FALLBACK_KEY: process.env.AGENT_ANTHROPIC_API_KEY } : {};
const ids = arg("ids") ? { JUDGMENT_REAL_IDS: arg("ids") } : {};

if (cmd === "preflight") {
  const r = spawnSync("npx", ["vitest", "run", "src/lib/judgment/real-eval.test.ts", "-t", "実行前の確認"], { stdio: "inherit", shell: true, env: { ...process.env, ...reuseEnv, ...ids, JUDGMENT_REAL_PREFLIGHT: "1", JUDGMENT_APPROVED_TOTAL_JPY: arg("approved-total-jpy") ?? "", JUDGMENT_APPROVED_PER_CASE_JPY: arg("approved-per-case-jpy") ?? "" } });
  process.exit(r.status ?? 1);
} else if (cmd === "run") {
  if (process.env.NEXT_PUBLIC_SUPABASE_URL) assertLocalTarget("eval:judgment-real");
  const total = Number(arg("approved-total-jpy"));
  const per = Number(arg("approved-per-case-jpy"));
  if (!(total > 0) || !(per > 0) || arg("confirm") !== "yes") {
    console.error("承認された総額と1件の上限（円）、および --confirm=yes が必要です（費用と条件を確認して、承認を得てから実行してください）");
    process.exit(2);
  }
  const r = spawnSync("npx", ["vitest", "run", "src/lib/judgment/real-eval.test.ts", "-t", "実API評価"], {
    stdio: "inherit",
    shell: true,
    env: { ...process.env, ...reuseEnv, ...ids, JUDGMENT_REAL_RUN: "1", JUDGMENT_REAL_CONFIRM: "yes", JUDGMENT_APPROVED_TOTAL_JPY: String(total), JUDGMENT_APPROVED_PER_CASE_JPY: String(per) },
  });
  process.exit(r.status ?? 1);
} else {
  console.error("使い方: node scripts/eval-judgment-real.mjs preflight | run --approved-total-jpy=<円> --approved-per-case-jpy=<円> --confirm=yes");
  process.exit(2);
}
