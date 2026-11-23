/**
 * 台本つきの擬似 Anthropic クライアント（**テスト専用・費用0・ネットワークなし**）。実AIの通し経路（real-run.ts）を、実際のAPIを呼ばずに検証するための代役。
 * 調査AI（submit_research_turn）と登録判断（submit_registration_judgment）のツール呼び出しに、台本どおりに応答し、使用トークン（費用の計上に使う）を返す。
 * 失敗の注入（HTTPエラー・出力の不備）に対応する。実AIの判断の質を表すものではない（精度の根拠にしない）。このファイルを import してよいのはテストだけ（静的テスト）。
 */
export interface ScriptedOptions {
  /** 呼び出しごとの使用トークン（既定: 入力3000・出力500） */
  usage?: { input_tokens: number; output_tokens: number };
  /** n回目（1始まり）の呼び出しで、HTTPエラー（status）を投げる。例: { 3: 429 } */
  failAt?: Record<number, number>;
  /** すべての呼び出しで投げるHTTPエラー */
  failAll?: number;
  /** 登録判断の出力を不備にする（tool_use が無い） */
  badJudge?: boolean;
  /** 登録判断の decision を、判断の呼び出し順に指定（例: ["register", "tentative"]＝1回目は本登録案・再評価で暫定）。無ければ tentative */
  judgeDecisions?: string[];
  /** 登録判断の fields を省略する（P2 で起きた出力） */
  omitFields?: boolean;
  /** 登録判断の応募単位の値（basis=inferred）。無ければ unknown */
  judgeUnit?: string;
  /** 調査AIが最初に選ぶ行動を上書き（既定: 項目自身のリンクがあれば取得、なければ停止） */
  agentPlan?: (excerpt: string, history: number) => { kind: "fetch"; url: string } | { kind: "search"; query: string } | { kind: "stop" };
}

type Req = { tools?: { name: string }[]; messages?: { content: unknown }[] };

export function scriptedAnthropic(opts: ScriptedOptions = {}): { client: { messages: { create: (req: Req, o?: unknown) => Promise<unknown> } }; calls: { kind: string; n: number }[] } {
  const calls: { kind: string; n: number }[] = [];
  let n = 0;
  let judgeCalls = 0;
  const usage = opts.usage ?? { input_tokens: 3000, output_tokens: 500 };
  const text = (req: Req): string => String((req.messages?.[0] as { content?: unknown } | undefined)?.content ?? "");
  const create = async (req: Req): Promise<unknown> => {
    n++;
    const name = req.tools?.[0]?.name ?? "";
    calls.push({ kind: name, n });
    const status = opts.failAll ?? opts.failAt?.[n];
    if (status) throw Object.assign(new Error("scripted failure"), { status });
    const t = text(req);
    if (name === "submit_research_turn") {
      const own = /この項目自身のリンク: (https:\/\/\S+)/.exec(t)?.[1];
      const history = (t.match(/: ok(?:（新しい情報あり）)?$/gm) ?? []).length;
      const plan = opts.agentPlan ? opts.agentPlan(t, history) : own && history === 0 ? ({ kind: "fetch", url: own } as const) : ({ kind: "stop" } as const);
      const next = plan.kind === "fetch" ? { kind: "fetch", url: plan.url, why: "台本" } : plan.kind === "search" ? { kind: "search", query: plan.query, why: "台本" } : { kind: "stop", reason: history ? "sufficient" : "no_progress", why: "台本" };
      return { stop_reason: "tool_use", content: [{ type: "tool_use", id: `tu${n}`, name, input: { observed: [], inferred: [], unknown: [], counterHypotheses: [], next } }], usage };
    }
    if (name === "submit_registration_judgment") {
      judgeCalls++;
      const decision = opts.judgeDecisions?.[Math.min(judgeCalls, opts.judgeDecisions.length) - 1] ?? "tentative";
      if (opts.omitFields) return { stop_reason: "tool_use", content: [{ type: "tool_use", id: `tu${n}`, name, input: { decision, rationale: "台本（fields省略）", unresolvedImpact: "material", monitor: { continue: true, why: "台本" } } }], usage };
      if (opts.badJudge) return { stop_reason: "end_turn", content: [{ type: "text", text: "出力不備" }], usage };
      // 取得したページの先頭の行（【店舗】商品）から項目を作る。引用は原文の抜粋にそのまま存在する文字列だけ
      const line = /【証拠 (p\d+)】[^\n]*\n観察: [^\n]*\n原文の抜粋: ([^\n]*)/.exec(t);
      const id = line?.[1];
      const first = (line?.[2] ?? "").trim();
      const store = /【([^】]{2,40})】/.exec(first)?.[1];
      const fields: Record<string, unknown> = {
        store: id && store ? { value: store, basis: "observed", evidenceId: id, quote: `【${store}】` } : { value: null, basis: "unknown" },
        product: id && first.length >= 8 ? { value: first.replace(/^【[^】]*】/, "").slice(0, 80), basis: "observed", evidenceId: id, quote: first.slice(0, 120) } : { value: null, basis: "unknown" },
        deadline: { value: null, basis: "unknown" },
        apply_unit: opts.judgeUnit ? { value: opts.judgeUnit, basis: "inferred" } : { value: null, basis: "unknown" },
      };
      // 人が確定した値が渡されているときは、その値をそのまま使う（変更しない）
      for (const m of t.matchAll(/^- ([a-z_]+): (.+)$/gm)) fields[m[1]] = { value: m[2], basis: "inferred" };
      return { stop_reason: "tool_use", content: [{ type: "tool_use", id: `tu${n}`, name, input: { decision, fields, rationale: "台本", unresolvedImpact: "minor", monitor: { continue: true, why: "台本" } } }], usage };
    }
    return { stop_reason: "end_turn", content: [], usage };
  };
  return { client: { messages: { create } }, calls };
}
