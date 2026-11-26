// 実運用の正解記録の集計（読み取りのみ。ADAPTIVE_REVIEW）。原文・値・URL・個人情報は出さない（件数・項目名・モデル名・費用だけ）。
//   npm run prod -- scripts/proposal-truth-report.mjs [--since=2026-11-26T00:00:00Z] --yes-production
// 区別: 正解が記録された件数／判断の一致（AIの最終の扱い vs 人の正解）／誤登録・誤除外・不要な保留／項目の修正・明示的な不明／取りこぼし／モデルの段（適応型）／費用。
// 「後で確認」と未記録は、正解とも不正解とも数えない。
import { createClient } from "@supabase/supabase-js";
import { assertProductionTarget } from "./lib/target.mjs";

assertProductionTarget("proposal-truth-report.mjs");
const since = process.argv.find((a) => a.startsWith("--since="))?.slice(8) ?? "2026-11-25T00:00:00Z";
const db = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });

const reviews = (await db.from("registration_proposal_reviews").select("kind,verdict,truth_decision,opportunity,user_fit,edits,unknown_fields,ai_snapshot,proposal_key,candidate_id,created_at").gte("created_at", since).order("created_at")).data ?? [];
const props = (await db.from("registration_proposals").select("proposal_key,decision,verified,model_id,judge_trail,cost_jpy,superseded_at,created_at").eq("mode", "real").gte("created_at", since)).data ?? [];

const latestTruth = new Map();
for (const r of reviews) if (r.kind === "truth") latestTruth.set(r.proposal_key, r); // 新しいものが後に来る
const aiFinal = (s) => (s?.verified ? (s.decision === "tentative" || s.decision === "none" ? "hold" : s.decision) : "hold");
const out = { 期間の開始: since, 登録案_現行: props.filter((p) => !p.superseded_at).length, 正解: { 正しい: 0, 修正: 0, 後で確認: 0 }, 判断: { 一致: 0, 誤登録: 0, 誤除外: 0, 不要な保留: 0, 登録漏れ: 0, その他の不一致: 0 }, 項目の修正: {}, 明示的な不明: {}, 取りこぼし: reviews.filter((r) => r.kind === "missed").length, 機会: {}, 利用者適合: {}, モデル: {}, 適応型: { 上位を使用: 0, 理由: {}, 採用: 0 }, 費用_円: 0 };
for (const t of latestTruth.values()) {
  if (t.verdict === "unknown_later") { out.正解.後で確認++; continue; }
  out.正解[t.verdict === "correct" ? "正しい" : "修正"]++;
  const ai = aiFinal(t.ai_snapshot);
  const truth = t.truth_decision ?? ai;
  if (ai === truth) out.判断.一致++;
  else if (ai === "register" && truth !== "register") out.判断.誤登録++;
  else if (ai === "exclude" && truth !== "exclude") out.判断.誤除外++;
  else if (ai === "hold" && truth === "register") out.判断.登録漏れ++;
  else if (ai === "hold" && truth === "exclude") out.判断.不要な保留++;
  else out.判断.その他の不一致++;
  for (const k of Object.keys(t.edits ?? {})) out.項目の修正[k] = (out.項目の修正[k] ?? 0) + 1;
  for (const k of t.unknown_fields ?? []) out.明示的な不明[k] = (out.明示的な不明[k] ?? 0) + 1;
  if (t.opportunity) out.機会[t.opportunity] = (out.機会[t.opportunity] ?? 0) + 1;
  if (t.user_fit) out.利用者適合[t.user_fit] = (out.利用者適合[t.user_fit] ?? 0) + 1;
  const m = t.ai_snapshot?.model_id ?? "?";
  out.モデル[m] = (out.モデル[m] ?? 0) + 1;
}
for (const p of props) {
  out.費用_円 += Number(p.cost_jpy ?? 0);
  const esc = (p.judge_trail ?? []).filter((s) => s.stage === "escalated");
  if (esc.length) {
    out.適応型.上位を使用++;
    for (const s of esc) out.適応型.理由[s.reason ?? "?"] = (out.適応型.理由[s.reason ?? "?"] ?? 0) + 1;
    if (esc.some((s) => s.verified) && !p.superseded_at) out.適応型.採用++;
  }
}
out.費用_円 = Math.round(out.費用_円 * 100) / 100;
console.log(JSON.stringify(out, null, 1));
