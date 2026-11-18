// 収集方式（collection_engine）を切り替える。設定画面の「情報収集方式」の保存と同じ更新（世帯に1つ。データは消さない）。Stage 9H-3R-Release
//   npm run prod -- scripts/set-collection-engine.mjs --engine=autonomous --yes-production            （dry-run: 現在値の表示のみ）
//   npm run prod -- scripts/set-collection-engine.mjs --engine=autonomous --execute --yes-production   （保存）
//   --engine=legacy で従来方式へ戻す。変更は次回の収集実行から反映される（実行中の処理は変更しない）。
import { createClient } from "@supabase/supabase-js";
import { assertProductionTarget } from "./lib/target.mjs";

assertProductionTarget("set-collection-engine.mjs");
const engine = process.argv.find((a) => a.startsWith("--engine="))?.split("=")[1];
if (!["legacy", "autonomous"].includes(engine ?? "")) {
  console.error("--engine=legacy|autonomous を指定してください");
  process.exit(2);
}
const execute = process.argv.includes("--execute");
const db = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
const cur = await db.from("collection_settings").select("household_id, collection_engine, collection_engine_changed_at");
if (cur.error || cur.data?.length !== 1) {
  console.error(`中止: 世帯の設定が1件ではありません（${cur.error?.message ?? `${cur.data?.length}件`}）`);
  process.exit(1);
}
const row = cur.data[0];
console.log(`現在: ${row.collection_engine}（変更日時: ${row.collection_engine_changed_at ?? "-"}）→ 指定: ${engine}`);
if (!execute) {
  console.log("dry-run: 変更していません（--execute で保存）");
  process.exit(0);
}
const up = await db.from("collection_settings").update({ collection_engine: engine, collection_engine_changed_at: new Date().toISOString() }).eq("household_id", row.household_id).select("collection_engine");
if (up.error || up.data?.length !== 1) {
  console.error(`保存できませんでした: ${up.error?.message ?? "対象が1件ではありません"}`);
  process.exit(1);
}
console.log(`保存しました: ${up.data[0].collection_engine}。次回の収集実行から反映されます。`);
