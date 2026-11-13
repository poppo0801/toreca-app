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
  /** 入力＋出力トークンの累計上限（各ステップで会話全体を再送するため、累計は膨らむ。費用上限が主な安全装置） */
  maxTokens: number;
  /** 推定費用（円）の上限。実際の請求額とは差が出うる推定値 */
  maxCostJpy: number;
  /** 処理時間の上限（ミリ秒） */
  maxMs: number;
  /** LLM の一時的なエラーに対する再試行の最大回数（タスク全体） */
  maxRetries: number;
  /** 同じ検索・同じURLの重複した呼び出し（実行せずに断った回数）の上限。超えたら無駄な繰り返しとして終了する（Stage 8D-6） */
  maxDuplicates: number;
}

/** 既定の上限（保守的）。呼び出し側で変更できる。再調査（検証結果を受けた追加調査）も、同じ上限の中で行う（上限は追加されない） */
export const DEFAULT_LIMITS: AgentLimits = { maxSteps: 12, maxSearches: 4, maxFetches: 6, maxTokens: 300_000, maxCostJpy: 15, maxMs: 90_000, maxRetries: 2, maxDuplicates: 3 };

export type LimitKind = "steps" | "searches" | "fetches" | "tokens" | "cost" | "time" | "retries" | "duplicates";
export const LIMIT_LABEL: Record<LimitKind, string> = { steps: "実行回数", searches: "Web検索回数", fetches: "ページ取得回数", tokens: "トークン量", cost: "推定費用", time: "処理時間", retries: "再試行回数", duplicates: "重複した呼び出し" };

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
  /** 実行せずに断った、同じ検索・同じURLの重複した呼び出しの数（費用・検索回数は消費しない） */
  duplicateCalls: number;
  /** 検証結果を受けて再調査した回数（Stage 8D-6）。再調査の費用・検索・取得も、上の合計に含まれる */
  followUps: number;
}

export const emptyUsage = (): AgentUsage => ({ steps: 0, searches: 0, fetches: 0, inputTokens: 0, outputTokens: 0, costJpy: 0, ms: 0, retries: 0, rejectedCalls: 0, injectionFlags: 0, duplicateCalls: 0, followUps: 0 });

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
  /**
   * もう1往復（再調査: 少なくとも「検索または取得」と「提出」の2ステップ）を始めても、上限を超えないと予測できるか。
   * 1ステップの平均（費用・トークン・時間）の1.5倍を見込む。予測で超えるなら、再調査は始めない（上限に当たって途中で止まらないように）。
   */
  hasHeadroom(minSteps = 2): boolean {
    const u = this.usage;
    const l = this.limits;
    const n = Math.max(u.steps, 1);
    const elapsed = this.elapsed();
    if (l.maxSteps - u.steps < minSteps) return false;
    if (l.maxCostJpy - u.costJpy < Math.max((u.costJpy / n) * 1.5, 0.5)) return false;
    if (l.maxTokens - (u.inputTokens + u.outputTokens) < ((u.inputTokens + u.outputTokens) / n) * 1.5) return false;
    if (l.maxMs - elapsed < Math.max((elapsed / n) * 1.5, 5_000)) return false;
    return true;
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
  /** 同じ呼び出しの判定キー（正規化した検索語・URLなど）。同じキーの呼び出しは、実行せず・上限も消費せずに断る（無意味な繰り返しの防止）。null は重複判定なし */
  dedupeKey?(input: Record<string, unknown>): string | null;
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
  | { role: "assistant"; text?: string; calls: ToolCall[]; /** モデルの応答の原本（思考ブロックなどを次の要求へそのまま戻すため。実API用） */ raw?: unknown[] }
  | { role: "tool"; callId: string; name: string; content: string; isError?: boolean };

export type LlmStep =
  | { kind: "tool_calls"; calls: ToolCall[]; text?: string; raw?: unknown[]; usage: LlmUsage; /** APIの停止理由（記録用。Stage 8F-3） */ stopReason?: string }
  /** 提出。calls・raw は、提出のあとに検証結果を返して会話を続けるとき（再調査）に使う（提出を含む同じ応答の呼び出しと、応答の原本）。無ければ会話側で補う */
  | { kind: "final"; output: unknown; usage: LlmUsage; calls?: ToolCall[]; raw?: unknown[]; stopReason?: string };

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
  | { t: "duplicate"; name: string; detail: string }
  /** 提出を独立した検証にかけた結果、不足があるため追加調査を求めた（検証システムが書いた文面。AIは書き換えられない） */
  | { t: "review"; round: number; feedback: string; meta?: unknown }
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
  /**
   * 提出（submit）を受け取ったあとの「独立した検証」（Stage 8D-6）。不足があれば、その具体的な理由（検証システムの文面）を返すと、
   * 同じ会話・同じ予算のまま、AIが追加調査・保留・終了を選べる。null を返すか、回数・予算の余力が無ければ、そこで終了する。
   * 検証はAIの外側（呼び出し側）で行い、AIは結果を書き換えられない。
   */
  review?: (info: ReviewInfo) => Promise<{ feedback: string; meta?: unknown } | null>;
  /** 検証を受けた再調査の最大回数（既定 0＝再調査しない） */
  maxReviews?: number;
}
export interface ReviewInfo {
  /** 今回の提出（検証前。信用しない） */
  output: unknown;
  /** これまでの再調査の回数 */
  round: number;
  trace: TraceEvent[];
  /** 現時点の使用量と、残りの上限 */
  usage: AgentUsage;
  remaining: { steps: number; searches: number; fetches: number; costJpy: number; ms: number };
}

/** エージェントを1タスク実行する。例外を投げず、必ず AgentRun を返す（上限・API障害でも安全に終了） */
export async function runAgent(input: RunAgentInput): Promise<AgentRun> {
  const budget = new Budget({ ...DEFAULT_LIMITS, ...input.limits }, input.now);
  const trace: TraceEvent[] = [];
  const messages: AgentMessage[] = [{ role: "user", text: input.task }];
  /** 直近の提出（再調査の途中で上限・障害に当たっても、それまでの提出は失わない） */
  let lastSubmitted: unknown;
  let rounds = 0;
  const seen = new Set<string>();
  const finish = (status: AgentStatus, stopReason: string, output?: unknown): AgentRun => ({ status, stopReason, output: output ?? lastSubmitted, trace, usage: { ...budget.snapshot(), followUps: rounds } });

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
    if (step.kind === "final") {
      // 再調査の依頼のあと、AIが再提出せず（ツールを呼ばず説明だけで終了・出力の途切れ）空の出力になったときは、直前の有効な提出を失わない（8F-7）
      if (rounds > 0 && lastSubmitted !== undefined && /(^|:)(no_tool_call|max_tokens)$/.test(step.stopReason ?? "")) {
        trace.push({ t: "review", round: rounds, feedback: "再調査の依頼のあと再提出が無かったため、直前の提出を採用", meta: { keptPrevious: true } });
        return finish("completed", "submitted", lastSubmitted);
      }
      lastSubmitted = step.output;
      // 独立した検証 → 不足があれば、具体的な理由を返して追加調査を促す。回数の上限・予算の余力（予測）が無ければ再調査しない
      if (input.review && rounds < (input.maxReviews ?? 0) && !budget.exceeded() && budget.hasHeadroom()) {
        const u = budget.snapshot();
        const l = budget.limits;
        let r: { feedback: string; meta?: unknown } | null = null;
        try {
          r = await input.review({ output: step.output, round: rounds, trace, usage: u, remaining: { steps: l.maxSteps - u.steps, searches: l.maxSearches - u.searches, fetches: l.maxFetches - u.fetches, costJpy: Math.max(0, l.maxCostJpy - u.costJpy), ms: Math.max(0, l.maxMs - u.ms) } });
        } catch {
          r = null; // 検証の失敗では再調査しない（提出はそのまま最終の検証にかかる）
        }
        if (r) {
          rounds += 1;
          trace.push({ t: "review", round: rounds, feedback: r.feedback.slice(0, 1500), meta: r.meta });
          const submitCall: ToolCall = { id: `submit-${rounds}`, name: "submit_findings", input: (step.output ?? {}) as Record<string, unknown> };
          const calls = step.calls && step.calls.length > 0 ? step.calls : [submitCall];
          messages.push({ role: "assistant", calls, raw: step.raw });
          // 提出の呼び出しには検証結果を返す。同じ応答にあった他の呼び出しは、提出と同時のため実行しない
          for (const c of calls) {
            const isSubmit = c.name === "submit_findings" || c === submitCall;
            messages.push({ role: "tool", callId: c.id, name: c.name, content: isSubmit ? r.feedback : "提出と同時に呼び出されたため実行していません。必要なら、あらためて呼び出してください", isError: !isSubmit });
          }
          continue;
        }
      }
      return finish("completed", "submitted", step.output);
    }

    messages.push({ role: "assistant", text: step.text, calls: step.calls, raw: step.raw });
    for (const call of step.calls) {
      const tool = input.tools.get(call.name);
      if (!tool) {
        // 登録されていない（禁止された操作を含む）ツールは実行しない
        budget.usage.rejectedCalls += 1;
        trace.push({ t: "rejected", name: call.name, reason: "登録されていないツール（使えません）" });
        messages.push({ role: "tool", callId: call.id, name: call.name, content: `エラー: ツール「${call.name}」は使えません。使えるツール: ${input.tools.names().join(", ")}`, isError: true });
        continue;
      }
      // 同じ検索・同じURLの繰り返し: 実行せず、上限（検索・取得の回数・費用）も消費せずに断る。繰り返しが続くなら、無駄な調査として終了する
      const key = tool.dedupeKey?.(call.input) ?? null;
      if (key !== null) {
        if (seen.has(`${tool.name}:${key}`)) {
          budget.usage.duplicateCalls += 1;
          trace.push({ t: "duplicate", name: call.name, detail: "同じ呼び出しは実行済みのため断った（上限は消費しない）" });
          messages.push({ role: "tool", callId: call.id, name: call.name, content: `エラー: 同じ「${call.name}」は実行済みです（結果は会話の中にあります）。別の検索語・別のURLにするか、集めた情報で結論を出してください`, isError: true });
          if (budget.usage.duplicateCalls >= budget.limits.maxDuplicates) {
            trace.push({ t: "limit", kind: "duplicates", detail: "同じ呼び出しの繰り返しが続いたため終了" });
            return finish("limit_reached", "duplicates");
          }
          continue;
        }
        seen.add(`${tool.name}:${key}`);
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
