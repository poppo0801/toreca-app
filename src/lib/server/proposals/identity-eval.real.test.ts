// @vitest-environment node
/**
 * 同一性の隔離評価（JUDGMENT_IDENTITY_EFFICIENCY §2）の**評価入口**（開発専用・DBを使わない）。`scripts/identity-eval.mjs` が起動する。
 *   入力: eval/identity/cases.local.json（保存済みの新AIの登録案の項目・基準時刻）、snapshot.local.json（本番の抽選の書き出し）。
 *   照合の相手: 基準時刻より前に作られた抽選（非表示は印つき）＋基準時刻がより前の他の候補の新AIの項目（候補間）＋同じ投稿の前の項目。将来の情報は混ぜない。
 *   **有料**: 関門（承認額・確認・開発用の既存キー・ローカル）を通ったときだけ実AIを呼ぶ。本番シャドーと同じ judgeIdentity（検索→AI→検証）。
 *   全試行を eval/identity/runs/<run>.local.jsonl に追記する。正解（gold.local.json）はこの入口では読まない（採点は scripts/identity-score.mjs）。
 */
import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { CallBudget } from "@/lib/judgment/call-budget";
import { checkJudgmentRealRun, INTENSIVE_CAPS } from "@/lib/judgment/real-gate";
import { judgeIdentity, makeAnthropicIdentityJudge, opportunityFromRecord, type ExistingOpportunity } from "@/lib/judgment/xsource/opportunity-identity";

vi.mock("server-only", () => ({}));
const env = process.env;
const DIR = "eval/identity";
type Item = { itemNo: number; decision: string; sourceUrls: string[]; pages: { url?: string }[]; fields: Record<string, { value: string | null; quote?: string | null }> };
type Case = { caseId: string; candidateId: string; basisAt: string; postUrl: string | null; text?: string; items: Item[] };
type Lot = { id: string; chain: string; store: string; storeMode: string; selectableStores: string[]; products: string[]; applyStart: string | null; applyDeadline: string | null; result: string | null; sourceUrls: string[]; sourceKind: string; createdAt: string; archivedAt: string | null; hasApplications: boolean };

const asProposal = (c: Case, it: Item): ExistingOpportunity => ({ id: `p:${c.caseId}#${it.itemNo}`, kind: "proposal", chain: "", store: it.fields.store?.value ?? "", storeMode: it.fields.apply_unit?.value ?? "unknown", selectableStores: [], products: it.fields.product?.value ? [it.fields.product.value] : [], applyStart: it.fields.apply_start?.value ?? null, applyDeadline: it.fields.deadline?.value ?? null, result: it.fields.result_at?.value ?? null, sourceUrls: [...it.sourceUrls, ...(String(it.fields.apply_url?.value ?? "").startsWith("http") ? [String(it.fields.apply_url!.value)] : [])], createdAt: c.basisAt, humanConfirmed: false, decision: it.decision });

describe.skipIf(env.JUDGMENT_IDENTITY_EVAL !== "1")("同一性の隔離評価（評価入口）", () => {
  it("run: 実AIで照合する（有料・関門つき）", { timeout: 3_600_000 }, async () => {
    const run = env.IDENTITY_RUN!;
    expect(run).toMatch(/^[a-z0-9-]{2,40}$/);
    const dry = env.IDENTITY_DRY === "1"; // 検索だけ（AIを呼ばない・無課金）: 検索の再現率を測る
    const gate = dry ? null : checkJudgmentRealRun({ env, confirm: env.JUDGMENT_REAL_CONFIRM === "yes", approvedTotalJpy: Number(env.JUDGMENT_APPROVED_TOTAL_JPY), approvedPerCaseJpy: Number(env.JUDGMENT_APPROVED_PER_CASE_JPY), caps: INTENSIVE_CAPS });
    if (gate && !gate.ok) throw new Error(`実行しません: ${gate.reason}`);
    const { cases } = JSON.parse(readFileSync(`${DIR}/cases.local.json`, "utf8")) as { cases: Case[] };
    const { lotteries } = JSON.parse(readFileSync(`${DIR}/snapshot.local.json`, "utf8")) as { lotteries: Lot[] };
    const only = (env.IDENTITY_CASES || "").split(",").filter(Boolean);
    const effort = (env.IDENTITY_EFFORT || "medium") as "low" | "medium" | "high";
    const thinking = env.IDENTITY_THINKING !== "off";
    const model = env.IDENTITY_MODEL === "sonnet" ? "claude-sonnet-5-5" : "claude-haiku-5-5";
    let judge: Parameters<typeof judgeIdentity>[0]["judge"];
    const diagnostics: Record<string, number> = {};
    if (gate && gate.ok) {
      const { default: Anthropic } = await import("@anthropic-ai/sdk");
      judge = makeAnthropicIdentityJudge(new Anthropic({ apiKey: gate.apiKey, maxRetries: 0 }), { model, effort, thinking, onDiagnostic: (d) => (diagnostics[d.reason] = (diagnostics[d.reason] ?? 0) + 1) });
    }
    const cap = gate && gate.ok ? gate.totalCapJpy : 0;
    let spentAll = 0;
    mkdirSync(`${DIR}/runs`, { recursive: true });
    const journal = `${DIR}/runs/${run}.local.jsonl`;
    let total = 0;
    outer: for (const c of cases) {
      if (only.length && !only.includes(c.caseId)) continue;
      if (c.caseId === "76ec39e8") continue; // 正解の対象外（51項目の一覧）
      const lots: ExistingOpportunity[] = lotteries.filter((l) => l.createdAt <= c.basisAt).map((l) => ({ id: l.id, kind: "lottery", chain: l.chain, store: l.store, storeMode: l.storeMode, selectableStores: l.selectableStores, products: l.products, applyStart: l.applyStart, applyDeadline: l.applyDeadline, result: l.result, sourceUrls: l.sourceUrls, createdAt: l.createdAt, humanConfirmed: l.sourceKind !== "auto" || l.hasApplications, ...(l.archivedAt && l.archivedAt <= c.basisAt ? { archived: true } : {}) }));
      const others = cases.filter((o) => o.caseId !== c.caseId && o.basisAt < c.basisAt).flatMap((o) => o.items.map((it) => asProposal(o, it)));
      for (const [i, it] of c.items.entries()) {
        const siblings = c.items.slice(0, i).map((x) => asProposal(c, x));
        const per = new CallBudget({ maxCalls: 4, maxCostJpy: dry ? 0.0001 : Math.max(0.0001, Math.min(Number(env.JUDGMENT_APPROVED_PER_CASE_JPY) || 5, cap - spentAll)) });
        const t0 = Date.now();
        const r = await judgeIdentity({ opportunity: opportunityFromRecord({ proposalKey: `${c.caseId}#${it.itemNo}`, decision: it.decision, sourceUrls: it.sourceUrls, fields: it.fields, pages: it.pages }, c.postUrl ? [c.postUrl] : [], env.IDENTITY_NO_TEXT === "1" ? undefined : c.text), existing: [...lots, ...others, ...siblings], ...(judge && !dry ? { judge } : {}), budget: per, basisAt: c.basisAt, model });
        const spent = per.costJpy;
        spentAll += spent;
        total++;
        appendFileSync(journal, JSON.stringify({ run, at: new Date().toISOString(), key: `${c.caseId}#${it.itemNo}`, model, effort, thinking, dry, ms: Date.now() - t0, costJpy: spent, result: r }) + "\n");
        if (!dry && spentAll >= cap - 0.5) break outer; // 承認額に達した（以降は未評価として残す）
      }
    }
    appendFileSync(journal, JSON.stringify({ run, kind: "run_stop", at: new Date().toISOString(), items: total, costJpy: Math.round(spentAll * 10000) / 10000, diagnostics }) + "\n");
    expect(total).toBeGreaterThan(0);
  });
});
