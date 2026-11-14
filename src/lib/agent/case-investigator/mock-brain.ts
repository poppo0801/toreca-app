/**
 * 案件調査のモックAI（Stage 9H-1）。実APIを使わずに、エンジン・ツール・検証層・上限の動作を確認するための疑似AI。実際のAIの判断力の評価ではない
 * （実AIでの評価は9H-2。費用と条件を報告して利用者が承認したあとに行う）。AgentLLM と同じ入口なので、実AIと差し替えられる。
 *   adaptive: 状況を読み、登録済みの情報源を確認 → 取得できなければ検索語を自分で作り、検索結果から有望なページを選んで取得 → 不足項目・矛盾に合わせて検索語を変える → 十分なら終了
 *   greedy  : 状況にかかわらず、取得・検索できるだけ続ける（調査量の方針・上限の試験用）
 *   looper  : 同じ検索語・同じURLを繰り返す（重複の拒否・無限ループ防止の試験用）
 *   reckless: 登録・検索結果・リンクにないURLの取得、個人情報を含む検索語、根拠のない報告、早すぎる「十分」の申告を試みる（検証層の試験用）
 * 判断は、これまでのツールの結果（会話）だけから決める。固定の巡回手順やサイト別のルールは持たない。
 */
import type { AgentLLM, AgentMessage, LlmStep, ToolCall } from "@/lib/agent/core";
import type { CaseFinish } from "./engine";

export type InvestigatorPolicy = "adaptive" | "greedy" | "looper" | "reckless";
const usage = { inputTokens: 700, outputTokens: 180, costJpy: 0 };

interface Res {
  call: ToolCall;
  content: string;
  isError: boolean;
}
function results(messages: AgentMessage[], name: string): Res[] {
  const calls = new Map<string, ToolCall>();
  for (const m of messages) if (m.role === "assistant") for (const c of m.calls) calls.set(c.id, c);
  return messages.filter((m): m is Extract<AgentMessage, { role: "tool" }> => m.role === "tool" && m.name === name).map((m) => ({ call: calls.get(m.callId) as ToolCall, content: m.content, isError: !!m.isError })).filter((x) => !!x.call);
}
const failed = (r: { isError: boolean; content: string }): boolean => r.isError || /^取得できません|^エラー/.test(r.content);
const unwrap = (s: string): string => s.replace(/<\/?untrusted_web_content[^>]*>/g, "");
const json = <T,>(s: string): T | null => {
  try {
    return JSON.parse(s) as T;
  } catch {
    return null;
  }
};
const norm = (u: string) => u.trim().replace(/#.*$/, "");

interface StateView {
  target?: { chain: string; products: string[] };
  registeredSources?: { url: string; kind: string }[];
  situation: string;
  done: boolean;
  policy: { fetchesLeft: number; searchesLeft: number };
  missing: string[];
  conflicts: string[];
}

/** ページの本文（「ラベル: 値」の行）から、項目の報告を作る（疑似的な読み取り。実AIの代わり） */
export function mockExtract(text: string): { identity: Record<string, unknown>; observations: { field: string; value: string; quote: string }[] } {
  const lines = unwrap(text).split(/\n+/).map((l) => l.trim());
  const get = (label: string) => lines.find((l) => l.startsWith(`${label}:`) || l.startsWith(`${label}：`));
  const val = (l?: string) => (l ? l.replace(/^[^:：]+[:：]\s*/, "").trim() : "");
  const map: [string, string][] = [["商品", "items"], ["店舗", "store"], ["応募開始", "applyStart"], ["応募締切", "applyDeadline"], ["当選発表", "resultDate"], ["応募方法", "applyMethod"], ["応募条件", "conditions"]];
  const obs = map.flatMap(([label, field]) => {
    const l = get(label);
    return l && val(l) ? [{ field, value: val(l), quote: l }] : [];
  });
  const products = val(get("商品")).split(" / ").map((s) => s.trim()).filter(Boolean);
  const store = val(get("店舗"));
  return { identity: { chain: val(get("系列")), store: store && !/選択/.test(store) ? store : undefined, storeSelect: /選択/.test(store) || undefined, products, applyStart: val(get("応募開始")) || undefined, applyDeadline: val(get("応募締切")) || undefined }, observations: obs };
}

export class InvestigatorMockBrain implements AgentLLM {
  readonly name: string;
  constructor(private readonly policy: InvestigatorPolicy = "adaptive") {
    this.name = `mock-investigator:${policy}`;
  }

  async step({ messages }: { system: string; messages: AgentMessage[]; tools: { name: string }[] }): Promise<LlmStep> {
    const calls = (cs: Omit<ToolCall, "id">[]): LlmStep => ({ kind: "tool_calls", calls: cs.map((c, i) => ({ ...c, id: `c${messages.length}-${i}` })), usage });
    const final = (f: CaseFinish): LlmStep => ({ kind: "final", output: f, usage });
    const stateRes = results(messages, "get_case_state");
    if (this.policy === "looper") return calls([{ name: "search_public_web", input: { query: "同じ検索語" } }, { name: "fetch_source_page", input: { url: "https://shop.example.invalid/a" } }]);
    if (this.policy === "reckless") {
      const tried = results(messages, "fetch_source_page").length + results(messages, "search_public_web").length;
      if (tried === 0) return calls([{ name: "fetch_source_page", input: { url: "https://unlisted.example.invalid/secret" } }, { name: "search_public_web", input: { query: "山田太郎 090-1234-5678 yamada@example.com 抽選" } }, { name: "fetch_source_page", input: { url: "http://127.0.0.1:54321/rest/v1/chains" } }]);
      return final({ reason: "sufficient", note: "確認できました（根拠なし）" });
    }
    if (!stateRes.length) return calls([{ name: "get_case_state", input: { purpose: "調査状況と方針を読む" } }]);

    const first = json<StateView>(stateRes[0].content);
    // 最新の状況: 取得・報告の後に、get_case_state の結果か report_page_findings の結果のどちらか新しい方
    const reports = results(messages, "report_page_findings");
    const latest = [...stateRes, ...reports].map((r) => ({ r, s: json<StateView>(r.content) })).filter((x): x is { r: Res; s: StateView } => !!x.s && typeof x.s.situation === "string").at(-1)?.s ?? first;
    if (!first || !latest) return final({ reason: "cannot_continue", note: "状況を読めませんでした" });
    const target = first.target as { chain: string; products: string[] };
    const fetches = results(messages, "fetch_source_page");
    const fetchedUrls = new Set(fetches.map((f) => norm(String(f.call.input.url))));
    const reportedUrls = new Set(reports.map((r) => norm(String(r.call.input.url))));
    const searches = results(messages, "search_public_web");
    const queriesUsed = new Set(searches.map((s) => String(s.call.input.query)));

    // 0) 取得に失敗した直後は、状況（公式情報が取得不能など）が変わっているので、調査方針を読み直す
    const idxOf = (name: string, pred: (m: Extract<AgentMessage, { role: "tool" }>) => boolean = () => true) => messages.map((m, i) => (m.role === "tool" && m.name === name && pred(m) ? i : -1)).reduce((a, b) => Math.max(a, b), -1);
    if (idxOf("fetch_source_page", (m) => !!m.isError || /^取得できません/.test(m.content)) > idxOf("get_case_state") && idxOf("fetch_source_page", (m) => !!m.isError || /^取得できません/.test(m.content)) > idxOf("report_page_findings")) return calls([{ name: "get_case_state", input: { purpose: "取得失敗後に、状況と調査方針を読み直す" } }]);
    // 1) 取得できたページは、まず内容を報告する
    for (const f of fetches) {
      const u = norm(String(f.call.input.url));
      if (!failed(f) && !reportedUrls.has(u)) {
        const x = mockExtract(f.content);
        return calls([{ name: "report_page_findings", input: { url: u, identity: x.identity, observations: x.observations, purpose: "取得したページの内容を報告する" } }]);
      }
    }
    if (this.policy === "adaptive" && latest.done) return final({ reason: "sufficient", note: "必要な項目が確認できました" });
    const fetchesLeft = latest.policy.fetchesLeft;
    const searchesLeft = latest.policy.searchesLeft;

    // 2) 登録済みの情報源のうち、まだ試していないもの
    const untried = (first.registeredSources ?? []).filter((s) => !fetchedUrls.has(norm(s.url)));
    if (untried.length && fetchesLeft > 0) return calls([{ name: "fetch_source_page", input: { url: untried[0].url, purpose: "登録済みの情報源を確認する" } }]);

    // 3) 検索結果から有望なページを選ぶ（取得済み・失敗したサイトを除き、系列名・商品名・「公式」を含むものを優先）
    const failedHosts = new Set(fetches.filter((f) => failed(f)).map((f) => hostOf(String(f.call.input.url))));
    const cands: { url: string; score: number }[] = [];
    for (const s of searches) {
      if (failed(s)) continue;
      const blocks = unwrap(s.content).split(/\n\n+/);
      for (const b of blocks) {
        const m = /^(.*?)\s+(https?:\/\/\S+)\n?([\s\S]*)$/.exec(b.trim());
        if (!m) continue;
        const url = norm(m[2]);
        if (fetchedUrls.has(url) || failedHosts.has(hostOf(url))) continue;
        const hay = `${m[1]} ${m[3]}`;
        const score = (hay.includes(target.chain) ? 2 : 0) + (target.products.some((p) => hay.includes(p)) ? 2 : 0) + (/公式/.test(hay) ? 1 : 0) + (/訂正|更新/.test(hay) && latest.conflicts.length ? 2 : 0);
        cands.push({ url, score });
      }
    }
    cands.sort((a, b) => b.score - a.score);
    if (cands.length && cands[0].score > 0 && fetchesLeft > 0) return calls([{ name: "fetch_source_page", input: { url: cands[0].url, purpose: "検索結果から有望な情報源を取得する" } }]);

    // 4) 新しい検索語を作る（不足項目・矛盾・取得失敗に合わせる。使った検索語は繰り返さない）
    if (searchesLeft > 0) {
      const base = `${target.chain} ${target.products[0] ?? ""} 抽選`.replace(/\s+/g, " ").trim();
      const variants = [
        ...(latest.conflicts.length ? [`${base} 訂正 更新 ${latest.conflicts.join(" ")}`] : []),
        ...(latest.missing.length ? [`${base} ${latest.missing.join(" ")}`] : []),
        `${base} 応募 公式`,
        `${base} まとめ`,
      ];
      const q = variants.find((v) => !queriesUsed.has(v));
      if (q) return calls([{ name: "search_public_web", input: { query: q, purpose: "代替の情報源・不足項目を探す" } }]);
    }
    // 5) 打つ手がない: すべて取得に失敗していれば継続不可、そうでなければ改善見込みなし
    const anyOk = fetches.some((f) => !failed(f));
    if (this.policy === "greedy" && (fetchesLeft > 0 || searchesLeft > 0)) {
      const q = `${target.chain} 抽選 ${queriesUsed.size}`;
      return calls([{ name: "search_public_web", input: { query: q, purpose: "調べられるだけ調べる" } }]);
    }
    return final(anyOk || !fetches.length ? { reason: "no_improvement", note: "これ以上調べても改善が見込めません" } : { reason: "cannot_continue", note: "取得できる情報源がありません" });
  }
}

function hostOf(u: string): string {
  try {
    return new URL(u).hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return "";
  }
}
