/**
 * モック（Stage 9C）: 実APIを使わずに、収集エージェントの一連の動作と、検証層・制限の安全性を確認するための疑似AI。
 * 実際のAIの判断力の評価ではない（実APIでの評価は、費用と条件を報告して利用者が承認したあとに行う）。
 *   scout   : 手がかりを読み、未監視の系列の公式サイトを確認し、リンクを追跡し、登録済みの抽選と照合してから、根拠つきで提出する
 *   reckless: 取得していないURLを根拠にした発見・存在しない対象・根拠のない発見を提出し、内部アドレスの取得も試みる（検証層・制限の試験用）
 *   looper  : 同じURLを繰り返し取得しようとする（重複・上限の試験用）
 *   silent  : 何も調べずに空で提出する
 */
import type { AgentLLM, AgentMessage, LlmStep, ToolCall } from "@/lib/agent/core";
import type { InvestigationSignals, PlanOutput } from "@/lib/agent/collection-planner/types";

export type PlannerPolicy = "scout" | "reckless" | "looper" | "silent";
const usage = { inputTokens: 600, outputTokens: 150, costJpy: 0 };

function results(messages: AgentMessage[], name: string): { call: ToolCall; content: string; isError: boolean }[] {
  const calls = new Map<string, ToolCall>();
  for (const m of messages) if (m.role === "assistant") for (const c of m.calls) calls.set(c.id, c);
  return messages.filter((m): m is Extract<AgentMessage, { role: "tool" }> => m.role === "tool" && m.name === name).map((m) => ({ call: calls.get(m.callId) as ToolCall, content: m.content, isError: !!m.isError })).filter((x) => !!x.call);
}
const unwrap = (s: string): string => s.replace(/<\/?untrusted_web_content[^>]*>/g, "");

export class MockPlannerBrain implements AgentLLM {
  readonly name: string;
  constructor(private readonly policy: PlannerPolicy) {
    this.name = `mock-planner:${policy}`;
  }

  async step({ messages }: { system: string; messages: AgentMessage[]; tools: unknown[] }): Promise<LlmStep> {
    const calls = (cs: Omit<ToolCall, "id">[]): LlmStep => ({ kind: "tool_calls", calls: cs.map((c, i) => ({ ...c, id: `c${messages.length}-${i}` })), usage });
    const final = (output: PlanOutput): LlmStep => ({ kind: "final", output, usage });
    if (this.policy === "silent") return final({ tasks: [], findings: [], summary: "調査しませんでした" });
    if (this.policy === "looper") return calls([{ name: "check_official_site", input: { url: "https://shop.example.invalid/news" } }]);

    const sig = results(messages, "get_signals").at(-1);
    if (!sig) return calls([{ name: "get_signals", input: {} }]);
    const s = JSON.parse(sig.content) as { unmonitoredChains: InvestigationSignals["chains"]; failedSources: InvestigationSignals["failed"]; missingInfo: InvestigationSignals["missing"] };

    if (this.policy === "reckless") {
      const asked = results(messages, "check_official_site");
      if (asked.length === 0) return calls([{ name: "check_official_site", input: { url: "http://127.0.0.1:54321/rest/v1/chains" } }]);
      return final({
        tasks: [{ kind: "unmonitored_chain", targetId: "no-such-chain", tool: "check_official_site", reason: "存在しない対象" }],
        findings: [
          { kind: "monitor_candidate", targetId: "x", title: "根拠なし", url: "https://never-fetched.example.invalid/a", evidence: "取得していないページ", official: true },
          { kind: "lottery_info", targetId: "y", title: "根拠が空", url: "https://shop.example.invalid/x", evidence: "", official: false },
        ],
        summary: "不正な提出",
      });
    }

    // scout
    const target = [...s.unmonitoredChains].filter((c) => c.officialUrl).sort((a, b) => b.storeCount + b.lotteries30d * 3 - (a.storeCount + a.lotteries30d * 3))[0];
    const official = results(messages, "check_official_site");
    if (target && official.length === 0) return calls([{ name: "check_official_site", input: { url: target.officialUrl } }]);
    const page = official.at(-1);
    const follow = results(messages, "follow_external_link");
    if (page && !page.isError && follow.length === 0) {
      const link = /- [^\n]*(抽選|応募|lottery)[^\n]* (https?:\/\/\S+)/i.exec(unwrap(page.content));
      if (link) return calls([{ name: "follow_external_link", input: { url: link[2] } }]);
    }
    const matched = results(messages, "match_existing_lotteries");
    if (target && matched.length === 0) return calls([{ name: "match_existing_lotteries", input: { chainName: target.name } }]);

    const tasks: PlanOutput["tasks"] = [];
    const findings: PlanOutput["findings"] = [];
    if (target) {
      tasks.push({ kind: "unmonitored_chain", targetId: target.id, url: target.officialUrl, tool: "check_official_site", reason: `未監視の系列（店舗${target.storeCount}件・直近の抽選${target.lotteries30d}件）の公式サイトを確認` });
      const f = follow.at(-1);
      if (page && !page.isError) findings.push({ kind: "source_url", targetId: target.id, title: `${target.name}の告知ページ`, url: target.officialUrl, evidence: unwrap(page.content).replace(/\s+/g, " ").slice(0, 120), official: true });
      if (f && !f.isError) findings.push({ kind: "lottery_info", targetId: target.id, title: `${target.name}の抽選の応募ページ`, url: String(f.call.input.url), evidence: unwrap(f.content).replace(/\s+/g, " ").slice(0, 120), official: true });
    }
    for (const fs of s.failedSources.slice(0, 2)) {
      if (["robots", "blocked", "js_render", "not_found"].includes(fs.failKind)) {
        tasks.push({ kind: "failed_source", targetId: fs.sourceId, tool: "get_signals", reason: "取得制限のため回避せず再試行をやめる" });
        findings.push({ kind: "stop_retry", targetId: fs.sourceId, title: `${fs.name}の取得を諦める`, evidence: `取得できない理由: ${fs.failKind}`, official: false });
      }
    }
    for (const m of s.missingInfo.slice(0, 2)) tasks.push({ kind: "missing_info", targetId: m.lotteryId, tool: "check_official_site", reason: `不足: ${m.missing.join("・")}` });
    return final({ tasks, findings, summary: `${tasks.length}件の調査を選び、${findings.length}件の発見を提出` });
  }
}
