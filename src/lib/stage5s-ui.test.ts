import { describe, expect, it } from "vitest";
import { createMockData } from "@/data/mock";
import { announceShort } from "@/lib/lottery-taxonomy";
import { DEFAULT_FILTERS, matchesQuery, selectLotteries } from "@/lib/lottery-view";
import type { AppData } from "@/types/domain";

const NOW = new Date("2026-11-04T03:00:00Z");
const base = (): AppData => createMockData(NOW);

describe("横断検索（商品・系列・店舗とそれぞれの別名）", () => {
  it("商品名・商品の別名・系列名・系列の別名・店舗名・店舗の別名のどれでも一致する", () => {
    const d = base();
    const l = d.lotteries[0];
    const chain = d.chains.find((c) => c.id === l.chainId)!;
    const store = d.stores.find((s) => s.id === l.storeId)!;
    const prod = d.products.find((p) => p.id === l.items[0].productId)!;
    d.chains = d.chains.map((c) => (c.id === chain.id ? { ...c, aliases: ["ＪＯＳＨＩＮ別名"] } : c));
    d.stores = d.stores.map((s) => (s.id === store.id ? { ...s, aliases: ["ストアぺんぎん"] } : s));
    d.products = d.products.map((p) => (p.id === prod.id ? { ...p, aliases: ["ぷろだくとあいらす"] } : p));
    for (const q of [prod.officialName, "ぷろだくとあいらす", chain.name, "joshin別名", store.name, "ストアぺんぎん"]) expect(matchesQuery(d, l, q), q).toBe(true);
  });
  it("全角半角・大文字小文字・空白の違いを吸収し、複数語はすべて一致が必要（AND）", () => {
    const d = base();
    const l = d.lotteries[0];
    const chain = d.chains.find((c) => c.id === l.chainId)!;
    const store = d.stores.find((s) => s.id === l.storeId)!;
    d.chains = d.chains.map((c) => (c.id === chain.id ? { ...c, aliases: ["Joshin"] } : c));
    expect(matchesQuery(d, l, "ＪＯＳＨＩＮ")).toBe(true);
    expect(matchesQuery(d, l, `joshin　${store.name}`)).toBe(true); // 全角空白区切りの複数語
    expect(matchesQuery(d, l, `joshin 存在しない語`)).toBe(false);
    expect(matchesQuery(d, l, "   ")).toBe(true);
  });
  it("検索は一覧の絞り込みの一部で、プロフィールの閲覧範囲（サブユーザーの対象系列）を回避できない", () => {
    const d = base();
    const [chainA, chainB] = d.chains;
    const sub = d.profiles[2];
    d.profiles = d.profiles.map((p) => (p.id === sub.id ? { ...p, kind: "sub" as const, allowedChainIds: [chainA.id] } : p));
    const other = d.lotteries.find((l) => l.chainId === chainB.id)!;
    const ids = selectLotteries(d, "all", { ...DEFAULT_FILTERS, status: "any", query: chainB.name }, NOW, sub.id).map((l) => l.id);
    expect(ids).not.toContain(other.id);
  });
});

describe("絞り込み: 店舗・応募方法", () => {
  it("店舗と応募方法を他の条件と組み合わせて絞り込める", () => {
    const d = base();
    const l = d.lotteries.find((x) => x.applyMethod === "web")!;
    const all = (f: Partial<typeof DEFAULT_FILTERS>) => selectLotteries(d, "all", { ...DEFAULT_FILTERS, status: "any", ...f }, NOW, d.profiles[0].id).map((x) => x.id);
    expect(all({ storeId: l.storeId })).toContain(l.id);
    expect(all({ storeId: l.storeId }).every((id) => d.lotteries.find((x) => x.id === id)!.storeId === l.storeId)).toBe(true);
    expect(all({ applyMethod: "web" }).every((id) => d.lotteries.find((x) => x.id === id)!.applyMethod === "web")).toBe(true);
    expect(all({ storeId: l.storeId, applyMethod: l.applyMethod === "web" ? "app" : "web" })).not.toContain(l.id);
  });
});

describe("当落発表方法の短い表示", () => {
  it("標準分類の主な方法を1語で（メール・アプリ・Web・店頭・SMS・X・電話・その他）。未確認は null", () => {
    expect(announceShort(["result_mail"])).toBe("メール");
    expect(announceShort(["winner_mail"])).toBe("当選者のみメール");
    expect(announceShort(["app"])).toBe("公式アプリ");
    expect(announceShort(["result_page"])).toBe("Web確認");
    expect(announceShort(["in_store"])).toBe("店頭掲示");
    expect(announceShort(["sms"])).toBe("SMS");
    expect(announceShort(["x_dm"])).toBe("X DM");
    expect(announceShort(["sns_post"])).toBe("SNS投稿"); // X・Instagramなどの投稿。DMとは区別し、Xの投稿と断定しない
    expect(announceShort(["phone"])).toBe("電話");
    expect(announceShort(["other"])).toBe("その他");
    expect(announceShort(["unknown"])).toBeNull();
    expect(announceShort(undefined)).toBeNull();
    expect(announceShort([])).toBeNull();
  });
});
