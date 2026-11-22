// 実データ（保存済み実原文）の新旧比較（Stage 10F）。**実行は費用が発生し、実原文を外部（Anthropic）へ送信するため、承認ゲートA・B・C・Eが揃うまで拒否される**。
//   node scripts/eval-judgment-phase2.mjs preflight [--approved-total-jpy=50 --approved-per-case-jpy=3]   … API非接続。ゲート・全件目視の記録・件数・費用の見積もりのみ
//   node scripts/eval-judgment-phase2.mjs run --approved-total-jpy=<円> --approved-per-case-jpy=<円> --confirm=yes   … 実AI（有料・外部送信）
// 事前: eval/real-data/approvals.json（A・B・C・E）、extract-*.json（抽出CLI）、reviewed.json（人の全件目視の記録）。環境: TOREMANE_ENV=local・JUDGMENT_REAL_EVAL=allow・キー（JUDGMENT_EVAL_API_KEY 推奨）。
// 共用キーの再利用は JUDGMENT_REUSE_EXISTING_KEY=allow（非推奨。実原文を送る評価では専用キーを分ける）。
import { spawnSync } from "node:child_process";
import { assertLocalTarget } from "./lib/target.mjs";

try {
  process.loadEnvFile(".env.local");
} catch {
  /* 無ければ関門が止める */
}
const [cmd, ...rest] = process.argv.slice(2);
const arg = (name) => rest.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);
const reuseEnv = process.env.JUDGMENT_REUSE_EXISTING_KEY === "allow" && process.env.AGENT_ANTHROPIC_API_KEY ? { JUDGMENT_REUSE_FALLBACK_KEY: process.env.AGENT_ANTHROPIC_API_KEY } : {};
const vitest = (name, env) => spawnSync("npx", ["vitest", "run", "src/lib/judgment/phase2-real-eval.test.ts", "-t", name, "--silent=false"], { stdio: "inherit", shell: true, env: { ...process.env, ...reuseEnv, ...env } });

if (cmd === "preflight") {
  const r = vitest("実行前の確認", { JUDGMENT_PHASE2_PREFLIGHT: "1", JUDGMENT_APPROVED_TOTAL_JPY: arg("approved-total-jpy") ?? "", JUDGMENT_APPROVED_PER_CASE_JPY: arg("approved-per-case-jpy") ?? "" });
  process.exit(r.status ?? 1);
} else if (cmd === "run") {
  if (process.env.NEXT_PUBLIC_SUPABASE_URL) assertLocalTarget("eval:judgment-phase2"); // 評価は開発環境でのみ（DBには接続しないが、本番の設定が混ざっていれば停止）
  const total = Number(arg("approved-total-jpy"));
  const per = Number(arg("approved-per-case-jpy"));
  if (!(total > 0) || !(per > 0) || arg("confirm") !== "yes") {
    console.error("承認された総額と1件の上限（円）、および --confirm=yes が必要です（承認ゲートA・B・C・Eの承認後にのみ実行してください）");
    process.exit(2);
  }
  const r = vitest("実AIの実行", { JUDGMENT_PHASE2_RUN: "1", JUDGMENT_REAL_CONFIRM: "yes", JUDGMENT_APPROVED_TOTAL_JPY: String(total), JUDGMENT_APPROVED_PER_CASE_JPY: String(per) });
  process.exit(r.status ?? 1);
} else {
  console.error("使い方: node scripts/eval-judgment-phase2.mjs preflight | run --approved-total-jpy=<円> --approved-per-case-jpy=<円> --confirm=yes");
  process.exit(2);
}
