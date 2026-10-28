// @vitest-environment node
import { describe, expect, it } from "vitest";
import { createMockData } from "@/data/mock";
import { normalizeExtraction } from "@/lib/ai/extraction";
import { buildDraft } from "@/lib/lottery-match";
import { runExtraction } from "@/lib/server/lottery-extract-service";
import { ExtractorError, type LotteryExtractor } from "@/lib/ai/provider";

/**
 * 実際のAI(Claude Haiku 5.5)で検証したときに見つかった問題の再発防止テスト。
 * 実際のAPIは呼ばない（実AIの検証結果は docs/ai-live-verification.md）。
 */
const NOW = new Date("2026-10-28T03:00:00Z");
const base = {
  is_lottery_announcement: true,
  chain_name: "",
  store_name: "テスト玩具 本店",
  products: [{ name: "ポケカ ブースターパック「ほしぞら」", code: "", quantity: 1, unit: "box" }],
  multi_mode: "unknown",
  confidence: { chain: "low", store: "high" },
};

describe("系列と店舗: AIが「系列 店名」を分けられなかった場合", () => {
  const data = createMockData(NOW); // 系列「テスト玩具」(店舗: 本店) がある

  it("店舗名の先頭が既存の系列名なら、系列と店舗に分け、要確認にする", () => {
    const d = buildDraft(normalizeExtraction(base, NOW), data);
    expect(d.input.chain.name).toBe("テスト玩具");
    expect(d.input.chain.id).not.toBeNull();
    expect(d.input.store.name).toBe("本店");
    expect(d.flags.chain).toContain("店舗名の先頭から系列");
  });

  it("既存の系列に無い場合は推測せず、系列は空のまま（要確認）", () => {
    const d = buildDraft(normalizeExtraction({ ...base, store_name: "未知のお店 本店" }, NOW), data);
    expect(d.input.chain.name).toBe("");
    expect(d.input.chain.id).toBeNull();
    expect(d.flags.chain).toContain("読み取れませんでした");
    expect(d.input.store.name).toBe("未知のお店 本店");
  });

  it("系列が読み取れている場合はそのまま使う（店舗名を分解しない）", () => {
    const d = buildDraft(normalizeExtraction({ ...base, chain_name: "サンプル電機", store_name: "三宮店", confidence: { chain: "high", store: "high" } }, NOW), data);
    expect(d.input.chain.name).toBe("サンプル電機");
    expect(d.input.store.name).toBe("三宮店");
    expect(d.flags.chain).toBeUndefined();
  });
});

describe("AIの注意（warnings）", () => {
  it("内部用語（year・null）を含む注意は除き、システム側の「年を仮定」の注意だけを出す", () => {
    const e = normalizeExtraction(
      { ...base, chain_name: "A", apply_deadline: { year: null, month: 11, day: 5, hour: 23, minute: 59 }, warnings: ["応募期間の年の記載がないため year は null とした。", "都道府県の記載がないため空欄とした。", "unit は null とした"] },
      NOW,
    );
    expect(e.warnings.some((w) => /year|null/i.test(w))).toBe(false);
    expect(e.warnings).toContain("都道府県の記載がないため空欄とした。");
    expect(e.warnings.filter((w) => w.includes("年の記載がないため2026年と仮定"))).toHaveLength(1);
  });
});

describe("費用の記録: 結果が使えなくても、AIが呼ばれたら使用量を返す", () => {
  const usage = { input: 3400, output: 700 };
  const extractor = (raw: unknown): LotteryExtractor => ({ engine: "anthropic", extract: async () => ({ raw, engine: "anthropic", model: "claude-haiku-5-5", usage }) });
  const text = { kind: "text" as const, text: "【入荷のお知らせ】通常販売を開始しました。抽選ではありません。" };

  it("「抽選ではない」と判定された場合も、使用モデルとトークン数を返す（料金の記録漏れを防ぐ）", async () => {
    const r = await runExtraction(text, { extractor: extractor({ is_lottery_announcement: false }), now: NOW });
    expect(r).toMatchObject({ ok: false, code: "not_lottery", engine: "anthropic", model: "claude-haiku-5-5", usage });
  });

  it("何も読み取れなかった場合も同様", async () => {
    const r = await runExtraction(text, { extractor: extractor({ is_lottery_announcement: true }), now: NOW });
    expect(r).toMatchObject({ ok: false, code: "nothing_found", usage });
  });

  it("AIが結果を返さなかった(no_result)場合も、応答のトークン数を返す。APIエラー(通信失敗など)は使用量なし", async () => {
    const noResult: LotteryExtractor = { engine: "anthropic", extract: async () => { throw new ExtractorError("no_result", "x", usage, "claude-haiku-5-5"); } };
    expect(await runExtraction(text, { extractor: noResult, now: NOW })).toMatchObject({ ok: false, code: "ai_failed", usage, model: "claude-haiku-5-5" });
    const apiErr: LotteryExtractor = { engine: "anthropic", extract: async () => { throw new ExtractorError("api_error", "x"); } };
    const r = await runExtraction(text, { extractor: apiErr, now: NOW });
    expect(r.ok).toBe(false);
    expect("usage" in r ? r.usage : undefined).toBeUndefined();
  });
});
