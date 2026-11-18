// 本番の定期実行（Supabase pg_cron → pg_net → Vercel）の実行状況の確認。読み取り専用（サービスロールの select のみ）。Stage 9H-3R-Release
//   npm run prod -- scripts/check-cron-prod.mjs --yes-production
// 確認: ①直近の呼び出し結果（pg_net の応答コード・間隔＝実効のスケジュール）②収集の実行履歴（collection_runs）③自律型の調査履歴（discovery_runs の有無）
// cron.job の定義そのもの（スケジュール式・有効/無効）は、Supabase CLI の --linked が設定で禁止されているためここでは読まない（間隔から推定）。
// 秘密（CRON_SECRET・Vault の値）は読まない・出さない。
import { readFileSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";
import { assertProductionTarget } from "./lib/target.mjs";

assertProductionTarget("check-cron-prod.mjs");
const linked = readFileSync("supabase/.temp/project-ref", "utf8").trim();
if (!(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "").includes(linked)) {
  console.error("リンク先と本番の設定の接続先が一致しません");
  process.exit(1);
}
const db = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
const jst = (s) => (s ? new Date(s).toLocaleString("ja-JP", { timeZone: "Asia/Tokyo", hour12: false }) : "-");

const calls = await db.from("notification_cron_calls").select("job, called_at, status_code, error_msg").order("called_at", { ascending: false }).limit(80);
console.log("① 直近の呼び出し（pg_net の応答）:");
if (calls.error) console.log(`  読み取れませんでした: ${calls.error.message}`);
else {
  const byJob = {};
  for (const c of calls.data) (byJob[c.job] ??= []).push(c);
  for (const [job, rows] of Object.entries(byJob)) {
    const answered = rows.filter((r) => r.status_code != null);
    const ok = answered.filter((r) => r.status_code === 200).length;
    const gaps = rows.slice(0, -1).map((r, i) => (new Date(r.called_at) - new Date(rows[i + 1].called_at)) / 60000).sort((a, b) => a - b);
    const med = gaps.length ? gaps[Math.floor(gaps.length / 2)] : null;
    console.log(`  - ${job}: 直近${rows.length}件（応答あり${answered.length}）中 HTTP 200 が ${ok}件／最新 ${jst(rows[0].called_at)}／間隔の中央値 ${med?.toFixed(1) ?? "-"}分`);
    for (const b of answered.filter((r) => r.status_code !== 200).slice(0, 3)) console.log(`      ! ${jst(b.called_at)} ${b.status_code} ${String(b.error_msg ?? "").slice(0, 80)}`);
  }
}

const runs = await db.from("collection_runs").select("started_at, phase, status, trigger, stop_reason").order("started_at", { ascending: false }).limit(5);
console.log("\n② 収集の実行履歴（collection_runs・直近5件）:");
if (runs.error) console.log(`  読み取れませんでした: ${runs.error.message}`);
else for (const r of runs.data) console.log(`  - ${jst(r.started_at)} ${r.phase ?? ""} ${r.status} ${r.trigger ?? ""} ${r.stop_reason ?? ""}`);
const dr = await db.from("discovery_runs").select("id", { count: "exact", head: true });
console.log(`\n③ 自律型の調査履歴（discovery_runs）: ${dr.error || dr.count == null ? "表なし（マイグレーション未適用）" : `${dr.count}件`}`);
