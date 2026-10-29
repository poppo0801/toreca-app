// @vitest-environment node
import { describe, expect, it } from "vitest";
import { createMockData } from "@/data/mock";
import { buildDraft } from "@/lib/lottery-match";
import { lotteryInputSchema } from "@/lib/lottery-input";
import type { ExtractedLottery } from "@/lib/ai/extraction";
import type { AppData, Lottery } from "@/types/domain";
import live from "@/lib/ai/fixtures/live-t1.json";

/**
 * 実際のAI(Claude Haiku 5.5)が返した結果（架空の告知「サンプル電機 三宮店」。docs/ai-live-verification.md の文章1）を使って、
 * マスター照合・重複検出・フォーム下書きを確認する（APIは呼ばない）。
 */
const ex = live.extraction as unknown as ExtractedLottery;
const NOW = new Date("2026-10-28T03:00:00Z");

/** 既存マスター（正式名称「拡張パック「ひかりの森」」）と、同じ内容の登録済み抽選を足したデータ */
function dataWith(existing: Partial<Lottery> | null): AppData {
  const d = createMockData(NOW);
  const products = [...d.products, { id: "p-hikari", officialName: "拡張パック「ひかりの森」", aliases: [], code: "", packsPerBox: 30 }];
  const base = d.lotteries[0];
  const lot: Lottery | null = existing
    ? { ...base, id: "EX1", chainId: "c1", storeId: "s1", items: [{ id: "ex1i", productId: "p-hikari", quantity: 1, unit: "box" }], sourceUrls: [], applyDeadline: { precision: "date_time", at: "2026-11-10T14:59:00.000Z" }, ...existing }
    : null;
  return { ...d, products, lotteries: lot ? [...d.lotteries, lot] : d.lotteries };
}

describe("実AIの結果 → マスター照合・フォーム下書き", () => {
  it("系列・店舗は既存マスターに一致し、日付のみの項目は時刻を補わず、年を補った注意が付く", () => {
    const d = buildDraft(ex, dataWith(null));
    expect(d.summary.chain).toBe("exact");
    expect(d.summary.store).toBe("exact");
    expect(d.input.chain.id).toBe("c1");
    expect(d.input.store.id).toBe("s1");
    expect(d.input.applyDeadline).toEqual({ precision: "date_time", date: "2026-11-10", time: "23:59" });
    expect(d.input.resultDate).toEqual({ precision: "date_only", date: "2026-11-13", time: "" }); // 日付のみ。23:59などを補わない
    expect(d.input.procedureDeadline).toEqual({ precision: "date_only", date: "2026-11-20", time: "" });
    expect(d.input.applyMethod).toBe("app");
    expect(d.input.receiveMethod).toBe("store");
    // 保存できる形か（モックのIDはUUIDではないため、ID以外の項目だけ検証する。実際の保存は本番の画面テストで確認済み）
    const issues = lotteryInputSchema.safeParse(d.input).error?.issues ?? [];
    expect(issues.filter((i) => !String(i.path.join(".")).match(/(^|.)id$/))).toEqual([]);
  });

  it("商品名にブランド名・数量・入数（ポケモンカードゲーム／1BOX（30パック入り））が混ざっていても、正式名称の商品に一致する", () => {
    const d = buildDraft(ex, dataWith(null));
    expect(d.summary.items[0].kind).toBe("exact");
    expect(d.input.items[0].product.id).toBe("p-hikari");
    expect(d.candidates.items[0]).toEqual([]);
  });

  it("商品マスターに無い場合は名称のまま（保存時に仮登録）で、別の商品に誤って割り当てない", () => {
    const d = buildDraft(ex, createMockData(NOW)); // 「ひかりの森」はテスト拡張パックとして登録済み。名称が大きく違うので割り当てない
    expect(d.summary.items[0].kind === "none" || d.summary.items[0].kind === "fuzzy" || d.summary.items[0].kind === "partial").toBe(true);
    if (d.summary.items[0].kind === "none") expect(d.input.items[0].product.id).toBeNull();
  });

  it("同じ店舗・同じ商品・同じ応募締切の抽選が登録済みなら「重複の可能性（高）」。締切が違えば重複としない", () => {
    expect(buildDraft(ex, dataWith({})).duplicates[0]).toMatchObject({ lotteryId: "EX1", level: "high" });
    expect(buildDraft(ex, dataWith({ applyDeadline: { precision: "date_time", at: "2026-12-10T14:59:00.000Z" } })).duplicates).toHaveLength(0);
  });

  it("登録済みの抽選の締切が不明なら「可能性（中）」、同じ情報源URLなら高。二重登録の確認が必要になる", () => {
    expect(buildDraft(ex, dataWith({ applyDeadline: { precision: "unknown" } })).duplicates[0].level).toBe("medium");
    const withUrl = buildDraft(ex, dataWith({ applyDeadline: { precision: "unknown" }, sourceUrls: ["https://example.invalid/src"] }), { sourceUrl: "https://example.invalid/src" });
    expect(withUrl.duplicates[0]).toMatchObject({ level: "high", reason: expect.stringContaining("URL") });
  });
});
