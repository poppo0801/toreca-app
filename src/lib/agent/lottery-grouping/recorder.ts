/**
 * 実APIの応答の記録（Stage 8F-3）。形式不正などの原因を後から特定するために、AIの各ステップ（停止理由・呼んだツール・提出の生の内容・使用量）を残す。
 * 記録に含めないもの: APIキー・認証ヘッダー（そもそも応答に含まれないが、文字列に混入しても伏せる）。長い文章は切り詰める。
 * 評価データ（抽選の項目・情報源の文章）は公開情報だけで、個人情報を含まない。
 */
import type { AgentLLM, LlmStep } from "@/lib/agent/core";

export interface StepLog {
  i: number;
  kind: "tool_calls" | "final" | "error";
  stopReason?: string;
  calls: string[];
  /** 提出（final）の生の内容（伏せ字・切り詰め済み） */
  output?: unknown;
  text?: string;
  inputTokens?: number;
  outputTokens?: number;
  error?: string;
}

const SECRET = /(sk-ant-[A-Za-z0-9_-]{6,}|sk-[A-Za-z0-9_-]{20,}|Bearer\s+[A-Za-z0-9._-]{10,})/g;
const SECRET_KEY = /^(api[-_]?key|x-api-key|authorization|password|secret)$/i;
export const redact = (s: string): string => s.replace(SECRET, "[伏せ字]");

/** 記録用に、伏せ字・切り詰めをした複製を作る */
export function sanitize(v: unknown, depth = 0): unknown {
  if (typeof v === "string") return redact(v).slice(0, 1500);
  if (depth > 6 || v === null || typeof v !== "object") return typeof v === "number" || typeof v === "boolean" || v === null ? v : v === undefined ? undefined : String(v).slice(0, 100);
  if (Array.isArray(v)) return v.slice(0, 40).map((x) => sanitize(x, depth + 1));
  const out: Record<string, unknown> = {};
  for (const [k, x] of Object.entries(v as Record<string, unknown>)) out[k] = SECRET_KEY.test(k) ? "[伏せ字]" : sanitize(x, depth + 1);
  return out;
}

export class RecordingLlm implements AgentLLM {
  readonly steps: StepLog[] = [];
  constructor(private readonly inner: AgentLLM) {}
  get name(): string {
    return this.inner.name;
  }
  async step(input: Parameters<AgentLLM["step"]>[0]): Promise<LlmStep> {
    const i = this.steps.length;
    try {
      const r = await this.inner.step(input);
      this.steps.push({
        i, kind: r.kind, stopReason: r.stopReason, calls: r.kind === "tool_calls" ? r.calls.map((c) => c.name) : (r.calls ?? []).map((c) => c.name),
        ...(r.kind === "final" ? { output: sanitize(r.output) } : { text: r.text ? redact(r.text).slice(0, 500) : undefined }),
        inputTokens: r.usage.inputTokens, outputTokens: r.usage.outputTokens,
      });
      return r;
    } catch (e) {
      this.steps.push({ i, kind: "error", calls: [], error: redact(String((e as Error)?.message ?? e)).slice(0, 300) });
      throw e;
    }
  }
}
