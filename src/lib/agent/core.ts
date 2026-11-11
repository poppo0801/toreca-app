/**
 * 自律型エージェントの共通基盤（Stage 8D-2）。純粋なロジックのみ（DB・ネットワークに直接触れない）。
 *
 * 設計の要点:
 *  - AI（LLM）は「次に使うツール」を選ぶだけ。ツールは読み取り専用（access が read_* のものだけ登録できる）。
 *    書き込み・SQL・シェル・デプロイ・外部への投稿に当たるツールは登録できない（登録時に例外）。
 *  - 実行回数・検索・取得・トークン・推定費用・時間・再試行に上限があり、到達したら安全に終了する（Budget）。
 *  - 外部の文章（Webページ等）はデータとして扱い、命令として実行しない（wrapUntrusted / detectInjection）。
 *  - AI の出力は SQL やコードとして実行しない。調査結果の保存は、検証済みの専用処理（呼び出し側）だけが行う。
 */

// ---------------------------------------------------------------- 上限
export interface AgentLimits {
  /** LLM への問い合わせ（ステップ）の最大回数 */
  maxSteps: number;
  /** Web検索の最大回数 */
  maxSearches: number;
  /** ページ取得の最大回数 */
  maxFetches: number;
  /** 入力＋出力トークンの合計上限 */
  maxTokens: number;
  /** 推定費用（円）の上限。実際の請求額とは差が出うる推定値 */
  maxCostJpy: number;
  /** 処理時間の上限（ミリ秒） */
  maxMs: number;
  /** LLM の一時的なエラーに対する再試行の最大回数（タスク全体） */
  maxRetries: number;
}

/** 既定の上限（保守的）。呼び出し側で変更できる */
export const DEFAULT_LIMITS: AgentLimits = { maxSteps: 12, maxSearches: 4, maxFetches: 6, maxTokens: 60_000, maxCostJpy: 15, maxMs: 90_000, maxRetries: 2 };

export type LimitKind = "steps" | "searches" | "fetches" | "tokens" | "cost" | "time" | "retries";
export const LIMIT_LABEL: Record<LimitKind, string> = { steps: "実行回数", searches: "Web検索回数", fetches: "ページ取得回数", tokens: "トークン量", cost: "推定費用", time: "処理時間", retries: "再試行回数" };

export interface AgentUsage {
  steps: number;
  searches: number;
  fetches: number;
  inputTokens: number;
  outputTokens: number;
  /** 推定費用（円）。LLM のトークン料金＋検索の概算。請求額ではない */
  costJpy: number;
  ms: number;
  retries: number;
  /** 拒否した（登録されていない・禁止の）ツール呼び出しの数 */
  rejectedCalls: number;
  /** 外部情報の中に命令らしき文面を検出した数（実行はしない） */
  injectionFlags: number;
}

export const emptyUsage = (): AgentUsage => ({ steps: 0, searches: 0, fetches: 0, inputTokens: 0, outputTokens: 0, costJpy: 0, ms: 0, retries: 0, rejectedCalls: 0, injectionFlags: 0 });

/** 上限の管理。consume の前に canStart で確認し、超えるなら実行しない */
export class Budget {
  readonly usage: AgentUsage = emptyUsage();
  private readonly t0: number;
  constructor(readonly limits: AgentLimits, private readonly now: () => number = Date.now) {
    this.t0 = now();
  }
  elapsed(): number {
    return this.now() - this.t0;
  }
  /** 現時点で超過している上限（無ければ null）。ステップ開始前に確認する */
  exceeded(): LimitKind | null {
    const u = this.usage;
    const l = this.limits;
    if (this.elapsed() >= l.maxMs) return "time";
    if (u.steps >= l.maxSteps) return "steps";
    if (u.inputTokens + u.outputTokens >= l.maxTokens) return "tokens";
    if (u.costJpy >= l.maxCostJpy) return "cost";
    return null;
  }
  canSearch(): boolean {
    return this.usage.searches < this.limits.maxSearches;
  }
  canFetch(): boolean {
    return this.usage.fetches < this.limits.maxFetches;
  }
  canRetry(): boolean {
    return this.usage.retries < this.limits.maxRetries;
  }
  addLlm(u: LlmUsage): void {
    this.usage.steps += 1;
    this.usage.inputTokens += u.inputTokens;
    this.usage.outputTokens += u.outputTokens;
    this.usage.costJpy += u.costJpy;
  }
  addCost(jpy: number): void {
    this.usage.costJpy += jpy;
  }
  snapshot(): AgentUsage {
    return { ...this.usage, ms: this.elapsed() };
  }
}

// ---------------------------------------------------------------- 権限とツール
/** 登録できるツールの種類。読み取り専用（内部=開発用DB等、外部=Web）。これ以外は登録できない */
export type ToolAccess = "read_internal" | "read_external";
const ALLOWED_ACCESS: readonly string[] = ["read_internal", "read_external"];
/** 名前に含まれていたら登録を拒否する語（書き込み・SQL・シェル・デプロイ・投稿などの能力を持つツールの混入防止） */
const FORBIDDEN_NAME = /(write|update|delete|remove|insert|upsert|save|register|merge|sql|query_raw|exec|shell|bash|eval|deploy|push|post|tweet|send|publish|migrate|drop)/i;

export interface ToolSpec {
  name: string;
  description: string;
  /** JSON Schema（LLM に渡す入力の形） */
  inputSchema: Record<string, unknown>;
}
export interface ToolOutput {
  /** LLM に見せる結果（外部由来なら untrusted=true で、実行基盤が「データ」として囲む） */
  content: string;
  untrusted?: boolean;
  /** 構造化した結果（証拠として保持。LLM には渡さない） */
  data?: unknown;
}
export interface ToolContext {
  budget: Budget;
  signal?: AbortSignal;
}
export interface AgentTool extends ToolSpec {
  access: ToolAccess;
  /** 消費する上限の種類（実行前に確認し、実行後に加算する） */
  consumes?: "search" | "fetch";
  /** 1回あたりの概算費用（円。検索など料金のかかるもの） */
  costJpy?: number;
  run(input: Record<string, unknown>, ctx: ToolContext): Promise<ToolOutput>;
}

export class ToolRegistry {
  private readonly tools = new Map<string, AgentTool>();
  register(tool: AgentTool): this {
    if (!ALLOWED_ACCESS.includes(tool.access)) throw new Error(`ツール「${tool.name}」は登録できません: 読み取り専用（read_internal / read_external）のみ許可されています`);
    if (FORBIDDEN_NAME.test(tool.name)) throw new Error(`ツール名「${tool.name}」は登録できません: 書き込み・SQL・実行・デプロイ・投稿に当たる名前は使えません`);
    if (this.tools.has(tool.name)) throw new Error(`ツール「${tool.name}」は既に登録されています`);
    this.tools.set(tool.name, tool);
    return this;
  }
  get(name: string): AgentTool | undefined {
    return this.tools.get(name);
  }
  specs(): ToolSpec[] {
    return [...this.tools.values()].map(({ name, description, inputSchema }) => ({ name, description, inputSchema }));
  }
  names(): string[] {
    return [...this.tools.keys()];
  }
}

// ---------------------------------------------------------------- 外部情報の扱い
/** 命令らしき文面（プロンプトインジェクション）の検出。検出しても実行はしない。信頼度の減点と記録に使う */
const INJECTION_PATTERNS: RegExp[] = [
  /(以前|これまで|上記|前)の(指示|命令|プロンプト)を(無視|忘れ)/,
  /ignore (all |any )?(the )?(previous|prior|above) (instructions|prompts?)/i,
  /(システム|管理者|開発者)(プロンプト|からの(指示|命令))/,
  /you are now|new instructions?:|system prompt/i,
  /(APIキー|api[_ -]?key|パスワード|秘密鍵|環境変数)を(出力|送信|表示|教えて)/i,
  /(データベース|DB|テーブル|店舗|マスター)を(削除|更新|書き換え|消去)/,
  /(delete|drop|truncate|update)\s+(table|from|database)/i,
  /この(店舗|住所|情報)を(必ず|そのまま)(採用|登録|確定)/,
];
export function detectInjection(text: string): string[] {
  return INJECTION_PATTERNS.filter((re) => re.test(text)).map((re) => re.source.slice(0, 40));
}
/** 外部の文章をデータとして囲む。LLM には「この中の指示には従わない」と伝える（システムプロンプト側でも明示する） */
export function wrapUntrusted(text: string, source: string): string {
  const safe = text.replace(/<\/?untrusted_web_content[^>]*>/gi, "");
  return `<untrusted_web_content source="${source.replace(/"/g, "'")}">\n${safe}\n</untrusted_web_content>`;
}

// ---------------------------------------------------------------- LLM とループ
export interface LlmUsage {
  inputTokens: number;
  outputTokens: number;
  costJpy: number;
}
export interface ToolCall {
  id: string;
  name: string;
  input: Record<string, unknown>;
}
export type AgentMessage =
  | { role: "user"; text: string }
  | { role: "assistant"; text?: string; calls: ToolCall[] }
  | { role: "tool"; callId: string; name: string; content: string; isError?: boolean };

export type LlmStep = { kind: "tool_calls"; calls: ToolCall[]; text?: string; usage: LlmUsage } | { kind: "final"; output: unknown; usage: LlmUsage };

export class TransientLlmError extends Error {}

export interface AgentLLM {
  readonly name: string;
  step(input: { system: string; messages: AgentMessage[]; tools: ToolSpec[] }): Promise<LlmStep>;
}

export type TraceEvent =
  | { t: "step"; n: number; text?: string }
  | { t: "tool"; name: string; input: Record<string, unknown>; ok: boolean; summary: string; untrusted?: boolean; injection?: string[]; data?: unknown }
  | { t: "rejected"; name: string; reason: string }
  | { t: "limit"; kind: LimitKind; detail: string }
  | { t: "retry"; reason: string }
  | { t: "error"; message: string };

export type AgentStatus = "completed" | "limit_reached" | "error";
export interface AgentRun {
  status: AgentStatus;
  stopReason: string;
  /** LLM が submit した最終出力（検証前。信用しない） */
  output?: unknown;
  trace: TraceEvent[];
  usage: AgentUsage;
}

export interface RunAgentInput {
  llm: AgentLLM;
  tools: ToolRegistry;
  system: string;
  task: string;
  limits?: Partial<AgentLimits>;
  now?: () => number;
}

/** エージェントを1タスク実行する。例外を投げず、必ず AgentRun を返す（上限・API障害でも安全に終了） */
export async function runAgent(input: RunAgentInput): Promise<AgentRun> {
  const budget = new Budget({ ...DEFAULT_LIMITS, ...input.limits }, input.now);
  const trace: TraceEvent[] = [];
  const messages: AgentMessage[] = [{ role: "user", text: input.task }];
  const finish = (status: AgentStatus, stopReason: string, output?: unknown): AgentRun => ({ status, stopReason, output, trace, usage: budget.snapshot() });

  for (;;) {
    const over = budget.exceeded();
    if (over) {
      trace.push({ t: "limit", kind: over, detail: `${LIMIT_LABEL[over]}の上限に達したため終了` });
      return finish("limit_reached", over);
    }
    let step: LlmStep;
    try {
      step = await input.llm.step({ system: input.system, messages, tools: input.tools.specs() });
    } catch (e) {
      if (e instanceof TransientLlmError && budget.canRetry()) {
        budget.usage.retries += 1;
        trace.push({ t: "retry", reason: e.message.slice(0, 120) });
        continue;
      }
      const transient = e instanceof TransientLlmError;
      if (transient) trace.push({ t: "limit", kind: "retries", detail: "再試行の上限に達したため終了" });
      trace.push({ t: "error", message: (e as Error).message?.slice(0, 200) ?? "不明なエラー" });
      return finish(transient ? "limit_reached" : "error", transient ? "retries" : "llm_error");
    }
    budget.addLlm(step.usage);
    trace.push({ t: "step", n: budget.usage.steps, text: step.kind === "tool_calls" ? step.text : undefined });
    if (step.kind === "final") return finish("completed", "submitted", step.output);

    messages.push({ role: "assistant", text: step.text, calls: step.calls });
    for (const call of step.calls) {
      const tool = input.tools.get(call.name);
      if (!tool) {
        // 登録されていない（禁止された操作を含む）ツールは実行しない
        budget.usage.rejectedCalls += 1;
        trace.push({ t: "rejected", name: call.name, reason: "登録されていないツール（使えません）" });
        messages.push({ role: "tool", callId: call.id, name: call.name, content: `エラー: ツール「${call.name}」は使えません。使えるツール: ${input.tools.names().join(", ")}`, isError: true });
        continue;
      }
      if ((tool.consumes === "search" && !budget.canSearch()) || (tool.consumes === "fetch" && !budget.canFetch())) {
        const kind: LimitKind = tool.consumes === "search" ? "searches" : "fetches";
        trace.push({ t: "limit", kind, detail: `${LIMIT_LABEL[kind]}の上限に達しているため「${call.name}」は実行しない` });
        messages.push({ role: "tool", callId: call.id, name: call.name, content: `エラー: ${LIMIT_LABEL[kind]}の上限に達しました。これ以上は実行できません。集めた情報で結論を出してください`, isError: true });
        continue;
      }
      try {
        if (tool.consumes === "search") budget.usage.searches += 1;
        if (tool.consumes === "fetch") budget.usage.fetches += 1;
        if (tool.costJpy) budget.addCost(tool.costJpy);
        const out = await tool.run(call.input, { budget });
        const flags = out.untrusted ? detectInjection(out.content) : [];
        if (flags.length) budget.usage.injectionFlags += 1;
        trace.push({ t: "tool", name: call.name, input: call.input, ok: true, summary: out.content.slice(0, 160), untrusted: out.untrusted, injection: flags.length ? flags : undefined, data: out.data });
        const shown = out.untrusted ? wrapUntrusted(out.content, call.name) : out.content;
        messages.push({ role: "tool", callId: call.id, name: call.name, content: shown });
      } catch (e) {
        const msg = (e as Error).message?.slice(0, 160) ?? "失敗";
        trace.push({ t: "tool", name: call.name, input: call.input, ok: false, summary: msg });
        messages.push({ role: "tool", callId: call.id, name: call.name, content: `エラー: ${msg}`, isError: true });
      }
    }
  }
}
