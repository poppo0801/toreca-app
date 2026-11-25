// R1（実AI比較試験）を始められる状態かの自動判定。**無課金・読み取りだけ**。承認の値（金額・確認文）は一切設定しない・表示しない。
//   node scripts/r1-readiness.mjs            … 速い検査（ローカルDBの移行・最新mainとの競合・承認変数・gold確認の状態・費用の事前検査）
//   node scripts/r1-readiness.mjs --full     … さらに 型検査・lint・単体・DB統合・build を実行する（数分）。E2E は `E2E_SPEC="*.supabase.spec.ts" npm run test:e2e:supabase`（別途・長時間）
// 出力の readyForApproval=false の間（gold確認が未完了など）は、有料の試験を実行できない。true でも、実行には利用者の金額承認（APPROVE C <総額>JPY）が別に必要。
import { spawnSync } from "node:child_process";
import { assertLocalTarget } from "./lib/target.mjs";

try {
  process.loadEnvFile(".env.local");
} catch {
  /* 無ければ判定で止まる */
}
const full = process.argv.includes("--full");
const results = [];
const check = (name, ok, detail = "") => {
  results.push({ name, ok });
  console.log(`${ok ? "OK" : "NG"}  ${name}${detail ? ` — ${detail}` : ""}`);
};
const run = (cmd, args, opts = {}) => spawnSync(cmd, args, { encoding: "utf8", shell: opts.shell ?? true, maxBuffer: 1 << 26, ...opts });

// 1) 接続先がローカル（本番なら停止）
try {
  assertLocalTarget("r1-readiness");
  check("接続先はローカルの開発用DB", true);
} catch {
  check("接続先はローカルの開発用DB", false, "本番または未設定。中止");
  process.exit(1);
}
// 2) ローカルDBに移行 120〜122 が適用済み（本番相当の適用・復元は scripts/rehearse-migration-phase2.mjs で別に確認）
const q = run("docker", ["exec", "supabase_db_tcg-dev", "psql", "-U", "supabase_admin", "-d", "postgres", "-At", "-c", "select version from supabase_migrations.schema_migrations where version >= '20270102000120' order by 1"], { shell: false });
const vs = q.stdout.split("\n").map((x) => x.trim()).filter(Boolean);
check("ローカルDBに移行 120・121・122 が適用済み", ["20270102000120", "20270102000121", "20270103000122"].every((v) => vs.includes(v)), vs.join(","));
// 3) 最新 main との競合（作業ツリーは変更しない）
run("git", ["fetch", "origin", "main"], { shell: false });
const mt = run("git", ["merge-tree", "--write-tree", "--name-only", "HEAD", "origin/main"], { shell: false });
const conflicts = mt.status === 0 ? [] : mt.stdout.split("\n").slice(1).filter((l) => l && !/^CONFLICT|^Auto-merging|^$/.test(l) && !l.includes(" "));
check("最新 main との競合が、テスト一覧の1行（scripts/run-db-tests.mjs）だけ以下", conflicts.every((f) => f === "scripts/run-db-tests.mjs"), conflicts.join(",") || "競合なし");
// 4) ガード: 承認の値が事前に設定されていない
const preset = ["JUDGMENT_APPROVED_TOTAL_JPY", "JUDGMENT_APPROVED_PER_CASE_JPY", "JUDGMENT_REAL_CONFIRM", "JUDGMENT_REAL_EVAL"].filter((k) => process.env[k]);
check("承認に関する環境変数が事前に設定されていない（偽造・代理入力の防止）", preset.length === 0, preset.join(","));
// 5) 本体: gold確認の状態・独立性・費用の事前検査・実測指標（TypeScript側）
const t = run("node", ["scripts/compare-phase2.mjs", "readiness"], { stdio: ["ignore", "pipe", "pipe"] });
const line = t.stdout.split("\n").find((l) => l.startsWith("READINESS "));
const m = line ? JSON.parse(line.slice("READINESS ".length)) : null;
check("準備状況の判定を実行できた", !!m);
if (m) {
  for (const o of m.ok) console.log(`OK  ${o}`);
  for (const w of m.warnings) console.log(`警告  ${w}`);
  for (const b of m.blockers) console.log(`NG  ${b}`);
  console.log(`計画: 実験 ${m.plan.experiments.join("・")}／案件 ${m.plan.cases}／期待費用 約${m.plan.expectedJpy}円（${m.plan.caps}）／承認文: ${m.plan.approvalPhrase}`);
}
const metrics = t.stdout.split("\n").slice(t.stdout.split("\n").findIndex((l) => l.startsWith("METRICS")) + 1).filter((l) => l.startsWith("- "));
if (metrics.length) console.log("\n実測指標:\n" + metrics.join("\n"));
// 6) --full: 型検査・lint・単体・DB統合・build
if (full) {
  for (const [name, cmd, args] of [["型検査", "npx", ["tsc", "--noEmit"]], ["lint（エラー0）", "npm", ["run", "lint"]], ["単体", "npx", ["vitest", "run"]], ["DB統合", "node", ["scripts/run-db-tests.mjs"]], ["build", "npm", ["run", "build"]]]) {
    const r = run(cmd, args, { stdio: ["ignore", "pipe", "pipe"] });
    const lintOk = name.startsWith("lint") ? /\b0 errors\b/.test(r.stdout) : r.status === 0;
    check(name, lintOk);
  }
} else console.log("\n（--full で 型検査・lint・単体・DB統合・build も実行します）");
const bad = results.filter((r) => !r.ok).length + (m ? m.blockers.length : 1);
console.log(bad === 0 ? "\n準備完了（ブロッカーなし）。実行には、利用者の金額承認（APPROVE C <総額>JPY）が別に必要です。" : `\nブロッカー ${bad} 件。R1の有料実行はできません（人の確認・承認待ちなど）。`);
process.exit(bad === 0 ? 0 : 1);
