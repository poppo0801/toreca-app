// 破壊的なローカルDB操作（test:db・db:reset・supabase E2E）の前に、評価データの保全を検証する。満たさなければ終了コード1で中止する。
// 迂回の環境変数は設けない（費用をかけた有料試験の出力を、確認なしに失わないため）。保全は `npm run eval:preserve -- save`。
import { preDestructiveCheck } from "./eval-preservation.mjs";

export async function guardEvalData(label, env = process.env) {
  const r = await preDestructiveCheck(env);
  for (const n of r.notes) console.log(`[eval-guard] ${n}`);
  if (!r.ok) {
    console.error(`[eval-guard] ${label} を中止しました（評価データの保全が確認できません）:`);
    for (const e of r.errors) console.error(`  - ${e}`);
    process.exit(1);
  }
}
