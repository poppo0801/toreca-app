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
    expect(JUDGMENT_PROMPT_VERSION).toBe("10k.1");
    for (const s of ["currentCase", "同じ応募権か」とは問いません", "一覧・まとめ投稿", "安易に1つの応募とみなさず", "根拠なく分割もしない", "未解決事項（unresolved）の基準", "重要な不確実性を隠さない", "推定してよい", "リンクが原文に無いURLを作らない", "アクセス制限を回避しようとしない", "対象案件への焦点と、一覧の塊", "渡された項目だけ"]) expect(JUDGMENT_SYSTEM, s).toContain(s);
  });
});

describe("10J: 原文の種類・番号つきの塊・画像由来の登録値", () => {
  it("リンク先の本文は kind=linked_page として別の出典で渡る。番号つきの塊と画像由来の扱いの指示がある", async () => {
    const { seedsFromStored, toEvidenceItems } = await import("./build-input");
    const stored = { v: 1, url: "https://x.example/1", fetchedAt: "2099-01-01T00:00:00.000Z", via: "x_api" as const, origin: "unknown" as const, text: "架空TCG 抽選のお知らせ 詳細はリンク先", truncated: false, links: [], imageCount: 0, imageStatus: "none" as const, hash: "h", linkedPages: [{ url: "https://shop.example.com/a", text: "架空店の詳細。応募期間 2099-04-01〜04-08", fetchedAt: "2099-01-01T00:00:00.000Z" }] };
    const items = toEvidenceItems(seedsFromStored("https://x.example/1", stored as never));
    expect(items).toHaveLength(2);
    expect(items[0].kind).toBeUndefined();
    expect(items[1].kind).toBe("linked_page");
    expect(items[1].text).toContain("応募期間");
    expect(seedsFromStored("https://x.example/1", { ...stored, linkedPages: undefined } as never)).toHaveLength(1);
    for (const s of ["image_reading", "画像読み取りだけを根拠に fact にはしない", "linked_page", "番号つきの塊", "同じ文面でも、項目が別", "文面が同じだというだけで項目をまとめない", "fromImages"]) expect(JUDGMENT_SYSTEM, s).toContain(s);
  });
});

describe("10J: 画像由来の登録値の印", () => {
  it("取得済みの画像があった保存原文だけを画像由来の可能性ありとする（画像なし・未取得は false）", async () => {
    const { imageDerivedFlag } = await import("./build-input");
    expect(imageDerivedFlag({ imageCount: 2, imageStatus: "fetched" })).toBe(true);
    expect(imageDerivedFlag({ imageCount: 2, imageStatus: "partial" })).toBe(true);
    expect(imageDerivedFlag({ imageCount: 2, imageStatus: "not_fetched" })).toBe(false);
    expect(imageDerivedFlag({ imageCount: 0, imageStatus: "none" })).toBe(false);
    expect(imageDerivedFlag(null)).toBe(false);
  });
});
