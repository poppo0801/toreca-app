// 実運用の正解記録の集計（読み取りのみ。ADAPTIVE_REVIEW → INTENSIVE_EVALUATION で是正）。原文・値・URL・個人情報は出さない（件数・項目名・モデル名・費用だけ）。
//   npm run prod -- scripts/proposal-truth-report.mjs [--since=2026-11-26T00:00:00Z] --yes-production
// 是正（INTENSIVE_EVALUATION §1）:
//  - 判断の精度の分母は「人が判断を確定した正解」だけ（正しい＝AIの判断をそのまま正解とした／修正で判断を明示した）。修正で判断を指定していない（項目だけの修正）ものは判断の分母に入れない（以前は AIの判断で埋めて一致扱いしていた）。
//  - 後で確認・未記録は、正解とも不正解とも数えない。正解の記録時点の登録案（ai_snapshot）と照合する。
//  - 上位モデルは「使用」「検証通過」「採用」を分ける（検証を通っても食い違いで保留にしたものは採用ではない。段の adopted を使い、旧い記録は最終の判断との一致で判定）。
//  - 試行（実行台帳 shadow_judgments の行）・呼び出し・案件を分ける。費用は版の保存件数ではなく実行台帳の実測を合計する。
import { createClient } from "@supabase/supabase-js";
import { assertProductionTarget } from "./lib/target.mjs";

assertProductionTarget("proposal-truth-report.mjs");
const since = process.argv.find((a) => a.startsWith("--since="))?.slice(8) ?? "2026-11-25T00:00:00Z";
const db = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });

const reviews = (await db.from("registration_proposal_reviews").select("kind,verdict,truth_decision,opportunity,user_fit,edits,unknown_fields,ai_snapshot,proposal_key,candidate_id,created_at").gte("created_at", since).order("created_at")).data ?? [];
const props = (await db.from("registration_proposals").select("proposal_key,candidate_id,decision,verified,model_id,judge_trail,cost_jpy,superseded_at,created_at").eq("mode", "real").gte("created_at", since)).data ?? [];
const ledger = (await db.from("shadow_judgments").select("candidate_id,status,cost_jpy,record,created_at").gte("created_at", since)).data ?? [];

export const aiFinal = (s) => (s?.verified ? (s.decision === "tentative" || s.decision === "none" ? "hold" : s.decision) : "hold");
const latestTruth = new Map();
for (const r of reviews) if (r.kind === "truth") latestTruth.set(r.proposal_key, r); // 新しいものが後に来る
const out = {
  期間の開始: since,
  登録案: { 現行: props.filter((p) => !p.superseded_at).length, 版: props.length, 案件: new Set(props.map((p) => p.candidate_id)).size },
  正解の記録: { 正しい: 0, 修正_判断あり: 0, 修正_項目だけ: 0, 後で確認: 0 },
  判断: { 分母: 0, 一致: 0, 誤登録: 0, 誤除外: 0, 不要な保留: 0, 登録漏れ: 0, その他の不一致: 0 },
  項目の修正: {},
  明示的な不明: {},
  取りこぼし: reviews.filter((r) => r.kind === "missed").length,
  機会: {},
  利用者適合: {},
  モデル: {},
  上位: { 使用: 0, 検証通過: 0, 採用: 0, 食い違いで保留: 0, 理由: {} },
  実行台帳: { 試行: 0, 失敗: 0, 費用_円: 0, 案件: 0 },
};
for (const t of latestTruth.values()) {
  if (t.verdict === "unknown_later") {
    out.正解の記録.後で確認++;
    continue;
  }
  const ai = aiFinal(t.ai_snapshot);
  // 人が判断を確定したものだけ判断の分母に入れる
  const truth = t.verdict === "correct" ? ai : t.truth_decision ?? null;
  if (t.verdict === "correct") out.正解の記録.正しい++;
  else if (truth) out.正解の記録.修正_判断あり++;
  else out.正解の記録.修正_項目だけ++;
  if (truth) {
    out.判断.分母++;
    if (ai === truth) out.判断.一致++;
    else if (ai === "register") out.判断.誤登録++;
    else if (ai === "exclude") out.判断.誤除外++;
    else if (ai === "hold" && truth === "register") out.判断.登録漏れ++;
    else if (ai === "hold" && truth === "exclude") out.判断.不要な保留++;
    else out.判断.その他の不一致++;
  }
  for (const k of Object.keys(t.edits ?? {})) out.項目の修正[k] = (out.項目の修正[k] ?? 0) + 1;
  for (const k of t.unknown_fields ?? []) out.明示的な不明[k] = (out.明示的な不明[k] ?? 0) + 1;
  if (t.opportunity) out.機会[t.opportunity] = (out.機会[t.opportunity] ?? 0) + 1;
  if (t.user_fit) out.利用者適合[t.user_fit] = (out.利用者適合[t.user_fit] ?? 0) + 1;
  const m = t.ai_snapshot?.model_id ?? "?";
  out.モデル[m] = (out.モデル[m] ?? 0) + 1;
}
for (const p of props) {
  const esc = (p.judge_trail ?? []).filter((s) => s.stage === "escalated");
  if (!esc.length) continue;
  out.上位.使用++;
  for (const s of esc) out.上位.理由[s.reason ?? "?"] = (out.上位.理由[s.reason ?? "?"] ?? 0) + 1;
  if (esc.some((s) => s.verified)) out.上位.検証通過++;
  const adopted = esc.some((s) => (s.adopted !== undefined ? s.adopted : s.verified && s.note !== "disagreement" && s.decision === p.decision));
  if (adopted) out.上位.採用++;
  else if (esc.some((s) => s.verified)) out.上位.食い違いで保留++;
}
for (const j of ledger) {
  if (j.record?.kind !== "proposal_shadow") continue;
  out.実行台帳.試行++;
  if (j.status !== "accepted" && j.status !== "partial") out.実行台帳.失敗++;
  out.実行台帳.費用_円 += Number(j.cost_jpy ?? 0);
}
out.実行台帳.案件 = new Set(ledger.filter((j) => j.record?.kind === "proposal_shadow").map((j) => j.candidate_id)).size;
out.実行台帳.費用_円 = Math.round(out.実行台帳.費用_円 * 100) / 100;
console.log(JSON.stringify(out, null, 1));
