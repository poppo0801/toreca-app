// 評価データの保全（ローカルのみ・読み取りと eval/phase2-compare/ への保存だけ。DBは変更しない・本番に接続しない）。
//   node scripts/eval-preserve.mjs check   … 破壊的な操作の前の検査と同じ内容を実行する（異常があれば終了コード1）
//   node scripts/eval-preserve.mjs save    … 重要ファイルの記録（manifest）と予備コピー、ローカルDBの有料試験の登録案のスナップショットを作る
//   node scripts/eval-preserve.mjs verify  … 重要ファイルの欠落・破損・不意の変更だけを検査する
import { assertLocalTarget } from "./lib/target.mjs";
import { preDestructiveCheck, saveManifest, snapshotProposals, verifyCritical } from "./lib/eval-preservation.mjs";

try {
  process.loadEnvFile(".env.local");
} catch {
  /* 環境変数で設定済みの場合 */
}
const cmd = process.argv[2] ?? "check";
if (cmd !== "verify") assertLocalTarget("eval:preserve"); // ローカルDBだけを読む
if (cmd === "verify") {
  const v = verifyCritical();
  v.notes.forEach((n) => console.log(n));
  v.errors.forEach((e) => console.error(`  - ${e}`));
  process.exit(v.ok ? 0 : 1);
} else if (cmd === "save") {
  const p = await snapshotProposals();
  console.log(p.ok ? `登録案 ${p.count} 件を保全しました` : `登録案の保全: ${p.reason}（DBが未起動なら失う物は無い）`);
  const m = saveManifest();
  if (!m.ok) {
    console.error(`変更不可のファイルが記録と異なります（記録は更新しません）: ${m.conflicts.join(", ")}`);
    process.exit(1);
  }
  console.log(`重要ファイル ${m.files} 件を記録し、予備コピーを ${m.copyDir} に作りました`);
} else {
  const r = await preDestructiveCheck();
  r.notes.forEach((n) => console.log(n));
  r.errors.forEach((e) => console.error(`  - ${e}`));
  process.exit(r.ok ? 0 : 1);
}
