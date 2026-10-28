import { describe, expect, it } from "vitest";
import { budgetStatus, budgetThresholds, canRunAutoAnalysis, estimateCostJpy, MODEL_PRICES, summarizeUsage, type AiLogRow } from "@/lib/ai-cost";

const log = (over: Partial<AiLogRow> = {}): AiLogRow => ({
  created_at: "2026-10-10T03:00:00Z", kind: "text", status: "ok", engine: "anthropic", model: "claude-haiku-5-5", input_tokens: 2000, output_tokens: 800, ...over,
});

describe("AI利用料金の推定（公式単価 × トークン数 × 概算レート）", () => {
  it("公式の単価（Haiku 5.5: 入力$0.10/出力$0.50、Sonnet 5.5: $2/$10 per 100万トークン）で円に換算する", () => {
    expect(MODEL_PRICES["claude-haiku-5-5"]).toEqual({ input: 0.1, output: 0.5 });
    // 1,000,000入力 + 1,000,000出力 = $0.6 → 90円（150円/ドル）
    expect(estimateCostJpy("claude-haiku-5-5", 1_000_000, 1_000_000)).toBeCloseTo(90);
    expect(estimateCostJpy("claude-sonnet-5-5", 1_000_000, 1_000_000)).toBeCloseTo(1800);
    // 1回の文章解析（入力2千・出力0.8千）は1円未満
    expect(estimateCostJpy("claude-haiku-5-5", 2000, 800)!).toBeLessThan(1);
  });

  it("モデル・トークン数・単価が不明なときは推定せず null（0円にしない）", () => {
    expect(estimateCostJpy(null, 100, 100)).toBeNull();
    expect(estimateCostJpy("claude-unknown", 100, 100)).toBeNull();
    expect(estimateCostJpy("claude-haiku-5-5", null, 100)).toBeNull();
  });

  it("月ごとに、実際のAI呼び出しだけを回数・種類・トークン・料金として集計する。モックと未設定は料金に含めない", () => {
    const logs = [
      log(),
      log({ kind: "image", input_tokens: 3000, output_tokens: 900 }),
      log({ kind: "url" }),
      log({ model: null }), // 推定できない
      log({ engine: "mock", model: null, input_tokens: null, output_tokens: null }),
      log({ engine: "none", status: "not_configured", model: null, input_tokens: null, output_tokens: null }),
      log({ created_at: "2026-09-20T03:00:00Z" }),
      // JST の月境界: UTC では 9/30 だが JST では 10/1
      log({ created_at: "2026-09-30T16:00:00Z" }),
    ];
    const [oct, sep] = summarizeUsage(logs);
    expect(oct.month).toBe("2026-10");
    expect(oct.calls).toBe(5); // 実AI: 4件 + 月境界の1件
    expect(oct.byKind).toEqual({ text: 3, image: 1, url: 1, x_url: 0 });
    expect(oct.mockCalls).toBe(1);
    expect(oct.unestimated).toBe(1);
    expect(oct.inputTokens).toBe(2000 * 4 + 3000);
    expect(oct.byModel["claude-haiku-5-5"]).toBe(4);
    expect(oct.byModel["（モデル不明）"]).toBe(1);
    expect(oct.costJpy).toBeGreaterThan(0);
    expect(sep.month).toBe("2026-09");
    expect(sep.calls).toBe(1);
  });
});

describe("予算と警告（1,000 / 2,000 / 2,500円・月間予算3,000円）", () => {
  it("閾値は予算の 1/3・2/3・5/6。予算3,000円なら 1,000/2,000/2,500円", () => {
    expect(budgetThresholds(3000)).toEqual([1000, 2000, 2500]);
  });

  it("使用額に応じて警告レベルが上がり、予算に達したら over", () => {
    const lv = (c: number) => budgetStatus(c, 3000).level;
    expect([lv(0), lv(999), lv(1000), lv(1999), lv(2000), lv(2499), lv(2500), lv(2999), lv(3000), lv(5000)]).toEqual(["ok", "ok", "warn1", "warn1", "warn2", "warn2", "warn3", "warn3", "over", "over"]);
    expect(budgetStatus(500, 3000).message).toBeNull();
    expect(budgetStatus(1200, 3000).message).toContain("1,000円");
    expect(budgetStatus(3200, 3000).message).toContain("停止");
    expect(budgetStatus(1500, 3000).usedRate).toBeCloseTo(0.5);
  });

  it("予算を変えると閾値も比例して変わる。予算0円は使用率なし（常に超過）", () => {
    expect(budgetStatus(1000, 6000).level).toBe("ok");
    expect(budgetStatus(2000, 6000).level).toBe("warn1");
    expect(budgetStatus(0, 0)).toMatchObject({ level: "over", usedRate: null });
  });

  it("自動AI解析（Stage 4C）は、予算超過またはOFF設定のとき停止できる。手動は止めない", () => {
    expect(canRunAutoAnalysis({ level: "ok" }, true)).toEqual({ allowed: true, reason: null });
    expect(canRunAutoAnalysis({ level: "warn3" }, true).allowed).toBe(true);
    expect(canRunAutoAnalysis({ level: "over" }, true).allowed).toBe(false);
    expect(canRunAutoAnalysis({ level: "ok" }, false).allowed).toBe(false);
  });
});
