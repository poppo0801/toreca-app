import { describe, expect, it } from "vitest";
import { assessOfficialSites } from "@/lib/agent/store-location/official";
import { verifyResearch, type PageEvidence, type StoreTarget } from "@/lib/agent/store-location/verify";

/** Stage 8D-5: 確認済み判定の安全方針（公式の情報源に店舗の住所があるときだけ確認済み。第三者の一致は候補止まり）。特定店舗の例外は無い */
const addr = "兵庫県神戸市中央区港町1-2-3";
const base: StoreTarget = { chain: "テスト家電", name: "テスト家電 港店", prefecture: "兵庫県", knownDomains: [], siblingNames: [] };
const pg = (url: string, title: string, extra = ""): PageEvidence => ({ url, finalUrl: url, title, text: `${title}\nテスト家電 港店\n住所 ${addr}\n${extra}`, links: [], injection: false });
const run = (store: StoreTarget, pages: PageEvidence[], closureHint: string | null = null) =>
  verifyResearch({ store, proposal: { candidates: pages.map((p) => ({ address: addr, sourceUrl: p.url, quote: `住所 ${addr}`, closureHint })) }, pages, geocode: async () => [{ title: addr, lat: 34.7, lng: 135.2 }] as never, limitReached: false });

describe("確認済みの安全方針", () => {
  it("公式（登録済み）の情報源に、店舗名と住所があれば確認済み", async () => {
    expect((await run({ ...base, knownDomains: ["official-kaden.test"] }, [pg("https://official-kaden.test/shop", "テスト家電 店舗")])).status).toBe("confirmed");
  });
  it("第三者サイト（地図・口コミ・まとめ）が何件一致しても、公式が無ければ確認済みにしない", async () => {
    const r = await run(base, [pg("https://map-a.test/x", "地図"), pg("https://review-b.test/y", "口コミ"), pg("https://matome-c.test/z", "まとめ")]);
    expect(r.status).toBe("candidate");
    expect(r.reasons.join()).toMatch(/転載の可能性/);
    expect(r.confidence).toBeLessThanOrEqual(45);
  });
  it("店舗マスターに登録されたサイトが第三者の一覧サイト（pokemon-card.com 等）でも、公式（trusted）にしない", async () => {
    const store = { ...base, knownDomains: ["map.pokemon-card.com", "machitoku.jp"] };
    const sites = assessOfficialSites({ store, pages: [pg("https://map.pokemon-card.com/map/1", "店舗検索")] });
    expect(sites.find((s) => s.domain === "pokemon-card.com")?.status).toBe("rejected");
    const r = await run(store, [pg("https://map.pokemon-card.com/map/1", "店舗検索")]);
    expect(r.status).toBe("candidate");
  });
  it("公式でも、閉店・移転の疑いがあれば確認済みにしない（AIの閉店ヒントを含む）", async () => {
    const store = { ...base, knownDomains: ["official-kaden.test"] };
    expect((await run(store, [pg("https://official-kaden.test/shop", "テスト家電", "※当店は2026年3月に閉店しました")])).status).not.toBe("confirmed");
    expect((await run(store, [pg("https://official-kaden.test/shop", "テスト家電")], "移転の可能性")).status).not.toBe("confirmed");
  });
  it("公式でも、同じ系列の別の店舗の住所は確認済みにしない（店舗の同一性）", async () => {
    const store = { ...base, siblingNames: ["テスト家電 山店"], knownDomains: ["official-kaden.test"] };
    const page: PageEvidence = { url: "https://official-kaden.test/list", finalUrl: "https://official-kaden.test/list", title: "テスト家電 店舗一覧", text: `テスト家電 店舗一覧\nテスト家電 山店\n住所 ${addr}\n`, links: [], injection: false };
    const r = await verifyResearch({ store, proposal: { candidates: [{ address: addr, sourceUrl: page.url, quote: `住所 ${addr}` }] }, pages: [page], geocode: async () => [{ title: addr, lat: 34.7, lng: 135.2 }] as never, limitReached: false });
    expect(r.status).not.toBe("confirmed");
  });
});
