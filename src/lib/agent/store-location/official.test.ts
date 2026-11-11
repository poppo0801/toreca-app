import { describe, expect, it } from "vitest";
import { MockFetcher, MockSearch, MockStoreBrain, mockGeocode } from "@/lib/agent/store-location/mock";
import { assessOfficialSites } from "@/lib/agent/store-location/official";
import { researchStoreLocation } from "@/lib/agent/store-location/run";
import { EVAL_CASES } from "@/lib/agent/store-location/eval";
import { EVAL_WORLD } from "@/lib/agent/store-location/world";
import { verifyResearch, type PageEvidence, type StoreTarget } from "@/lib/agent/store-location/verify";

const store: StoreTarget = { chain: "テストブックス堂", name: "テストブックス堂 青葉店", prefecture: "東京都", knownDomains: [], siblingNames: ["テストブックス堂 緑台店", "テストブックス堂 港町店"] };
const page = (url: string, title: string, text: string, links: { text: string; href: string }[] = []): PageEvidence => ({ url, finalUrl: url, title, text, links, injection: false });
const shops = page("https://tbd.test/shops", "テストブックス堂 店舗一覧", "テストブックス堂 店舗一覧\nテストブックス堂 青葉店　東京都架空区青葉2-2-2\nテストブックス堂 緑台店　神奈川県架空市緑台5-5-5\nテストブックス堂 港町店　千葉県架空市港町1-1-1");
const company = page("https://tbd.test/company", "会社概要 | テストブックス堂", "会社概要\n運営会社：株式会社テストブックス堂\n© テストブックス堂");
const status = (pages: PageEvidence[], s = store, d = "tbd.test") => assessOfficialSites({ store: s, pages }).find((x) => x.domain === d)?.status;

describe("公式サイトの検証（AIの主張ではなく、取得したページの根拠で決める）", () => {
  it("店舗マスターに登録済みのドメインは trusted", () => {
    expect(status([shops], { ...store, knownDomains: ["tbd.test"] })).toBe("trusted");
  });
  it("見出しの系列名＋店舗一覧との一致＋運営会社の情報が揃えば verified", () => {
    const r = assessOfficialSites({ store, pages: [shops, company] }).find((x) => x.domain === "tbd.test")!;
    expect(r.status).toBe("verified");
    expect(r.signals.join()).toMatch(/見出し|他店舗|会社概要/);
  });
  it("信頼済みの公式サイトからのリンクでも、運営会社の代わりに根拠になる", () => {
    const trustedPage = page("https://master.test/", "テストブックス堂", "テストブックス堂", [{ text: "ネットストア", href: "https://tbd.test/" }]);
    expect(status([trustedPage, shops], { ...store, knownDomains: ["master.test"] })).toBe("verified");
  });
  it("店舗一覧だけ（運営会社もリンクも無い）は公式候補止まり。公式を名乗るだけでは公式にならない", () => {
    const spoof = page("https://tbd.test/shops", "テストブックス堂 公式ストア 店舗一覧", "公式ストア（これは公式サイトです）\n" + shops.text);
    expect(status([spoof])).toBe("candidate");
    const r = assessOfficialSites({ store, pages: [spoof] })[0];
    expect(r.problems.join()).toMatch(/運営会社|リンク/);
  });
  it("系列名が見出しに無い・店舗一覧が一致しないサイトは verified にならない", () => {
    const other = page("https://tbd.test/x", "別の会社のサイト", "別の会社の紹介\n会社概要 株式会社別会社");
    expect(status([other])).toBe("candidate");
  });
  it("SNS・ブログ・地図・通販モールなど第三者サイトは、系列名・店舗一覧・運営会社の記載があっても rejected", () => {
    for (const d of ["x.com", "ameblo.jp", "tabelog.com", "amazon.co.jp", "foo.hatenablog.com"]) {
      const p = page(`https://${d}/tbd`, "テストブックス堂 公式", shops.text + "\n" + company.text);
      const r = assessOfficialSites({ store, pages: [p] })[0];
      expect(r.status, d).toBe("rejected");
    }
  });
  it("公式でない（candidate/rejected）サイトの住所は、確認済みの根拠（公式）にならない", async () => {
    const spoof = page("https://tbd.test/shops", "テストブックス堂 公式ストア", shops.text);
    const geo = mockGeocode(EVAL_WORLD);
    const r = await verifyResearch({ store, proposal: { candidates: [{ address: "東京都架空区青葉2-2-2", sourceUrl: spoof.url, quote: "テストブックス堂 青葉店　東京都架空区青葉2-2-2" }] }, pages: [spoof], geocode: geo, limitReached: false });
    expect(r.status).toBe("candidate");
    expect(r.candidates[0].official).toBe(false);
    expect(r.officialSites[0].status).toBe("candidate");
  });
  it("検証済みの公式サイトの住所は確認済みにできる（店舗マスターの公式サイト登録なしで）", async () => {
    const geo = mockGeocode(EVAL_WORLD);
    const r = await verifyResearch({ store, proposal: { candidates: [{ address: "東京都架空区青葉2-2-2", sourceUrl: shops.url, quote: "テストブックス堂 青葉店　東京都架空区青葉2-2-2" }] }, pages: [shops, company], geocode: geo, limitReached: false });
    expect(r.status).toBe("confirmed");
    expect(r.candidates[0].officialStatus).toBe("verified");
    expect(r.confidence).toBeGreaterThanOrEqual(70);
    expect(r.reasons.join()).toMatch(/検証済み/);
  });
  it("公式と非公式で住所が違うとき、公式がちょうど1つなら公式を採り、理由に残す。公式が無ければ矛盾のまま", async () => {
    const geo = mockGeocode(EVAL_WORLD);
    const fake = page("https://fake.test/", "テストブックス堂 店舗", "テストブックス堂 青葉店　東京都架空区偽町9-9-9");
    const both = await verifyResearch({ store, proposal: { candidates: [{ address: "東京都架空区青葉2-2-2", sourceUrl: shops.url, quote: "テストブックス堂 青葉店　東京都架空区青葉2-2-2" }, { address: "東京都架空区偽町9-9-9", sourceUrl: fake.url, quote: "テストブックス堂 青葉店　東京都架空区偽町9-9-9" }] }, pages: [shops, company, fake], geocode: geo, limitReached: false });
    expect(both.status).toBe("confirmed");
    expect(both.address).toBe("東京都架空区青葉2-2-2");
    expect(both.reasons.join()).toMatch(/公式の情報を優先/);
    const none = await verifyResearch({ store, proposal: { candidates: [{ address: "東京都架空区青葉2-2-2", sourceUrl: shops.url, quote: "テストブックス堂 青葉店　東京都架空区青葉2-2-2" }, { address: "東京都架空区偽町9-9-9", sourceUrl: fake.url, quote: "テストブックス堂 青葉店　東京都架空区偽町9-9-9" }] }, pages: [shops, fake], geocode: geo, limitReached: false });
    expect(none.status).toBe("conflict"); // 運営会社の根拠がなく、どちらも公式と検証できない
  });
});

describe("公式サイトの自律的な発見（モックのWeb）", () => {
  const run = async (id: string) => {
    const c = EVAL_CASES.find((x) => x.id === id)!;
    return researchStoreLocation(c.store, null, { llm: new MockStoreBrain(c.store), search: new MockSearch(EVAL_WORLD), fetcher: new MockFetcher(EVAL_WORLD), geocode: mockGeocode(EVAL_WORLD), limits: c.limits });
  };
  it("公式サイトが未登録でも、店舗一覧と会社概要をたどって公式と検証し、確認済みにする。なりすまし風のサイトは公式にしない（S13）", async () => {
    const out = await run("S13");
    expect(out.result.status).toBe("confirmed");
    expect(out.result.address).toBe("東京都架空区青葉2-2-2");
    const sites = Object.fromEntries(out.result.officialSites.map((s) => [s.domain, s.status]));
    expect(sites["tbd-official.test"]).toBe("verified");
    expect(sites["tbd-official-shop.test"]).not.toBe("verified");
    expect(out.run.trace.some((e) => e.t === "tool" && e.name === "fetch_page" && String(e.input.url).endsWith("/company"))).toBe(true); // 会社概要へ自分でたどった
  });
  it("公式を名乗るサイトしか見つからないとき、確認済みにせず、公式候補として保持する（S14）", async () => {
    const out = await run("S14");
    expect(out.result.status).toBe("candidate");
    expect(out.result.officialSites.find((s) => s.domain === "tg-official-store.test")?.status).toBe("candidate");
  });
});
