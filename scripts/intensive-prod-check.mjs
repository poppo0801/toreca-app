// INTENSIVE_EVALUATION の本番反映後の確認（読み取りのみ・値・原文は出さない）。
//   npm run prod -- scripts/intensive-prod-check.mjs [--since=<ISO>] --yes-production
// 実行台帳の試行の要約（items）・登録案の全項目と記載の状態・人の確認の要否・プロンプト版・判断の段の採用の記録を、件数と項目名だけで出す。
import { createClient } from "@supabase/supabase-js";
import { assertProductionTarget } from "./lib/target.mjs";

assertProductionTarget("intensive-prod-check.mjs");
const since = process.argv.find((a) => a.startsWith("--since="))?.slice(8) ?? new Date(Date.now() - 3 * 3600_000).toISOString();
const db = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
const js = (await db.from("shadow_judgments").select("status,cost_jpy,record,created_at").gte("created_at", since).order("created_at")).data ?? [];
for (const j of js) {
  if (j.record?.kind !== "proposal_shadow") continue;
  console.log("台帳", JSON.stringify({ at: j.created_at, status: j.status, yen: Number(j.cost_jpy), items: (j.record.items ?? []).map((x) => ({ d: x.d, v: x.v, 段: x.t.map((s) => `${s.s}:${s.m}:${s.d}${s.a === undefined ? "" : s.a ? ":採用" : ":不採用"}`), 観察した項目数: x.o.length })) }));
}
const ps = (await db.from("registration_proposals").select("decision,verified,prompt_version,fields,judge_trail,pages,created_at").eq("mode", "real").gte("created_at", since).order("created_at")).data ?? [];
for (const p of ps) {
  const f = p.fields ?? {};
  const keys = Object.keys(f).filter((k) => !k.startsWith("_"));
  console.log("登録案", JSON.stringify({ at: p.created_at, 版: p.prompt_version, 判断: p.decision, 検証: p.verified, 値のある項目: keys.filter((k) => f[k]?.value).length, 記載の状態: keys.filter((k) => f[k]?.absence).map((k) => `${k}:${f[k].absence}`), 人の確認: !!f._ask_human?.value, ページの版: (p.pages ?? []).filter((x) => x.hash).length, 段: (p.judge_trail ?? []).length }));
}
console.log(`台帳 ${js.length}件・登録案 ${ps.length}件（${since} 以降）`);
