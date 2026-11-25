// @vitest-environment node
/**
 * P2 の15件を、段階ごとに追跡する（ローカル限定・読み取り専用・無課金。AI・Webに接続しない）。
 *   PROPOSAL_P2_TRACE=1 npx vitest run src/lib/server/proposals/p2-trace.local.test.ts
 * 段階: ①入力（候補の保存原文・リンクの出所）→ ②AIに見せた本文（整形後の本文・抜粋2,500字・構造化の観察）→ ③応募単位に関する記載の位置（抜粋内か／観察に出ているか）→ ④AIの判断（応募単位の項目・根拠の種類・引用）→ ⑤検証・保存（判断・検証・保留理由）。
 * 判断側（RegistrationJudge）に実際に渡る入力は、保存済みの候補から調査ループを再生して**そのまま記録**する（調査AIは「項目自身のリンクを1回取得して止まる」代役。実AIの調査手順の再現ではないが、判断への入力は実AIの調査（取得→2ターン）と同じ構造）。
 * 出力: eval/real-data/p2-trace.{md,json}（Git管理外。原文・値を含むのでGitに入れない）。分類はこの出力を人（開発者）が読んで行う。
 */
import { readFileSync, writeFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { createClient } from "@supabase/supabase-js";
import { CallBudget } from "@/lib/judgment/call-budget";
import { pageText } from "@/lib/judgment/xsource/html-text";
import { parseApplyPage, structureToObservations } from "@/lib/judgment/xsource/page-structure";
import { EXCERPT_CHARS, type JudgeInput } from "@/lib/judgment/xsource/research-loop";
import { renderJudgeInput } from "@/lib/judgment/xsource/research-ai";
import { runXPostReplay } from "@/lib/judgment/xsource/x-origin";
import { mockResearchAgent } from "@/lib/judgment/xsource/proposal-mock";
import { postFromCandidate } from "./generate";

const env = process.env;
const PHRASES: [string, RegExp][] = [
  ["お1人様N回", /お1人様[^。\n]{0,24}/g],
  ["1店舗のみ", /1店舗(のみ|だけ)[^。\n]{0,24}/g],
  ["各店舗/店舗ごと", /(各店舗|店舗ごと|店舗別|店舗毎)[^。\n]{0,24}/g],
  ["店舗選択", /店舗(を|の)?(選択|選んで|お選び)[^。\n]{0,24}/g],
  ["1回のみ/まで", /1回(のみ|だけ|まで)[^。\n]{0,20}/g],
  ["ご応募は1", /(ご?応募|お申し込み|お申込)[^。\n]{0,10}1(回|度)[^。\n]{0,16}/g],
];

describe.skipIf(env.PROPOSAL_P2_TRACE !== "1")("P2 追跡（ローカル限定）", () => {
  it("15件を段階ごとに記録する", async () => {
    const url = env.NEXT_PUBLIC_SUPABASE_URL ?? "";
    if (!/^http:\/\/(127\.0\.0\.1|localhost)/.test(url)) throw new Error("ローカルのSupabase以外には接続しません");
    const db = createClient(url, env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } });
    const { data: cands } = await db.from("collection_candidates").select("id,x_post_id,source_url,last_good,dedupe_key").like("dedupe_key", "https://eval-p.invalid/%");
    const { data: props } = await db.from("registration_proposals").select("candidate_id,decision,verified,apply_unit,apply_unit_basis,fields,held_reasons,unknowns,end_reason,turns").in("candidate_id", (cands ?? []).map((c) => c.id as string)).is("superseded_at", null);
    const by = new Map((props ?? []).map((p) => [p.candidate_id as string, p]));
    const rows: Record<string, unknown>[] = [];
    const md: string[] = ["# P2 追跡（ローカル限定・Git管理外）", ""];
    for (const c of (cands ?? []).slice().sort((a, b) => String(a.dedupe_key).localeCompare(String(b.dedupe_key), "en", { numeric: true }))) {
      const key = String(c.dedupe_key).replace("https://eval-p.invalid/", "");
      const p = by.get(c.id as string);
      const post = postFromCandidate({ id: c.id, x_post_id: c.x_post_id, last_good: c.last_good })!;
      // ②③: 判断側が受け取る入力を再生で記録
      let judgeInput: JudgeInput | null = null;
      await runXPostReplay({
        post,
        agent: mockResearchAgent,
        judge: async (i) => ((judgeInput = i), { decision: "tentative", fields: {}, rationale: "", unresolvedImpact: "minor", monitor: { continue: true, why: "" }, costJpy: 0 }),
        tools: {
          now: () => new Date(),
          fetchPage: async (u) => {
            const hit = ((c.last_good as { evidence?: { linkedPages?: { url: string; text: string }[] } })?.evidence?.linkedPages ?? []).find((l) => l.url === u);
            return hit ? { ok: true, finalUrl: hit.url, html: `<html><body>${hit.text}</body></html>`, text: hit.text } : { ok: false, reason: "not_public" };
          },
        },
        budget: new CallBudget({ maxCalls: 20, maxCostJpy: 0.0001 }),
        limits: { agentReserveJpy: 0, judgeReserveJpy: 0, searchReserveJpy: 0, maxSearches: 0, maxTurns: 3, maxFetches: 3 },
        now: new Date(),
      });
      const rendered = judgeInput ? renderJudgeInput(judgeInput) : "";
      const pageEv = (judgeInput as JudgeInput | null)?.evidence.find((e) => e.kind === "page");
      const exc = pageEv?.excerpt ?? "";
      // 参考: 収集が保存した linkedPages（最大3,000字）ではなく、ここでは保存ページ（LP は元のHTML全体）の整形後の本文で位置を調べる
      let fullText = "";
      let structure: ReturnType<typeof parseApplyPage> | null = null;
      if (key.startsWith("lp/")) {
        const html = readFileSync(`eval/real-data/10t-html/lp-${key.slice(3)}.html`, "utf8");
        fullText = pageText(html);
        structure = parseApplyPage(html);
      }
      const obs = structure ? structureToObservations(structure).join("\n") : "";
      const phr = PHRASES.map(([name, re]) => {
        const hits = [...fullText.matchAll(re)].map((m) => ({ at: m.index ?? 0, s: m[0].slice(0, 40) }));
        return { name, n: hits.length, first: hits[0] ? { at: hits[0].at, inExcerpt: hits[0].at < EXCERPT_CHARS, inObservations: obs.includes(hits[0].s.slice(0, 8)), s: hits[0].s } : null };
      }).filter((x) => x.n > 0);
      const unitField = p ? (p.fields as Record<string, { value: string | null; basis: string; quote: string | null }>).apply_unit : undefined;
      const row = {
        key,
        stage1_input: { textChars: post.text.length, linkMap: post.linkMap?.length ?? 0, urlStatus: key.startsWith("lp/") ? "url_from_item" : "short_unexpanded", storedPageChars: (c.last_good as { evidence?: { linkedPages?: { text: string }[] } })?.evidence?.linkedPages?.[0]?.text.length ?? 0 },
        stage2_aiSaw: { hasPageEvidence: !!pageEv, cleanedTextChars: fullText.length, excerptChars: exc.length, truncated: fullText.length > EXCERPT_CHARS, observationLines: obs ? obs.split("\n").length : 0, slots: structure?.slots.length ?? null, pageNotes: structure?.pageNotes ?? [], judgeInputChars: rendered.length },
        stage3_unitPhrases: phr,
        stage4_aiJudgment: { decision: p?.decision, unitField: unitField ?? null, applyUnit: p?.apply_unit, basis: p?.apply_unit_basis },
        stage5_verification: { verified: p?.verified, held: p?.held_reasons, end: p?.end_reason, turns: p?.turns },
      };
      rows.push(row);
      md.push(`## ${key}`, "```json", JSON.stringify(row, null, 1), "```", "");
    }
    writeFileSync("eval/real-data/p2-trace.md", md.join("\n"));
    writeFileSync("eval/real-data/p2-trace.json", JSON.stringify(rows, null, 1));
    console.log("P2TRACE", rows.length);
    expect(rows.length).toBe(15);
  }, 120_000);
});
