// EVIDENCE_UTILIZATION §1: 現行の収集が登録した抽選の締切の妥当性（読み取りのみ。件数・日数だけ。原文・店名・URLは出さない）。
//   npm run prod -- scripts/eu-lottery-date-audit.mjs [--days=14] --yes-production
// 登録の時点で締切を過ぎていたもの・締切が登録から120日より先のもの（年の推定の誤りの疑い）を数える。
import { createClient } from "@supabase/supabase-js";
import { assertProductionTarget } from "./lib/target.mjs";

assertProductionTarget("eu-lottery-date-audit.mjs");
const days = Number(process.argv.find((a) => a.startsWith("--days="))?.slice(7) ?? 14);
const since = new Date(Date.now() - days * 86_400_000).toISOString();
const db = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
const lots = (await db.from("lotteries").select("id,source_kind,created_at,apply_deadline_at,apply_deadline_date,archived_at").gte("created_at", since)).data ?? [];
const out = { 期間日: days, 抽選: lots.length, 由来: {}, 締切なし: 0, 登録時に締切済み: 0, 締切が120日超先: 0, 例: [] };
for (const l of lots) {
  out.由来[l.source_kind ?? "?"] = (out.由来[l.source_kind ?? "?"] ?? 0) + 1;
  const d = l.apply_deadline_at ?? (l.apply_deadline_date ? `${l.apply_deadline_date}T14:59:59Z` : null);
  if (!d) {
    out.締切なし++;
    continue;
  }
  const diff = (new Date(d).getTime() - new Date(l.created_at).getTime()) / 86_400_000;
  if (diff < 0) out.登録時に締切済み++;
  if (diff > 120) out.締切が120日超先++;
  if (diff < 0 || diff > 120) out.例.push({ id: l.id.slice(0, 8), 由来: l.source_kind, 締切まで日: Math.round(diff), アーカイブ: !!l.archived_at });
}
out.例 = out.例.slice(0, 20);
console.log(JSON.stringify(out));
// --candidate=<候補IDの先頭8桁>: その候補が結び付いた抽選の締切（日数だけ）
const cp = process.argv.find((a) => a.startsWith("--candidate="))?.slice(12);
if (cp && /^[0-9a-f]{8}$/.test(cp)) {
  const cs = (await db.from("collection_candidates").select("id,status,lottery_id,created_at").gte("created_at", since)).data ?? [];
  const c = cs.find((x) => x.id.startsWith(cp));
  const l = c?.lottery_id ? (await db.from("lotteries").select("created_at,apply_deadline_at,apply_deadline_date,source_kind,archived_at").eq("id", c.lottery_id).maybeSingle()).data : null;
  const d = l ? (l.apply_deadline_at ?? (l.apply_deadline_date ? `${l.apply_deadline_date}T14:59:59Z` : null)) : null;
  console.log("候補", JSON.stringify({ status: c?.status ?? null, 抽選: !!l, 由来: l?.source_kind ?? null, 抽選の作成: l?.created_at?.slice(0, 10) ?? null, 締切: d ? d.slice(0, 10) : null, アーカイブ: !!l?.archived_at }));
}
