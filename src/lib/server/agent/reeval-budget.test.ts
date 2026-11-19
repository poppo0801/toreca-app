// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import type { ExistingLottery } from "@/lib/agent/reeval-ai/assess";

vi.mock("server-only", () => ({}));
const { reinvestigateLottery, BLOCKED_SOURCE_BUDGET_JPY } = await import("./reeval-ai-service");

const lot = (urls: string[]): ExistingLottery => ({ id: "l1", chain: "テスト", store: "本店", storeMode: "fixed", products: ["パック"], applyStart: null, applyDeadline: "2026-11-30", resultDate: null, sourceUrls: urls, humanFields: [] });
const result = { sources: [], fields: [], queries: [], extras: [], stopReason: "no_improvement" } as never;
const deps = (blocked: string[]) => {
  const investigate = vi.fn(async () => result);
  return { investigate, d: { investigate, blockedHosts: new Set(blocked), classify: { officialHosts: [], officialAccounts: [], aggregatorHosts: [], aggregatorAccounts: [] }, spentJpy: () => 0, stopped: () => null } as never };
};

describe("取得できない既知のホストだけを情報源とする再調査の費用（Stage 9X）", () => {
  it("登録済みの情報源がすべて、これまでに取得できなかったホストなら、費用の上限を小さくする（調査自体は行う）", async () => {
    const { investigate, d } = deps(["x.com"]);
    await reinvestigateLottery(d, lot(["https://x.com/shop/status/1"]), new Date("2026-11-19T00:00:00Z"));
    expect(investigate).toHaveBeenCalledWith(expect.anything(), { maxCostJpy: BLOCKED_SOURCE_BUDGET_JPY });
  });
  it("取得できる情報源を1つでも持つ・取得できないホストが未知・情報源が無いときは、通常の上限のまま", async () => {
    for (const [blocked, urls] of [[["x.com"], ["https://x.com/a/status/1", "https://shop.example.jp/lottery"]], [[], ["https://x.com/a/status/1"]], [["x.com"], []]] as const) {
      const { investigate, d } = deps([...blocked]);
      await reinvestigateLottery(d, lot([...urls]), new Date("2026-11-19T00:00:00Z"));
      expect(investigate).toHaveBeenCalledWith(expect.anything(), undefined);
    }
  });
});
