// 第2段階（保存済み実原文の評価）の抽出。**今回は計画の表示（dry-run）だけ。本番へ接続するコードを含まない**。
//   node scripts/extract-judgment-phase2.mjs [--limit 30] [--since <UTC ISO>]                      … dry-run（SQL・ゲート状態を表示。接続しない）
//   npm run prod -- scripts/extract-judgment-phase2.mjs --execute --backup-done --yes-production … 承認ゲートA・バックアップ確認が揃っても、接続コードは未実装のため止まる
// 実際の抽出は、ユーザーの承認ゲートA（docs/AI_REDESIGN_10E_PHASE2_APPROVAL.md）の後に、別途実装・レビューする。
import { APPROVALS_PATH, MAX_ROWS, NINE_Z_EARLIEST_ISO, assertSafeExtractSql, buildExtractSql, checkGates, planExtractRun, readApprovals } from "./lib/phase2-extract.mjs";

const args = process.argv.slice(2);
const val = (name) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};
const execute = args.includes("--execute");
const yesProduction = args.includes("--yes-production") || process.env.TOREMANE_TARGET === "production";
const limit = val("limit") ?? MAX_ROWS;
const since = val("since") ?? NINE_Z_EARLIEST_ISO;

let sql;
try {
  sql = buildExtractSql({ limit, sinceIso: since });
  assertSafeExtractSql(sql);
} catch (e) {
  console.error(`入力が不正です: ${e.message}`);
  process.exit(2);
}
const approvals = readApprovals();
const plan = planExtractRun({ execute, yesProduction, approvals, backupDone: args.includes("--backup-done") });
const gates = checkGates("extract", approvals);

console.log(`モード: ${plan.mode}（本番へは接続しません）`);
console.log(`件数の上限: ${Math.min(Number(limit), MAX_ROWS)} / 下限日時（UTC）: ${since}`);
console.log(`承認ゲートA: ${gates.ok ? "承認記録あり" : `未承認（${APPROVALS_PATH} に承認者・承認日・範囲の記載が必要）`}`);
console.log("--- 実行予定のSQL（読み取り専用。静的検査済み。実行時はさらに DB 側でも --read-only を強制する予定）---");
console.log(sql);
if (plan.mode === "execute") {
  console.error("実行できません:");
  for (const r of plan.reasons) console.error(` - ${r}`);
  process.exit(3);
}
