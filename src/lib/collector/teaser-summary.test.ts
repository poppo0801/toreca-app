import { describe, expect, it } from "vitest";
import { summarizeTeasers, type TeaserRow } from "./teaser-summary";

const NOW = new Date("2026-11-20T00:00:00+09:00");
const row = (t: Record<string, unknown>, chain = "テスト系列", products = ["ハドウシーカー"]): TeaserRow => ({ created_at: "2026-11-01T00:00:00Z", draft: { tracking: { since: "2026-11-01T00:00:00Z", lastNewsAt: "2026-11-10T00:00:00Z", startDate: null, sources: [], history: [], carried: { chain, products }, ...t } as never } });

describe("予告の内部管理の集計（管理・診断画面）", () => {
  it("有効・延期・昇格・中止・終了を数え、通常の候補に出さない件数（hidden）は有効・延期の予告だけ", () => {
    const s = summarizeTeasers(
      [
        row({ announcement: "teaser", outcome: "active", startDate: "2026-11-23", lastJudgement: { state: "teaser", confidence: "medium", at: "x", reasons: [], toVerify: ["応募先（応募URL・フォーム）"] } }),
        row({ announcement: "teaser" }),
        row({ announcement: "teaser", outcome: "postponed" }),
        row({ announcement: "teaser", outcome: "promoted" }),
        row({ announcement: "teaser", outcome: "cancelled" }),
        row({ announcement: "teaser", outcome: "expired" }),
        { draft: {} },
        { draft: null },
      ],
      NOW,
    );
    expect(s).toMatchObject({ hidden: 3, active: 2, postponed: 1, promoted: 1, cancelled: 1, expired: 1, soon: 1 });
    expect(s.items).toHaveLength(3);
    expect(s.items[0]).toMatchObject({ chain: "テスト系列", product: "ハドウシーカー", toVerify: ["応募先（応募URL・フォーム）"] });
  });
  it("追跡の判断が無い古い追跡（announcement なし）は、通常どおり表示されるので hidden に含めない", () => {
    expect(summarizeTeasers([row({})], NOW).hidden).toBe(0);
  });
});
