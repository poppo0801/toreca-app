// 本番シャドー（Phase 3）の稼働設定。既定は dry-run（読み取りだけ）。書き込みは --execute。入口は prod.mjs。
//   npm run prod -- scripts/shadow-enable.mjs --yes-production                         … 現状の確認（dry-run）
//   npm run prod -- scripts/shadow-enable.mjs --household-out=<ファイル> --yes-production … 世帯IDを（表示せず）ファイルへ書く（環境変数の設定に使う）
//   npm run prod -- scripts/shadow-enable.mjs --execute --yes-production               … shadow_settings の1行を、承認された初回稼働の条件で書く
//   npm run prod -- scripts/shadow-enable.mjs --disable --execute --yes-production     … 停止（enabled=false・enqueue_enabled=false。設定は残す）
// 承認された初回稼働の条件（既定値）: 日次¥15・通算¥45（月次も¥45）・1件¥3・1回3件・試行期間3日（valid_until）。世帯は1つだけ（複数なら中止）。
// 書き込み先は shadow_settings の1行だけ。世帯IDは画面・ログに出さない（短いハッシュだけ）。キー・秘密は扱わない。
import { createHash } from "node:crypto";
import { writeFileSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";
import { assertProductionTarget } from "./lib/target.mjs";

assertProductionTarget("shadow-enable.mjs");
const args = process.argv.slice(2);
const flag = (n) => args.includes(`--${n}`);
const opt = (n) => args.find((a) => a.startsWith(`--${n}=`))?.slice(n.length + 3);
const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !key) {
  console.error("本番の接続設定がありません（npm run prod 経由で実行してください）");
  process.exit(1);
}
const db = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
const short = (id) => createHash("sha256").update(String(id)).digest("hex").slice(0, 8);

const { data: hh, error: he } = await db.from("households").select("id");
if (he) {
  console.error("世帯の読み取りに失敗しました");
  process.exit(1);
}
console.log(`世帯: ${hh.length}件`);
if (hh.length !== 1) {
  console.error("世帯がちょうど1つではないため中止します（対象は既存の家族世帯のみ）。");
  process.exit(1);
}
const hid = hh[0].id;
console.log(`対象の世帯（短縮）: ${short(hid)}`);
const out = opt("household-out");
if (out) {
  writeFileSync(out, hid);
  console.log("世帯IDをファイルへ書きました（表示しません）");
}
const cur = await db.from("shadow_settings").select("enabled,enqueue_enabled,daily_budget_jpy,monthly_budget_jpy,per_case_cap_jpy,max_jobs_per_run,valid_until,total_budget_jpy,total_since").eq("household_id", hid).maybeSingle();
if (cur.error) {
  console.error("shadow_settings の読み取りに失敗（移行123が未適用の可能性）");
  process.exit(1);
}
console.log("現在の設定:", cur.data ?? "なし");

if (!flag("execute")) {
  console.log("dry-run: 何も書いていません。書き込みは --execute。");
  process.exit(0);
}
if (flag("disable")) {
  const r = await db.from("shadow_settings").update({ enabled: false, enqueue_enabled: false }).eq("household_id", hid);
  console.log(r.error ? "停止に失敗しました" : "停止しました（enabled=false・enqueue_enabled=false）");
  process.exit(r.error ? 1 : 0);
}
const now = new Date();
const row = {
  household_id: hid,
  enabled: true,
  enqueue_enabled: true,
  daily_budget_jpy: 15,
  monthly_budget_jpy: 45,
  per_case_cap_jpy: 3,
  max_jobs_per_run: 3,
  retention_days: 30,
  total_budget_jpy: 45,
  total_since: now.toISOString(),
  valid_until: new Date(now.getTime() + 72 * 3600_000).toISOString(),
  run_lock_by: null,
  run_lock_until: null,
};
const w = await db.from("shadow_settings").upsert(row);
if (w.error) {
  console.error("書き込みに失敗しました");
  process.exit(1);
}
console.log(`設定しました: 日次15・月次45・通算45・1件3・1回3件・試行期間 ${row.valid_until} まで（自動停止）`);
