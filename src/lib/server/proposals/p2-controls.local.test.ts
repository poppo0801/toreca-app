// @vitest-environment node
/**
 * P2 の無課金の対照（ローカル限定・読み取り専用）。**保存済みのP2の15件のAI出力（値・根拠の種類・引用・判断）を、判断後の工程（検証・応募単位の保存）で再生し、修正前後の差を数える**。
 * 再生できるのは「AIの出力より後の処理」だけ。AIの再実行ではない（実AIでの判断の変化は、再承認された実測でのみ確認できる）。
 *   PROPOSAL_P2_CONTROLS=1 npx vitest run src/lib/server/proposals/p2-controls.local.test.ts
 */
import { writeFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { createClient } from "@supabase/supabase-js";
import { CallBudget } from "@/lib/judgment/call-budget";
import { unitOf, type ProposalField } from "@/lib/judgment/xsource/proposal";
import { mockResearchAgent } from "@/lib/judgment/xsource/proposal-mock";
import type { JudgeOutput } from "@/lib/judgment/xsource/research-loop";
import { runXPostReplay } from "@/lib/judgment/xsource/x-origin";
import { postFromCandidate } from "./generate";

const env = process.env;
describe.skipIf(env.PROPOSAL_P2_CONTROLS !== "1")("P2 対照（判断後の工程の再生）", () => {
  it("保存済みの15件の出力を、修正前後の検証・応募単位の保存で再生する", async () => {
    const url = env.NEXT_PUBLIC_SUPABASE_URL ?? "";
    if (!/^http:\/\/(127\.0\.0\.1|localhost)/.test(url)) throw new Error("ローカルのSupabase以外には接続しません");
    const db = createClient(url, env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } });
    const { data: cands } = await db.from("collection_candidates").select("id,x_post_id,last_good,dedupe_key").like("dedupe_key", "https://eval-p.invalid/%");
    const { data: props } = await db.from("registration_proposals").select("candidate_id,decision,verified,held_reasons,fields,apply_unit,apply_unit_basis").in("candidate_id", (cands ?? []).map((c) => c.id as string)).is("superseded_at", null);
    const byCand = new Map((props ?? []).map((p) => [p.candidate_id as string, p]));
    const rows: Record<string, unknown>[] = [];
    for (const c of (cands ?? []).filter((x) => byCand.has(x.id as string)).sort((a, b) => String(a.dedupe_key).localeCompare(String(b.dedupe_key), "en", { numeric: true }))) {
      const p = byCand.get(c.id as string)!;
      const key = String(c.dedupe_key).replace("https://eval-p.invalid/", "");
      const saved = p.fields as Record<string, ProposalField>;
      const fields: JudgeOutput["fields"] = {};
      for (const [k, f] of Object.entries(saved)) if (!k.startsWith("_")) fields[k] = { value: f.value, basis: f.basis as "observed" | "inferred" | "unknown", ...(f.evidence ? { evidenceId: f.evidence } : {}), ...(f.quote ? { quote: f.quote } : {}) };
      const output: JudgeOutput = { decision: p.decision === "none" ? "tentative" : (p.decision as "register" | "tentative" | "exclude"), fields, rationale: "", unresolvedImpact: "minor", monitor: { continue: true, why: "" }, costJpy: 0 };
      const post = postFromCandidate({ id: c.id, x_post_id: c.x_post_id, last_good: c.last_good })!;
      const linked = ((c.last_good as { evidence?: { linkedPages?: { url: string; text: string }[] } })?.evidence?.linkedPages ?? []);
      const replay = async (registerRequiresUnit: boolean) => {
        const r = await runXPostReplay({ post, agent: mockResearchAgent, judge: async () => output, tools: { now: () => new Date(), fetchPage: async (u) => { const h = linked.find((l) => l.url === u); return h ? { ok: true, finalUrl: h.url, html: `<html><body>${h.text}</body></html>`, text: h.text } : { ok: false, reason: "not_public" }; } }, budget: new CallBudget({ maxCalls: 20, maxCostJpy: 0.0001 }), limits: { agentReserveJpy: 0, judgeReserveJpy: 0, maxRevisions: 0, maxSearches: 0, maxTurns: 3 }, now: new Date(), registerRequiresUnit });
        return r.results[0].result.registration;
      };
      const before = await replay(false); // 修正前相当（応募単位の指摘なし）。根拠なし除外の指摘は新しい共通の検証なので、下で分けて数える
      const after = await replay(true);
      const oldUnit = (() => { const f = saved.apply_unit; const t = f?.value ? { one_form_one: 1, store_select: 1, per_store: 1, per_product: 1 }[f.value.trim() as string] : undefined; return t ? f.value : "unknown"; })();
      const newUnit = unitOf(saved);
      rows.push({ key, decision: p.decision, savedUnit: p.apply_unit, oldUnitRule: oldUnit, newUnitRule: newUnit.unit, issuesBefore: (before.held?.reasons ?? []).filter((x) => x !== "exclude_without_evidence"), issuesAfter: after.held?.reasons ?? [] });
    }
    const flagged = rows.filter((r) => (r.issuesAfter as string[]).length > 0);
    const summary = {
      items: rows.length,
      unitDeterminedOldRule: rows.filter((r) => r.oldUnitRule !== "unknown").length,
      unitDeterminedNewRule: rows.filter((r) => r.newUnitRule !== "unknown").length,
      flaggedBefore: rows.filter((r) => (r.issuesBefore as string[]).length > 0).length,
      flaggedAfter: flagged.length,
      newlyFlagged: flagged.map((r) => `${r.key}:${(r.issuesAfter as string[]).join("+")}`),
      registerWithUnitUnknown: rows.filter((r) => r.decision === "register" && r.newUnitRule === "unknown").map((r) => r.key),
      keptVerifiedWithUnit: rows.filter((r) => (r.issuesAfter as string[]).length === 0 && r.newUnitRule !== "unknown").map((r) => r.key),
    };
    writeFileSync("eval/real-data/p2-controls.json", JSON.stringify({ summary, rows }, null, 1));
    console.log("P2CONTROLS", JSON.stringify(summary));
    expect(rows.length).toBe(15);
  }, 120_000);
});
