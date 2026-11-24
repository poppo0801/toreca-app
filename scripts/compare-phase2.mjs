// Phase 2: 同条件比較試験の起動入口（開発専用・ローカルDBのみ）。**有料の実AIは、承認が無ければ呼べない**。
//   node scripts/compare-phase2.mjs plan [--experiments=links,text_depth,image,hints] [--total-jpy=60 --per-case-jpy=5]
//        … 件数・API呼び出し数・費用の見積・合否基準・承認文・停止条件を表示するだけ（AI・検索・ネットワークなし・無課金）
//   node scripts/compare-phase2.mjs mock [--experiments=…]            … 台本のAI（費用0）で全経路を通す。結果は精度ではなく仕組みの確認
//   node scripts/compare-phase2.mjs export-cases [--from="<dedupe_keyのLIKE>"]   … ローカルDBの候補から入力 cases.local.json を作る（gold・AI出力を含めない）
//   node scripts/compare-phase2.mjs r1-worksheet                       … R1: 保存済みの実在の公開ページ（LivePocket）から、人が独立goldを確認する資料（r1-worksheet.local.md）と記入用の雛形を作る（AI出力を含めない）
//   node scripts/compare-phase2.mjs r1-build [--cases=12]               … R1: 人が確認したページ単位のgold（r1-gold-pages.local.json）から、複数リンクの比較用の案件とgoldを組み立てる
//   node scripts/compare-phase2.mjs gold-template                      … 人が gold を記入する下書きを作る（AI出力を含めない）
//   node scripts/compare-phase2.mjs run --approved-total-jpy=<円> --approved-per-case-jpy=<円> --confirm="APPROVE C <総額>JPY" [--experiments=…] [--images]
//        … **有料**。承認額・確認文・開発専用キー・独立gold・計画の費用がすべて通ったときだけ実行する。承認の金額・確認文に既定値は無い
// 画像の実解析（--images）は、画像の取得（公開画像・robots・SSRF対策つき）を伴う。本番DB・本番の候補には接続しない（ローカルのSupabase以外では止まる）。
import { spawnSync } from "node:child_process";

const arg = (n) => process.argv.find((a) => a.startsWith(`--${n}=`))?.slice(n.length + 3);
const flag = (n) => process.argv.includes(`--${n}`);
const cmd = process.argv[2];
const FILE = "src/lib/server/proposals/compare-real.real.test.ts";
try {
  process.loadEnvFile(".env.local");
} catch {
  /* 関門が止める */
}
const start = (extra) => {
  const r = spawnSync("npx", ["vitest", "run", "--silent=false", FILE], { stdio: "inherit", shell: true, env: { ...process.env, TOREMANE_ENV: "local", PHASE2_COMPARE: "1", ...(arg("experiments") ? { PHASE2_CMP_EXPERIMENTS: arg("experiments") } : {}), ...extra } });
  process.exit(r.status ?? 1);
};

if (cmd === "plan") start({ PHASE2_CMP_MODE: "plan", ...(arg("total-jpy") ? { PHASE2_CMP_TOTAL_JPY: arg("total-jpy") } : {}), ...(arg("per-case-jpy") ? { PHASE2_CMP_PER_CASE_JPY: arg("per-case-jpy") } : {}) });
if (cmd === "mock") start({ PHASE2_CMP_MODE: "mock" });
if (cmd === "export-cases") start({ PHASE2_CMP_MODE: "export-cases", ...(arg("from") ? { PHASE2_CMP_FROM: arg("from") } : {}) });
if (cmd === "r1-worksheet") start({ PHASE2_CMP_MODE: "r1-worksheet" });
if (cmd === "r1-build") start({ PHASE2_CMP_MODE: "r1-build", ...(arg("cases") ? { PHASE2_CMP_R1_CASES: arg("cases") } : {}) });
if (cmd === "gold-template") start({ PHASE2_CMP_MODE: "gold-template" });
if (cmd !== "run") {
  console.error('使い方: node scripts/compare-phase2.mjs plan | mock | export-cases | gold-template | run --approved-total-jpy=… --approved-per-case-jpy=… --confirm="APPROVE C <総額>JPY" [--experiments=…] [--images]');
  process.exit(2);
}
const total = Number(arg("approved-total-jpy"));
const per = Number(arg("approved-per-case-jpy"));
const confirm = arg("confirm");
if (!(total > 0) || !(per > 0)) {
  console.error("承認された総額と1件あたりの上限（円）を明示してください（既定値はありません）");
  process.exit(2);
}
if (confirm !== `APPROVE C ${total}JPY`) {
  console.error(`確認文が一致しません（期待: "APPROVE C ${total}JPY"）。承認された金額で、実行のたびに指定してください`);
  process.exit(2);
}
const MIN_PER_CASE = 1.5; // 調査＋判断の予約（preflightRun が最終的に検査する）
if (per < MIN_PER_CASE) {
  console.error(`1件あたりの上限が小さすぎます（${MIN_PER_CASE} 円以上）`);
  process.exit(2);
}
const key = process.env.AGENT_ANTHROPIC_API_KEY;
start({
  PHASE2_CMP_MODE: "run",
  JUDGMENT_REAL_EVAL: "allow",
  JUDGMENT_REAL_CONFIRM: "yes",
  JUDGMENT_APPROVED_TOTAL_JPY: String(total),
  JUDGMENT_APPROVED_PER_CASE_JPY: String(per),
  JUDGMENT_REUSE_EXISTING_KEY: "allow",
  ...(key ? { JUDGMENT_REUSE_FALLBACK_KEY: key } : {}),
  ...(flag("images") ? { PHASE2_CMP_IMAGES: "allow" } : {}),
});
