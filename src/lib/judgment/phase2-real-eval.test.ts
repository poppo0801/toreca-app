// @vitest-environment node
/**
 * 実データ（保存済み実原文）の新旧比較の入口（Stage 10F）。**通常のテスト実行では何もしない（スキップ）**。実行は `node scripts/eval-judgment-phase2.mjs …` から。
 *  - preflight（JUDGMENT_PHASE2_PREFLIGHT=1）: 抽出ファイル・確認記録・承認ゲートの状態と、送信可否の件数・費用の見積もりだけを表示。**API・ネットワークに接続しない**。原文は表示しない。
 *  - run（JUDGMENT_PHASE2_RUN=1）: **実API（有料・実原文を外部へ送信）**。次がすべて揃わなければ実行しない:
 *      承認ゲート A・B・C・E（eval/real-data/approvals.json）／人の全件目視の記録（reviewed.json）／漏洩検出に1件も引っかからない原文のみ／
 *      実AIの関門 `checkJudgmentRealRun`（開発環境・許可・キー・承認額・確認）／モデルの利用可否の確認。
 *    Anthropic API の保持条件の確認は、ゲートC（承認記録の範囲 scope に確認済みの旨を記載）として人が行う。コードでは確認できない。
 * 入力: eval/real-data/extract-*.json（最新）と eval/real-data/reviewed.json（{ "reviewedBy": "...", "reviewedAt": "YYYY-MM-DD", "ids": [...] }）。いずれも Git管理外。
 * 出力: eval/runs/shadow/phase2-<時刻>.jsonl（非機微な記録のみ）。連番↔行の対応は保存しない（コンソールにも出さない）。
 */
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { AnthropicJudgmentModel } from "./anthropic-model";
import type { StoredRow } from "./eval/phase2";
import { prepareForExternal } from "./eval/phase2";
import { phase2CostPlan } from "./eval/phase2-compare";
import { runPhase2Comparison } from "./eval/phase2-run";
import { checkJudgmentRealRun, CANDIDATE_CAP_PER_CASE_JPY, CANDIDATE_CAP_TOTAL_JPY } from "./real-gate";
import { LocalFileSink } from "./shadow/file-sink";

// @ts-expect-error .mjs（型定義なし）
const gatesMod = (await import("../../../scripts/lib/phase2-extract.mjs")) as {
  readApprovals: () => Record<string, { approved: boolean }>;
  checkGates: (a: string, ap: Record<string, { approved: boolean }>) => { ok: boolean; missing: string[] };
};

const env = process.env;
const DIR = "eval/real-data";

function load(): { rows: StoredRow[]; reviewed: Set<string>; reviewer: string | null } {
  const files = existsSync(DIR) ? readdirSync(DIR).filter((f) => /^extract-.*\.json$/.test(f)).sort() : [];
  if (!files.length) throw new Error("抽出ファイル（eval/real-data/extract-*.json）がありません");
  const ex = JSON.parse(readFileSync(`${DIR}/${files.at(-1)}`, "utf8")) as { rows: { id: string | null; evidence_text: string | null; evidence_fetched_at: string | null }[] };
  const rows: StoredRow[] = ex.rows.map((r, i) => ({ id: r.id ?? `row-${i}`, stratum: "unlabeled", text: r.evidence_text, fetchedAt: r.evidence_fetched_at }));
  let reviewed = new Set<string>();
  let reviewer: string | null = null;
  if (existsSync(`${DIR}/reviewed.json`)) {
    const j = JSON.parse(readFileSync(`${DIR}/reviewed.json`, "utf8")) as { reviewedBy?: string; reviewedAt?: string; ids?: string[] };
    // 確認者・確認日の記載があり、AI名義でない記録だけを有効とする
    if (j.reviewedBy && !/ai|claude|bot|auto/i.test(j.reviewedBy) && /^\d{4}-\d{2}-\d{2}$/.test(j.reviewedAt ?? "")) {
      reviewed = new Set(j.ids ?? []);
      reviewer = j.reviewedBy;
    }
  }
  return { rows, reviewed, reviewer };
}

describe.skipIf(env.JUDGMENT_PHASE2_PREFLIGHT !== "1")("実データ新旧比較: 実行前の確認（API非接続）", () => {
  it("ゲート・全件目視の記録・送信可否の件数・費用の見積もりを表示する（原文・ID・URLは表示しない）", () => {
    const { rows, reviewed, reviewer } = load();
    const prepared = prepareForExternal(rows, reviewed);
    const byDecision: Record<string, number> = {};
    for (const p of prepared) byDecision[p.decision] = (byDecision[p.decision] ?? 0) + 1;
    const approvals = gatesMod.readApprovals();
    const g = gatesMod.checkGates("paid_eval", approvals);
    const total = Number(env.JUDGMENT_APPROVED_TOTAL_JPY) || CANDIDATE_CAP_TOTAL_JPY;
    const per = Number(env.JUDGMENT_APPROVED_PER_CASE_JPY) || CANDIDATE_CAP_PER_CASE_JPY;
    const gate = checkJudgmentRealRun({ env, confirm: true, approvedTotalJpy: total, approvedPerCaseJpy: per });
    const send = prepared.filter((p) => p.decision === "ready").length;
    console.log(JSON.stringify({ rows: rows.length, byDecision, reviewedBy: reviewer ? "記録あり" : "記録なし（全件送信不可）", approvalGates: g.ok ? "A・B・C・E 承認記録あり" : `未承認: ${g.missing.join("・")}`, realGate: gate.ok ? `通過（キーの出所: ${gate.keySource}）` : `未通過: ${gate.reason}`, costPlan: phase2CostPlan(send, false, { totalCapJpy: total, perCaseCapJpy: per }) }, null, 2));
    expect(rows.length).toBeGreaterThan(0);
  });
});

describe.skipIf(env.JUDGMENT_PHASE2_RUN !== "1")("実データ新旧比較: 実AIの実行（有料・実原文を外部へ送信・承認後のみ）", () => {
  it("全ての関門を通ったときだけ、承認済みの伏せ字本文を新方式に渡して比較を記録する", async () => {
    const approvals = gatesMod.readApprovals();
    const g = gatesMod.checkGates("paid_eval", approvals);
    if (!g.ok) throw new Error(`実行しません: 承認ゲート ${g.missing.join("・")} が未承認です`);
    const total = Number(env.JUDGMENT_APPROVED_TOTAL_JPY);
    const per = Number(env.JUDGMENT_APPROVED_PER_CASE_JPY);
    const gate = checkJudgmentRealRun({ env, confirm: env.JUDGMENT_REAL_CONFIRM === "yes", approvedTotalJpy: total, approvedPerCaseJpy: per });
    if (!gate.ok) throw new Error(`実行しません: ${gate.reason}`);
    const { rows, reviewed } = load();
    const { default: Anthropic } = await import("@anthropic-ai/sdk");
    const client = new Anthropic({ apiKey: gate.apiKey, maxRetries: 0 });
    await client.models.retrieve(gate.model); // 利用可否の確認（料金なし）
    const model = new AnthropicJudgmentModel(client, { model: gate.model });
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const sink = new LocalFileSink(`phase2-${stamp}.jsonl`);
    const res = await runPhase2Comparison(rows, { model, sink, gates: g, reviewedIds: reviewed, totalCapJpy: gate.totalCapJpy, perCaseCapJpy: gate.perCaseCapJpy, now: new Date() });
    writeFileSync(`${DIR}/phase2-summary-${stamp}.json`, JSON.stringify({ prepared: res.prepared, sent: res.sent, skipped: res.skipped, spentJpy: res.spentJpy, summary: res.summary, keySource: gate.keySource, usage: model.usageLog.map((u) => ({ ...u, shape: undefined })), notice: res.notice }, null, 2));
    console.log(JSON.stringify({ sent: res.sent, skipped: res.skipped, spentJpy: res.spentJpy, summary: res.summary }, null, 2));
  }, 1_200_000);
});
