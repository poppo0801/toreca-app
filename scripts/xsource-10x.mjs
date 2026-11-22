// Stage 10X: 実AI評価の実行入口（**承認が無ければ実行できない**）。
//   node scripts/xsource-10x.mjs plan                                 … 評価の計画と費用の見積を表示するだけ（API呼び出しなし）
//   node scripts/xsource-10x.mjs run --target=A|B2|C --approved-total-jpy=<円> --approved-per-case-jpy=<円> --confirm="<承認の確認文>"
// 承認の金額・確認文には**既定値が無い**。ユーザーが承認した金額を、実行のたびに明示する（確認文は `APPROVE <target> <総額>JPY` の形）。承認が無い・不一致・上限（実AI関門の候補上限）超過なら何も実行しない。
// 本番キーは使わない（開発用の既存キーをローカルでのみ再利用。JUDGMENT_REUSE_EXISTING_KEY=allow）。実行は1つの target ずつ。
import { spawnSync } from "node:child_process";

const TARGETS = {
  A: { file: "src/lib/judgment/xsource/research-10u-real.test.ts", flag: "JUDGMENT_10U_REAL", name: "A 応募URL既知（保存済みLivePocket 12件）" },
  B2: { file: "src/lib/judgment/xsource/research-10v-real.test.ts", flag: "JUDGMENT_10V_REAL", name: "B2 AI自律発見（検索つき。例ファイルが必要）" },
  C: { file: "src/lib/judgment/xsource/research-10v-real.test.ts", flag: "JUDGMENT_10V_REAL", name: "C 独立goldでの登録判断" },
};
const arg = (n) => process.argv.find((a) => a.startsWith(`--${n}=`))?.slice(n.length + 3);
const cmd = process.argv[2];

if (cmd !== "run") {
  console.log("実AI評価の計画（API呼び出しなし）。見積は docs/reports/2026-11-22-stage10x-real-world-validation.md の §5。実行するには run と、承認した金額・確認文を指定してください。");
  for (const [k, v] of Object.entries(TARGETS)) console.log(`- ${k}: ${v.name}`);
  process.exit(0);
}
const target = arg("target");
const total = Number(arg("approved-total-jpy"));
const per = Number(arg("approved-per-case-jpy"));
const confirm = arg("confirm");
if (!TARGETS[target]) {
  console.error("--target は A / B2 / C のいずれか");
  process.exit(2);
}
if (!(total > 0) || !(per > 0)) {
  console.error("承認された総額と1件あたりの上限（円）を明示してください（既定値はありません）");
  process.exit(2);
}
// 1件の上限は、調査1回＋判断1回の予約（各¥0.6＝¥1.2）より大きくないと、調査が一度も始まらない（Stage 10X 再試験で発生）。B2は検索の予約（¥3）も必要
const MIN_PER_CASE = target === "B2" ? 4.5 : 1.5;
if (per < MIN_PER_CASE) {
  console.error(`1件あたりの上限が小さすぎます（${target} は ${MIN_PER_CASE} 円以上。予約額より小さいと調査が始まりません）`);
  process.exit(2);
}
if (confirm !== `APPROVE ${target} ${total}JPY`) {
  console.error(`確認文が一致しません（期待: "APPROVE ${target} ${total}JPY"）。承認された金額で、実行のたびに指定してください`);
  process.exit(2);
}
try {
  process.loadEnvFile(".env.local");
} catch {
  /* 関門が止める */
}
const key = process.env.AGENT_ANTHROPIC_API_KEY;
const env = { ...process.env, TOREMANE_ENV: "local", [TARGETS[target].flag]: "1", JUDGMENT_10X_TARGET: target, JUDGMENT_REAL_EVAL: "allow", JUDGMENT_REAL_CONFIRM: "yes", JUDGMENT_APPROVED_TOTAL_JPY: String(total), JUDGMENT_APPROVED_PER_CASE_JPY: String(per), JUDGMENT_REUSE_EXISTING_KEY: "allow", ...(key ? { JUDGMENT_REUSE_FALLBACK_KEY: key } : {}) };
const r = spawnSync("npx", ["vitest", "run", "--silent=false", TARGETS[target].file], { stdio: "inherit", shell: true, env });
process.exit(r.status ?? 1);
