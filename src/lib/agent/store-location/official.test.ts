import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { MockFetcher, MockSearch, MockStoreBrain, mockGeocode } from "@/lib/agent/store-location/mock";
import { assessOfficialSites } from "@/lib/agent/store-location/official";
import { parseProposal, researchStoreLocation } from "@/lib/agent/store-location/run";
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

describe("実サイトの回帰（Stage 8D-3 R1: 住所の地名が店舗名の語と同じ）", () => {
  const kStore: StoreTarget = { chain: "キデイランド", name: "吉祥寺店", prefecture: "東京都", knownDomains: [], siblingNames: ["二子玉川店", "三宮店", "神戸店"], chainAliases: ["KIDDY LAND"] };
  const kPage = page("https://www.kiddyland.co.jp/shoplist/kichijyouji/", "キデイランド吉祥寺店 | キデイランドへようこそ！", "キデイランドへようこそ！ > ショップリスト > キデイランド吉祥寺店\n\nキデイランド吉祥寺店\n\n郵便番号\n〒 180-0004\n\n住所\n東京都武蔵野市吉祥寺本町1-11-5 コピス吉祥寺 6階/A館\n\nTEL\n0422-29-2150");
  const geo = async () => [{ title: "東京都武蔵野市吉祥寺本町1丁目11-5", lat: 35.7, lng: 139.58 }] as never;
  for (const quote of ["住所\n東京都武蔵野市吉祥寺本町1-11-5 コピス吉祥寺 6階/A館", "東京都武蔵野市吉祥寺本町1-11-5", "キデイランド吉祥寺店\n\n郵便番号\n〒 180-0004\n\n住所\n東京都武蔵野市吉祥寺本町1-11-5 コピス吉祥寺 6階/A館"]) {
    it(`引用が住所から始まっても別系列と誤判定しない: ${quote.slice(0, 12)}…`, async () => {
      const r = await verifyResearch({ store: kStore, proposal: { candidates: [{ address: "東京都武蔵野市吉祥寺本町1-11-5", sourceUrl: kPage.url, quote }] }, pages: [kPage], geocode: geo, limitReached: false });
      expect(r.candidates[0].problems).toEqual([]);
      expect(r.candidates[0].nameMatch).toBe(true);
    });
  }
});

describe("実サイトの回帰（Stage 8D-3 R2: ふるいち 竹の塚店。公式の実ページ）", () => {
  const raw = JSON.parse(readFileSync("src/lib/agent/store-location/fixtures/furu1-takenotsuka.json", "utf8")) as Record<string, PageEvidence>;
  const pages: PageEvidence[] = Object.values(raw).map((p) => ({ ...p, injection: false }));
  const fStore: StoreTarget = { chain: "ふるいち", name: "竹の塚店", prefecture: "東京都", knownDomains: [], siblingNames: ["鶴見店","泉大津店","魚住店","深井店","イオンモール神戸北店","西神戸店","イオンモールりんくう泉南店","三宮店","三田店","宝塚店","富田林店","川西店","庄内店","灘店","イオンモール伊丹店","名谷店","野口店","香里園店","門真店","小平店","高野店","原山台店","中百舌鳥店","南茨木店","東住吉店","猪名寺店","緑橋店","西淀川店","西宮店","千里丘店"], chainAliases: ["古本市場"] };
  const url = "https://www.furu1.net/shop/_1106/shop12.html";
  const geo = async () => [{ title: "東京都足立区東伊興1丁目16-9", lat: 35.8, lng: 139.78 }] as never;
  const run = (quote: string) => verifyResearch({ store: fStore, proposal: { candidates: [{ address: "東京都足立区東伊興1-16-9", sourceUrl: url, quote }] }, pages, geocode: geo, limitReached: false });

  it("営業時間の「営業中 / 営業終了 22:00」とオンラインストアの閉店は、店舗の閉店ではない", async () => {
    const r = await run("住所 東京都足立区東伊興１-１６-９");
    expect(r.candidates[0].problems.join()).not.toMatch(/閉店/);
  });
  it("運営法人の名前が系列名と違っても、フッターの会社概要＋法人名で公式サイトを検証できる", async () => {
    const r = await run("住所 東京都足立区東伊興１-１６-９");
    expect(r.officialSites.find((s) => s.domain === "furu1.net")?.status).toBe("verified");
    expect(r.status).toBe("confirmed");
    expect(r.address).toBe("東京都足立区東伊興1-16-9");
  });
  it("引用が「見出し … 住所」のようにつながれていても、住所を含む部分が本文に実在すれば、その部分だけを根拠にする", async () => {
    const r = await run("古本市場竹の塚店|古本市場 ふるいち店舗情報サイト … 東京都足立区東伊興１-１６-９");
    expect(r.candidates[0].quoteVerified).toBe(true);
    expect(r.status).toBe("confirmed");
  });
  it("つながれた引用でも、住所を含む部分が本文に無ければ（作り話）採用しない", async () => {
    const r = await run("古本市場竹の塚店 … 東京都足立区東伊興9-9-9");
    expect(r.candidates[0].quoteVerified).toBe(false);
    expect(r.status).not.toBe("confirmed");
  });
  it("同じ公式の一覧にある別店舗の住所（滑川店）や、本文に無い誤住所は、竹の塚店の住所として採用しない", async () => {
    const other = await verifyResearch({ store: fStore, proposal: { candidates: [{ address: "富山県滑川市上小泉2829番地", sourceUrl: "https://www.furu1.net/shop.html", quote: "住所 富山県滑川市上小泉2829番地明文堂書店滑川店・店内" }] }, pages, geocode: geo, limitReached: false });
    expect(other.status).not.toBe("confirmed");
    expect(other.address).not.toBe("富山県滑川市上小泉2829番地");
    const fake = await run("住所 東京都足立区東伊興1-16-90");
    expect(fake.status).not.toBe("confirmed");
  });
});

describe("実サイトの回帰（Stage 8D-3 R5: 改行で分かれた住所・提出形式）", () => {
  const raw = JSON.parse(readFileSync("src/lib/agent/store-location/fixtures/alto-kobe.json", "utf8")) as PageEvidence;
  const aPage: PageEvidence = { ...raw, injection: false };
  const aStore: StoreTarget = { chain: "買取アルト", name: "ライフ神戸店", prefecture: "兵庫県", knownDomains: [], siblingNames: [] };
  const geo = async () => [{ title: "兵庫県神戸市兵庫区吉田町2丁目38-10", lat: 34.65, lng: 135.17 }] as never;
  const run = (address: string, quote: string) => verifyResearch({ store: aStore, proposal: { candidates: [{ address, sourceUrl: aPage.url, quote }] }, pages: [aPage], geocode: geo, limitReached: false });

  it("引用が住所の後半だけ（改行で分かれた行）でも、直前直後の本文に住所全体が実在すれば採用できる。ただし公式を検証できないので確認済みにはしない", async () => {
    const r = await run("兵庫県神戸市兵庫区吉田町2丁目38-10", "2丁目38-10");
    expect(r.candidates[0].addressInQuote).toBe(true);
    expect(r.status).toBe("candidate");
    expect(r.address).toBe("兵庫県神戸市兵庫区吉田町2丁目38-10");
  });
  it("同じ引用でも、本文の近くに無い住所（同じ系列の別店舗や誤住所）は採用しない", async () => {
    const other = await run("兵庫県尼崎市立花町1丁目26-12", "2丁目38-10");
    expect(other.candidates[0].addressInQuote).toBe(false);
    expect(other.status).not.toBe("confirmed");
    expect(other.address).not.toBe("兵庫県尼崎市立花町1丁目26-12");
    const fake = await run("兵庫県神戸市兵庫区吉田町2丁目99-99", "2丁目38-10");
    expect(fake.address).toBeNull();
  });
});

describe("AIの提出の解釈（parseProposal）", () => {
  const ok = { address: "東京都架空区1-2-3", sourceUrl: "https://x.test/a", quote: "東京都架空区1-2-3" };
  it("長すぎる要約・ヒント・引用は切り詰めて受け入れる（提出全体を捨てない）", () => {
    const r = parseProposal({ candidates: [{ ...ok, quote: "あ".repeat(600), closureHint: "い".repeat(500) }], summary: "う".repeat(900) });
    expect(r.proposal?.candidates).toHaveLength(1);
    expect(r.proposal?.candidates[0].quote.length).toBe(400);
    expect(r.proposal?.summary?.length).toBe(500);
  });
  it("不正な候補だけを捨て、有効な候補は残す。全て不正なら提案なし", () => {
    const r = parseProposal({ candidates: [ok, { address: "", sourceUrl: "x", quote: "y" }, 5] });
    expect(r.proposal?.candidates).toHaveLength(1);
    expect(r.invalid).toBe(2);
    expect(parseProposal({ candidates: [{ foo: 1 }] }).proposal).toBeNull();
    expect(parseProposal("text").proposal).toBeNull();
    expect(parseProposal({ candidates: [] }).proposal?.candidates).toEqual([]);
  });
});
