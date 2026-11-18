/**
 * モック（Stage 8F）: 実APIを使わずに、エージェントの一連の動作と、検証層の安全性を確認するための疑似AI。
 * 実際のAIの判断力の評価ではない（実APIでの評価は、費用と条件を報告して利用者が承認したあとに行う）。
 *
 * 方針（policy）:
 *  - careful: 慎重。候補の「一致・相違」がすべて same のものだけをまとめる。情報源の文章から共通の企画名（『』の中）を探して示す。
 *  - eager  : 過剰にまとめたがる悪いAI。相違があっても、同じ系列の候補を全部まとめ、「共通」と主張し、自信を99と申告する（検証層が止められるかの試験用）。
 *  - liar   : careful と同じ判断だが、実在しない共通の企画名を示す（文言の検証の試験用）。
 *  - lazy   : 最初は情報源の文章を読まずに提出する。検証から「文言を確認できない」と返されたら、読み直して再提出する（追加調査の試験用）。
 *  - timid  : 常に「単独」（誤ってまとめない代わりに、取りこぼす）。
 */
import type { AgentLLM, AgentMessage, LlmStep, ToolCall } from "@/lib/agent/core";

export type BrainPolicy = "careful" | "eager" | "liar" | "lazy" | "timid";

interface Related {
  id: string;
  groupId: string | null;
  groupOrigin: string | null;
  relations: Record<string, string>;
}
const usage = { inputTokens: 800, outputTokens: 200, costJpy: 0 };

function toolResults(messages: AgentMessage[], name: string): { call: ToolCall; content: string }[] {
  const calls = new Map<string, ToolCall>();
  for (const m of messages) if (m.role === "assistant") for (const c of m.calls) calls.set(c.id, c);
  return messages
    .filter((m): m is Extract<AgentMessage, { role: "tool" }> => m.role === "tool" && m.name === name && !m.isError)
    .map((m) => ({ call: calls.get(m.callId)!, content: m.content }))
    .filter((x) => !!x.call);
}
const ALL_SAME = ["products", "quantity", "applyStart", "applyDeadline", "resultDate", "applyMethod", "receiveMethod", "requirements", "storeMode"];
const unwrap = (s: string): string => s.replace(/<\/?untrusted_web_content[^>]*>/g, "");
/** 情報源の文章から、企画名らしき『…』の中の文言を取り出す */
export const titleOf = (text: string): string | null => /『([^』]{4,80})』/.exec(text)?.[1] ?? null;

export class MockGroupingBrain implements AgentLLM {
  readonly name: string;
  constructor(private readonly policy: BrainPolicy) {
    this.name = `mock-grouping:${policy}`;
  }

  async step({ messages }: { system: string; messages: AgentMessage[]; tools: unknown[] }): Promise<LlmStep> {
    const calls = (cs: Omit<ToolCall, "id">[]): LlmStep => ({ kind: "tool_calls", calls: cs.map((c, i) => ({ ...c, id: `c${messages.length}-${i}` })), usage });
    const final = (output: Record<string, unknown>): LlmStep => ({ kind: "final", output, usage });
    const listed = toolResults(messages, "list_related_lotteries").at(-1);
    if (!listed) return calls([{ name: "get_subject", input: {} }, { name: "list_related_lotteries", input: {} }]);
    const data = JSON.parse(listed.content) as { lotteries: Related[] };
    const subjectText = toolResults(messages, "get_subject").at(-1)?.content ?? "{}";
    const subjectId = (JSON.parse(subjectText) as { id: string }).id;
    if (this.policy === "timid") return final({ action: "single", rationale: "慎重のため、まとめない" });

    // 候補
    const rel = data.lotteries;
    // 8F-5: まとめる対象は、系列・商品・期間・方法・条件・方式がすべて一致する別店舗の抽選（キャンペーン・イベントIDは問わない）
    const same = rel.filter((r) => ALL_SAME.every((k) => r.relations[k] === "same"));
    const picked = this.policy === "eager" ? rel : same;
    const groups = [...new Set(picked.map((r) => r.groupId).filter((g): g is string => !!g))];
    const ungrouped = picked.filter((r) => !r.groupId);

    const texts = new Map<string, string>();
    for (const r of toolResults(messages, "get_source_text")) texts.set(String(r.call.input.id), unwrap(r.content));
    const wantTexts = ["careful", "liar", "lazy"].includes(this.policy) && picked.length > 0;
    const feedback = messages.some((m) => m.role === "tool" && m.name === "submit_findings" && m.content.startsWith("検証結果"));
    const needRead = wantTexts && (this.policy !== "lazy" || feedback);
    if (needRead) {
      const need = [subjectId, ...picked.map((r) => r.id)].filter((id) => !texts.has(id)).slice(0, 8);
      if (need.length > 0) return calls(need.map((id) => ({ name: "get_source_text", input: { id } })));
    }

    if (picked.length === 0) return final({ action: "single", rationale: "同じ企画と言える一致する抽選が見つからなかった", claimedDiffers: rel.length > 0 ? ["応募期間", "対象商品", "応募条件"] : [] });

    let phrase: string | null = null;
    if (this.policy === "liar") phrase = "全国一斉 トレーディングカード大抽選会2099";
    else if (needRead || this.policy === "eager") {
      const t = titleOf(texts.get(subjectId) ?? "");
      if (t && picked.every((r) => !texts.has(r.id) || (texts.get(r.id) ?? "").includes(t))) phrase = t;
    }
    const claimedCommon = this.policy === "eager" ? ["対象商品", "応募期間", "発表日", "応募方法", "応募条件"] : ["対象商品", "応募期間", "発表日", "応募方法"];
    const base = { claimedCommon, commonPhrase: phrase, selfConfidence: this.policy === "eager" ? 99 : 80 };
    if (groups.length === 1 && ungrouped.length === 0) {
      return final({ ...base, action: "add_to_group", groupId: groups[0], memberIds: picked.map((r) => r.id), rationale: "既存のグループと、商品・期間・条件が同じ" });
    }
    if (groups.length >= 1 && this.policy === "eager") {
      return final({ ...base, action: "add_to_group", groupId: groups[0], memberIds: picked.map((r) => r.id), rationale: "同じ系列の抽選なので、既存のグループにまとめる" });
    }
    return final({ ...base, action: "new_group", memberIds: ungrouped.map((r) => r.id), rationale: this.policy === "eager" ? "同じ系列で商品が重なるため、まとめる" : "商品・期間・発表日・応募方法・条件が同じ別店舗の抽選" });
  }
}
