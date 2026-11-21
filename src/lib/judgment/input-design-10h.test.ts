// @vitest-environment node
/** Stage 10H: 自己登録（currentCase）の区別、保留基準、一覧投稿の分割の指示。実AIには接続しない。 */
import { describe, expect, it } from "vitest";
import { buildJudgmentInput } from "./build-input";
import { JUDGMENT_PROMPT_VERSION, JUDGMENT_SYSTEM } from "./prompt";

const evidence = [{ url: "https://evidence.invalid/1", via: "unknown", origin: "unknown" as const, text: "サンプル抽選 2099-04-08締切", hash: null, status: "fetched" as const, fetchedAt: null }];

describe("入力設計: 対象案件自身の登録は related に混ぜない", () => {
  it("currentCase は識別子・保護情報を持たず、related とは別に渡される", async () => {
    const cur = { chain: "サンプル系列", store: null, products: Array.from({ length: 12 }, (_, i) => `商品${i}`), applyStart: null, applyDeadline: "2099-04-08", resultDate: null, storeMode: "fixed" as const };
    const input = await buildJudgmentInput({ caseId: null, title: "", now: new Date("2099-04-01T00:00:00Z"), evidence, related: [], currentCase: cur, masters: [], failures: [], regionPrefectures: [] });
    expect(input.related).toEqual([]);
    expect(input.currentCase?.products).toHaveLength(10);
    const json = JSON.stringify(input.currentCase);
    for (const bad of ["lotteryId", "protectedCodes", "humanConfirmed", "household", "id\""]) expect(json).not.toContain(bad);
    const without = await buildJudgmentInput({ caseId: null, title: "", now: new Date(), evidence, related: [], masters: [], failures: [], regionPrefectures: [] });
    expect("currentCase" in without).toBe(false);
  });
});

describe("指示文: 保留基準・年の推定・一覧投稿・自己登録", () => {
  it("版が上がり、重要な不確実性を隠さず、自己照合を問わず、一覧を根拠なく1件にも分割にもしない指示がある", () => {
    expect(JUDGMENT_PROMPT_VERSION).toBe("10i.1");
    for (const s of ["currentCase", "同じ応募権か」とは問いません", "一覧・まとめ投稿", "安易に1つの応募とみなさず", "根拠なく分割もしない", "未解決事項（unresolved）の基準", "重要な不確実性を隠さない", "推定してよい", "リンクが原文に無いURLを作らない", "アクセス制限を回避しようとしない", "対象案件への焦点と、一覧の塊", "渡された項目だけ"]) expect(JUDGMENT_SYSTEM, s).toContain(s);
  });
});
