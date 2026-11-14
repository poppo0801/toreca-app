/**
 * 実API評価の費用・停止の関門（Stage 9E・純粋なロジック＋クライアントの包み）。承認された範囲（累計の上限・1ケースの上限）を、実行の**前**に確認する。
 *  - 累計の費用が上限に達する見込み（今回の呼び出しの最大費用を足すと超える）なら、呼び出さずに止める
 *  - 1ケースの費用が上限に達する見込みなら、そのケースを止める（次のケースへは進める）
 *  - APIエラーが連続2回で全体を止める
 *  - 誤った自動登録・更新が1件でも見つかったら、呼び出し側が stop() を呼んで全体を止める
 * 費用の台帳（ledger）は、実行をまたいで累計を守るため、呼び出し側がファイルに保存する（persist）。AI自身はこのクラスに触れない。
 */
import type Anthropic from "@anthropic-ai/sdk";
import { estimateCostJpy } from "@/lib/ai-cost";
import type { ExtractOutput, ExtractRequest, LotteryExtractor } from "@/lib/ai/provider";

export class GuardStop extends Error {
  constructor(
    readonly reason: "cap" | "case_cap" | "api_errors" | "stopped",
    message: string,
  ) {
    super(message);
  }
}

export interface LedgerEntry {
  caseId: string;
  kind: "agent" | "extract";
  jpy: number;
  inputTokens: number;
  outputTokens: number;
}
export interface LedgerState {
  capJpy: number;
  perCaseJpy: number;
  spentJpy: number;
  entries: LedgerEntry[];
}

export interface GuardOptions {
  capJpy: number;
  perCaseJpy: number;
  maxConsecutiveErrors?: number;
  model: string;
  /** 過去の実行までの累計（円）。台帳から読む */
  spentBefore?: number;
  persist?: (s: LedgerState) => void;
}

type Client = Pick<Anthropic, "messages">;

/** 要求の本文から、入力トークンを保守的に（多めに）見積もる。日本語は1文字≒1トークンとして数える */
export function estimateInputTokens(payload: unknown): number {
  try {
    return Math.ceil(JSON.stringify(payload).length * 1.0);
  } catch {
    return 50_000;
  }
}

export class RealRunGuard {
  private spent: number;
  private caseId = "";
  private caseSpent = 0;
  private consecutiveErrors = 0;
  private stoppedReason: string | null = null;
  readonly entries: LedgerEntry[] = [];
  constructor(private readonly o: GuardOptions) {
    this.spent = o.spentBefore ?? 0;
  }
  get spentJpy(): number {
    return this.spent;
  }
  get caseSpentJpy(): number {
    return this.caseSpent;
  }
  get stopped(): string | null {
    return this.stoppedReason;
  }
  startCase(id: string): void {
    this.caseId = id;
    this.caseSpent = 0;
  }
  /** 全体を止める（誤った自動登録・更新・評価データの不整合・制御不能なループなど） */
  stop(reason: string): void {
    this.stoppedReason ??= reason;
  }
  /** 呼び出しの前: 最大費用を足しても、累計・1ケースの上限を超えないか。超える見込みなら呼び出さない */
  precheck(maxCostJpy: number): void {
    if (this.stoppedReason) throw new GuardStop("stopped", `評価を停止しています: ${this.stoppedReason}`);
    if (this.spent + maxCostJpy > this.o.capJpy) throw new GuardStop("cap", `累計の費用が上限（${this.o.capJpy}円）に達する見込みのため止めました（累計${this.spent.toFixed(2)}円）`);
    if (this.caseSpent + maxCostJpy > this.o.perCaseJpy) throw new GuardStop("case_cap", `1ケースの費用が上限（${this.o.perCaseJpy}円）に達する見込みのため、このケースを止めました`);
  }
  charge(kind: LedgerEntry["kind"], inputTokens: number, outputTokens: number): number {
    const jpy = estimateCostJpy(this.o.model, inputTokens, outputTokens) ?? 0;
    this.spent += jpy;
    this.caseSpent += jpy;
    this.entries.push({ caseId: this.caseId, kind, jpy, inputTokens, outputTokens });
    this.consecutiveErrors = 0;
    this.persist();
    return jpy;
  }
  apiError(): void {
    this.consecutiveErrors += 1;
    if (this.consecutiveErrors >= (this.o.maxConsecutiveErrors ?? 2)) this.stop(`APIエラーが連続${this.consecutiveErrors}回発生`);
  }
  private persist(): void {
    this.o.persist?.({ capJpy: this.o.capJpy, perCaseJpy: this.o.perCaseJpy, spentJpy: this.spent, entries: this.entries });
  }

  /** Messages API のクライアントを包む。呼び出しの前に費用の見込みを確認し、後で実際の使用量を台帳へ記録する */
  wrapClient(client: Client, kind: LedgerEntry["kind"] = "agent"): Client {
    const guard = this;
    return {
      messages: {
        create: async (params: Anthropic.MessageCreateParamsNonStreaming, options?: Anthropic.RequestOptions) => {
          const worst = estimateCostJpy(guard.o.model, estimateInputTokens(params), params.max_tokens) ?? 0;
          guard.precheck(worst);
          try {
            const res = (await client.messages.create(params, options)) as Anthropic.Message;
            guard.charge(kind, res.usage.input_tokens, res.usage.output_tokens);
            return res;
          } catch (e) {
            if (e instanceof GuardStop) throw e;
            guard.apiError();
            throw e;
          }
        },
      },
    } as Client;
  }

  /** 解析エンジン（抽選情報の読み取り）を包む。同じ関門を通し、使用量を台帳へ記録する */
  wrapExtractor(ex: LotteryExtractor): LotteryExtractor {
    const guard = this;
    return {
      engine: ex.engine,
      async extract(req: ExtractRequest): Promise<ExtractOutput> {
        // 読み取りは出力の上限が8192トークン。最大費用で確認する
        const worst = estimateCostJpy(guard.o.model, estimateInputTokens(req.text ?? "") + 3000, 8192) ?? 0;
        guard.precheck(worst);
        try {
          const out = await ex.extract(req);
          if (out.usage) guard.charge("extract", out.usage.input, out.usage.output);
          return out;
        } catch (e) {
          if (e instanceof GuardStop) throw e;
          guard.apiError();
          throw e;
        }
      },
    };
  }
}
