// Phase 2: 実AIの通し試験（P: 収集候補 → 調査・判断 → 登録案）の起動入口（開発専用・ローカルDBのみ）。**承認が無ければ実AIを呼べない**。
//   node scripts/proposal-real.mjs plan                                … 計画と費用の見積を表示するだけ（AI・検索なし・無課金）
//   node scripts/proposal-real.mjs prepare                             … 保存済みの実在の公開投稿・公開ページから候補をローカルDBへ入れる（無課金）
//   node scripts/proposal-real.mjs run --approved-total-jpy=<円> --approved-per-case-jpy=<円> --confirm="APPROVE P <総額>JPY" [--search] [--live-fetch] [--select=gold|lp|gold+lp|r10s|all] [--limit=<件>]
// 承認の金額・確認文には**既定値が無い**（Stage 10X と同じ）。1件の上限は、調査＋判断の予約（検索つきは検索の予約も）より小さいと拒否する。本番キーは使わない（開発用の既存キーをローカルでのみ再利用）。
// 一般の画面・server action・cron・収集の接続口から、この入口は呼ばれない。実行しても、本番DB・本番の候補には接続しない（ローカルのSupabaseでなければテスト側が止める）。
import { spawnSync } from "node:child_process";

const arg = (n) => process.argv.find((a) => a.startsWith(`--${n}=`))?.slice(n.length + 3);
const flag = (n) => process.argv.includes(`--${n}`);
const cmd = process.argv[2];
const FILE = "src/lib/server/proposals/proposal-real.real.test.ts";
try {
  process.loadEnvFile(".env.local");
} catch {
  /* 関門が止める */
}
const start = (extra) => {
  const r = spawnSync("npx", ["vitest", "run", "--silent=false", FILE], { stdio: "inherit", shell: true, env: { ...process.env, TOREMANE_ENV: "local", JUDGMENT_PROPOSAL_REAL: "1", ...extra } });
  process.exit(r.status ?? 1);
};

if (cmd === "plan") start({ PROPOSAL_REAL_MODE: "plan", ...(arg("select") ? { PROPOSAL_REAL_SELECT: arg("select") } : {}) });
if (cmd === "prepare") start({ PROPOSAL_REAL_MODE: "prepare" });
if (cmd !== "run") {
  console.error("使い方: node scripts/proposal-real.mjs plan | prepare | run --approved-total-jpy=… --approved-per-case-jpy=… --confirm=\"APPROVE P <総額>JPY\" [--search] [--live-fetch] [--limit=N]");
  process.exit(2);
}
const total = Number(arg("approved-total-jpy"));
const per = Number(arg("approved-per-case-jpy"));
const confirm = arg("confirm");
if (!(total > 0) || !(per > 0)) {
  console.error("承認された総額と1件あたりの上限（円）を明示してください（既定値はありません）");
  process.exit(2);
}
if (confirm !== `APPROVE P ${total}JPY`) {
  console.error(`確認文が一致しません（期待: "APPROVE P ${total}JPY"）。承認された金額で、実行のたびに指定してください`);
  process.exit(2);
}
const search = flag("search");
const MIN_PER_CASE = search ? 4.5 : 1.5; // 調査＋判断の予約（¥1.2）／検索つきは検索の予約（¥2.5）も
if (per < MIN_PER_CASE) {
  console.error(`1件あたりの上限が小さすぎます（${MIN_PER_CASE} 円以上。予約額より小さいと調査が始まりません）`);
  process.exit(2);
}
const key = process.env.AGENT_ANTHROPIC_API_KEY;
start({
  PROPOSAL_REAL_MODE: "run",
  JUDGMENT_REAL_EVAL: "allow",
  JUDGMENT_REAL_CONFIRM: "yes",
  JUDGMENT_APPROVED_TOTAL_JPY: String(total),
  JUDGMENT_APPROVED_PER_CASE_JPY: String(per),
  JUDGMENT_REUSE_EXISTING_KEY: "allow",
  ...(key ? { JUDGMENT_REUSE_FALLBACK_KEY: key } : {}),
  ...(search ? { PROPOSAL_REAL_SEARCH: "1" } : {}),
  ...(flag("live-fetch") ? { PROPOSAL_REAL_LIVE: "1", JUDGMENT_LIVE_FETCH: "allow" } : {}),
  ...(arg("limit") ? { PROPOSAL_REAL_LIMIT: arg("limit") } : {}),
  ...(arg("select") ? { PROPOSAL_REAL_SELECT: arg("select") } : {}),
});
