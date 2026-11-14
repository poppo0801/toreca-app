/**
 * 適応型の調査方針（Stage 9D）。実APIを使わずに、「調査対象を自分で選び、取得結果を見て次の調査を決める」流れを実際のツールで動かすための方針。
 * 実際のAIモデルの判断力の評価ではない（実APIでの評価は、費用と条件を報告して利用者が承認したあとに行う）。AgentLLM と同じ入口なので、実AIと差し替えられる。
 *
 * 判断の材料（毎回、これまでのツールの結果から決める。固定の手順ではない）:
 *   対象の選択: 日時などが不足している登録済みの抽選（重要度が高い）→ 未監視の系列の公式サイト → 失敗した情報源。前回までに取得制限・失敗が続いた情報源は避ける
 *   取得後: 抽選として解析 → 不足があれば、ページ内の関連リンク（応募・抽選・詳細）を1回だけ追跡して再解析（追加調査）
 *           → 重複・追加調査の判定なら登録済みの抽選と照合 → 未監視の系列の公式サイトは情報源として評価し、公式サイトからリンクされた公式アカウントも評価
 *   調べても分からない項目は、不明のまま提出する（推測しない）
 */
import type { AgentLLM, AgentMessage, LlmStep, ToolCall } from "@/lib/agent/core";
import type { Finding, InvestigationSignals, PlannedTask, PlanOutput, TaskKind } from "@/lib/agent/collection-planner/types";

const usage = { inputTokens: 800, outputTokens: 200, costJpy: 0 };
const LINK_HINT = /応募|抽選|詳細|お知らせ|ニュース|予約|エントリー/;
const SOCIAL = /(^|\.)(x\.com|twitter\.com)$/i;
const MAX_TARGETS = 3;

interface Done {
  call: ToolCall;
  content: string;
  failed: boolean;
}
function done(messages: AgentMessage[]): Done[] {
  const calls = new Map<string, ToolCall>();
  for (const m of messages) if (m.role === "assistant") for (const c of m.calls) calls.set(c.id, c);
  const out: Done[] = [];
  for (const m of messages) {
    if (m.role !== "tool") continue;
    const call = calls.get(m.callId);
    if (call) out.push({ call, content: m.content, failed: !!m.isError || /^取得できません|^エラー/.test(m.content) });
  }
  return out;
}
const hostOf = (u: string): string => {
  try {
    return new URL(u).hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return "";
  }
};
function linksOf(content: string): { url: string; text: string }[] {
  const out: { url: string; text: string }[] = [];
  for (const line of content.split("\n")) {
    const m = line.match(/^- (.*?) (https?:\/\/\S+)$/);
    if (m) out.push({ text: m[1], url: m[2] });
  }
  return out;
}
interface PreviewJson {
  recognized: boolean;
  chain: string;
  products: string[];
  missing: string[];
  disposition: { kind: string };
}

interface Target {
  kind: TaskKind;
  id: string;
  url: string;
  chainId?: string;
  reason: string;
}

export function selectTargets(s: InvestigationSignals & { previousRuns?: { host: string; attempts: number; failures: number; lastFailKind?: string }[] }): Target[] {
  const avoid = new Set((s.previous ?? s.previousRuns ?? []).filter((p) => p.failures >= 2 || p.lastFailKind === "robots").map((p) => p.host));
  const ok = (u: string) => !!u && /^https:\/\//.test(u) && !avoid.has(hostOf(u)) && !SOCIAL.test(hostOf(u));
  const t: Target[] = [];
  // 重要度: 登録済みの抽選の不足を補える調査 > 新しい情報源の発見 > 失敗した情報源の再確認
  for (const m of s.missing) if (ok(m.sourceUrl)) t.push({ kind: "missing_info", id: m.lotteryId, url: m.sourceUrl, reason: `${m.chainName} ${m.storeName}の抽選で不足（${m.missing.slice(0, 2).join("・")}）を、情報源で確認する` });
  for (const c of s.chains.filter((c) => !c.monitored)) if (c.officialUrl && ok(c.officialUrl)) t.push({ kind: "unmonitored_chain", id: c.id, url: c.officialUrl, chainId: c.id, reason: `未監視の系列「${c.name}」の公式サイトを確認し、情報源として評価する` });
  for (const f of s.failed) if (ok(f.url) && f.failKind !== "robots") t.push({ kind: "failed_source", id: f.sourceId, url: f.url, reason: `取得に失敗している情報源「${f.name}」を再確認する` });
  const seen = new Set<string>();
  return t.filter((x) => (seen.has(x.url) ? false : (seen.add(x.url), true))).slice(0, MAX_TARGETS);
}

export class AdaptiveScoutBrain implements AgentLLM {
  readonly name = "adaptive-scout";

  async step({ messages, tools }: { system: string; messages: AgentMessage[]; tools: { name: string }[] }): Promise<LlmStep> {
    const has = (n: string) => tools.some((t) => t.name === n);
    const calls = (cs: Omit<ToolCall, "id">[]): LlmStep => ({ kind: "tool_calls", calls: cs.map((c, i) => ({ ...c, id: `a${messages.length}-${i}` })), usage });
    const h = done(messages);
    const sigRes = h.find((x) => x.call.name === "get_signals");
    if (!sigRes) return calls([{ name: "get_signals", input: { purpose: "調査の手がかりを読み、調べる対象を選ぶ" } }]);
    const sig = JSON.parse(sigRes.content) as InvestigationSignals & { unmonitoredChains: InvestigationSignals["chains"]; missingInfo: InvestigationSignals["missing"]; failedSources: InvestigationSignals["failed"]; previousRuns?: { host: string; attempts: number; failures: number; lastFailKind?: string }[] };
    // get_signals の出力は絞った形のため、対象の選択に必要な形に戻す
    const view: InvestigationSignals = { ...sig, chains: sig.unmonitoredChains ?? [], missing: sig.missingInfo ?? [], failed: sig.failedSources ?? [], previous: sig.previousRuns as InvestigationSignals["previous"] };
    const targets = selectTargets(view);
    const find = (name: string, url: string) => h.find((x) => x.call.name === name && String(x.call.input.url ?? "") === url);
    const preview = (url: string): PreviewJson | null => {
      const r = find("analyze_page_for_lottery", url);
      if (!r || r.failed) return null;
      try {
        return JSON.parse(r.content) as PreviewJson;
      } catch {
        return null;
      }
    };

    const findings: Finding[] = [];
    const tasks: PlannedTask[] = [];
    for (const t of targets) {
      const root = find("check_official_site", t.url);
      if (!root) return calls([{ name: "check_official_site", input: { url: t.url, purpose: t.reason } }]);
      tasks.push({ kind: t.kind, targetId: t.id, url: t.url, tool: "check_official_site", reason: t.reason });
      if (root.failed) {
        findings.push({ kind: "stop_retry", targetId: t.id, title: `${hostOf(t.url)}は取得できないため再試行しない`, url: t.url, evidence: root.content.slice(0, 120), official: false });
        continue;
      }
      const links = linksOf(root.content);
      if (has("analyze_page_for_lottery") && !find("analyze_page_for_lottery", t.url)) return calls([{ name: "analyze_page_for_lottery", input: { url: t.url, purpose: "取得したページを抽選情報として解析する" } }]);
      const p = preview(t.url);
      // 追加調査: 不足がある・抽選と認識できないときは、関連リンクを1回だけ追跡して再解析する
      if (p && (p.missing.length > 0 || !p.recognized)) {
        const link = links.find((l) => LINK_HINT.test(l.text) && !SOCIAL.test(hostOf(l.url)) && /^https:\/\//.test(l.url) && l.url.replace(/#.*$/, "") !== t.url);
        if (link) {
          const f = find("follow_external_link", link.url);
          if (!f) return calls([{ name: "follow_external_link", input: { url: link.url, purpose: `不足している項目（${p.missing.slice(0, 3).join("・") || "抽選の記載"}）を、関連ページで確認する` } }]);
          if (!f.failed && has("analyze_page_for_lottery") && !find("analyze_page_for_lottery", link.url)) return calls([{ name: "analyze_page_for_lottery", input: { url: link.url, purpose: "追跡したページを抽選情報として解析する" } }]);
        }
      }
      // 重複・追加調査の疑い: 登録済みの抽選と照合
      if (p && p.recognized && ["investigate", "duplicate"].includes(p.disposition.kind) && !h.some((x) => x.call.name === "match_existing_lotteries" && x.call.input.url === t.url))
        return calls([{ name: "match_existing_lotteries", input: { chainName: p.chain, productName: p.products[0] ?? "", url: t.url, purpose: "登録済みの抽選と同じものか照合する" } }]);
      // 新しい情報源の評価（未監視の系列）: 公式サイト自体と、公式サイトからリンクされたXアカウント
      if (t.kind === "unmonitored_chain") {
        if (has("assess_source_candidate") && !h.some((x) => x.call.name === "assess_source_candidate" && x.call.input.url === t.url)) return calls([{ name: "assess_source_candidate", input: { url: t.url, chainId: t.chainId, purpose: "公式サイトを監視候補として評価する" } }]);
        const x = links.find((l) => SOCIAL.test(hostOf(l.url)));
        if (x && has("assess_source_candidate") && !h.some((y) => y.call.name === "assess_source_candidate" && y.call.input.url === x.url)) return calls([{ name: "assess_source_candidate", input: { url: x.url, chainId: t.chainId, linkedFromUrl: t.url, purpose: "公式サイトからリンクされたアカウントを評価する" } }]);
      }
      // 提出に載せる発見（取得した根拠だけ）
      if (p?.recognized) findings.push({ kind: "lottery_info", targetId: t.id, title: `${p.chain} ${p.products.join("・")}`.trim() || "抽選の告知", url: t.url, evidence: `解析: ${p.disposition.kind}${p.missing.length ? `／不足: ${p.missing.join("・")}（不明のまま保持）` : ""}`, official: true });
    }
    for (const x of h.filter((y) => y.call.name === "assess_source_candidate" && !y.failed)) {
      const ev = JSON.parse(x.content) as { recommend: string; reason: string; evidence: string[] };
      if (ev.recommend !== "reject") findings.push({ kind: "monitor_candidate", targetId: String(x.call.input.chainId ?? ""), title: `情報源の候補: ${hostOf(String(x.call.input.url))}`, url: String(x.call.input.url), evidence: ev.evidence.join("／") || ev.reason, official: ev.recommend === "auto_add" });
    }
    const out: PlanOutput = { tasks, findings, summary: targets.length ? `${targets.length}件を調査。${findings.length}件の発見を提出（不明な項目は不明のまま）` : "調査すべき対象が見つかりませんでした" };
    return { kind: "final", output: out, usage };
  }
}
