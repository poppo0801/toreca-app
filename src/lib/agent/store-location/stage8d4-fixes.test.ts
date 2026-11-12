import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { extendsExpectedV2, matchesGold, matchesGoldV1 } from "@/lib/agent/store-location/eval";
import { assessOfficialSites } from "@/lib/agent/store-location/official";
import { REAL_GOLD, REAL_TARGETS } from "@/lib/agent/store-location/real-eval";
import { cleanAddress, verifyResearch, type PageEvidence } from "@/lib/agent/store-location/verify";

/**
 * Stage 8D-4 の初回評価（実API・30店舗）で見つかった、検証・採点側の汎用的な不備の回帰テスト（保存した実ページを使用。有料APIなし）。
 * 特定店舗専用の例外ではなく、郵便番号つきの住所・店舗一覧ページでの隣の店舗の記載・語順の違う店舗名・公式サイトからの転送・採点の境界を扱う。
 */
const fx = JSON.parse(readFileSync("src/lib/agent/store-location/fixtures/stage8d4-pages.json", "utf8")) as Record<string, { url: string; finalUrl: string; title: string; text: string }>;
const page = (k: string, over: Partial<PageEvidence> = {}): PageEvidence => ({ ...fx[k], links: [], injection: false, ...over });
const store = (id: string) => REAL_TARGETS.find((t) => t.id === id)!.store;
const geo = async (q: string) => [{ title: q, lat: 35.1, lng: 135.1 }] as never;
const run = (id: string, pages: PageEvidence[], address: string, url: string, quote: string) => verifyResearch({ store: store(id), proposal: { candidates: [{ address, sourceUrl: url, quote }] }, pages, geocode: geo, limitReached: false });

describe("郵便番号つきの住所（N07・N13・N15・N16 の原因）", () => {
  it("先頭の「〒561-0821」・末尾の「（〒518-0441）」・「〒」なしの先頭の郵便番号を取り除く。住所の本体は変えない", () => {
    expect(cleanAddress("〒561-0821 大阪府豊中市日出町2‐2‐18 エディオン豊中店 3F")).toBe("大阪府豊中市日出町2‐2‐18 エディオン豊中店 3F");
    expect(cleanAddress("三重県名張市夏見3303（〒518-0441）")).toBe("三重県名張市夏見3303");
    expect(cleanAddress("518-0441 三重県名張市夏見3303")).toBe("三重県名張市夏見3303");
    expect(cleanAddress("東京都新宿区西新宿1-10-2 110ビル3F")).toBe("東京都新宿区西新宿1-10-2 110ビル3F"); // 番地・建物名は変えない
  });
  it("郵便番号つきで提案されても「住所が揃っていない」と誤判定せず、郵便番号なしの住所として保存する（実ページ: カードボックス名張店）", async () => {
    const r = await run("N16", [page("cardbox_dm")], "〒518-0441 三重県名張市夏見3303", "https://cardbox.nextone-iga.co.jp/dmstore/", "名張店 〒518-0441 三重県名張市夏見3303");
    expect(r.candidates[0].problems.join()).not.toMatch(/揃っていない/);
    expect(r.address).toBe("三重県名張市夏見3303");
    expect(r.status).toBe("confirmed"); // 公式（登録済み）の店舗一覧に店舗名と番地までの住所
  });
});

describe("店舗一覧ページでの閉店・移転の判定（隣の店舗の記載を取り違えない）", () => {
  it("同じ一覧にある別の店舗の「移転オープン」を、名張店の閉店・移転と誤検出しない（実ページ: カードボックス）", async () => {
    const r = await run("N16", [page("cardbox_dm")], "三重県名張市夏見3303", "https://cardbox.nextone-iga.co.jp/dmstore/", "名張店 〒518-0441 三重県名張市夏見3303");
    expect(r.candidates[0].closure).toBe(false);
  });
  it("その店舗自身の記載にある「移転オープン」（広島店）は、引き続き確認が必要として扱う（安全側）", async () => {
    const r = await run("N17", [page("cardbox_dm")], "広島県広島市中区大手町1-4-32", "https://cardbox.nextone-iga.co.jp/dmstore/", "広島店 〒730-0051 広島県 広島市中区大手町1-4-32 大手町ビル1階");
    expect(r.candidates[0].closure).toBe(true);
    expect(r.status).not.toBe("confirmed");
  });
  it("カードラボの一覧で、なんば店の「移転しております」が、大阪日本橋店の閉店・移転と誤検出されない（実ページ）", async () => {
    const r = await run("N13", [page("clabo_list")], "大阪府大阪市浪速区日本橋西1-1-3 池田ビル2号館 5F", "https://www.c-labo.jp/shop/", "大阪日本橋店 〒556-0004 大阪府大阪市浪速区日本橋西1-1-3 池田ビル2号館 5F");
    expect(r.candidates[0].closure).toBe(false);
    const own = await run("N11", [page("clabo_list")], "大阪府大阪市浪速区日本橋3-8-16 安田ビル 1F", "https://www.c-labo.jp/shop/", "なんば店 556-0005 大阪府大阪市浪速区日本橋3-8-16 安田ビル 1F （B1から1Fに移転しております）");
    expect(own.candidates[0].closure).toBe(true); // 自分の記載の「移転」は検出する
  });
});

describe("店舗名の照合（語順の違う表記）と公式サイトからの転送", () => {
  it("「マルイ海老名店」と、ページの「海老名マルイ」を同じ店舗と判定する。別の店舗名は一致しない（実ページ: カードラボ海老名）", async () => {
    const ok = await run("N09", [page("clabo_ebina")], "神奈川県海老名市中央1-6-1 海老名マルイ5F", "https://www.c-labo.jp/shop/ebina/", "神奈川県海老名市中央1-6-1 海老名マルイ 5F");
    expect(ok.candidates[0].nameMatch).toBe(true);
    // 別の店舗（川崎店）の名前で、同じページの住所は、店舗名が近くにないので一致しない
    const other = await run("N10", [page("clabo_ebina")], "神奈川県海老名市中央1-6-1 海老名マルイ5F", "https://www.c-labo.jp/shop/ebina/", "神奈川県海老名市中央1-6-1 海老名マルイ 5F");
    expect(other.candidates[0].nameMatch).toBe(false);
  });
  it("登録済みの公式サイトが別のドメインへ転送された場合、転送先を公式（検証済み）とする。登録も転送もないドメインは公式にしない（実ページ: カードボックス → cardbox.online）", async () => {
    const redirected = page("cardbox_yoko", { url: "https://cardbox.nextone-iga.co.jp/cb_yokohama3/", finalUrl: "https://cardbox.online/shop/detail/5034/" });
    const s = assessOfficialSites({ store: store("N14"), pages: [redirected] });
    expect(s.find((x) => x.domain === "cardbox.online")?.status).toBe("verified");
    const notRegistered = assessOfficialSites({ store: { ...store("N14"), knownDomains: [] }, pages: [redirected] });
    expect(notRegistered.find((x) => x.domain === "cardbox.online")?.status).not.toBe("verified");
  });
});

describe("採点の改訂（正解データは変えない）", () => {
  const g = (id: string) => REAL_GOLD.find((x) => x.id === id)!;
  it("郵便番号つき・建物名が数字で始まる（110ビル）・建物名に漢数字（二子玉川ライズ）の住所は、番地まで合えば正しい。旧採点では誤りとされた", () => {
    for (const [id, addr] of [["N06", "東京都新宿区西新宿1-10-2 110ビル3F～6F"], ["N19", "東京都世田谷区玉川2-21-1 二子玉川ライズ・ショッピングセンター タウンフロント 6階"], ["N16", "〒518-0441 三重県名張市夏見3303"], ["N07", "〒561-0821 大阪府豊中市日出町2‐2‐18 エディオン豊中店 3F"]] as const) {
      expect(matchesGold(addr, g(id)), id).toBe(true);
      expect(matchesGoldV1(addr, g(id)), `${id}（旧採点）`).toBe(false);
    }
  });
  it("番地の続き・町名だけ・別の店舗の住所は、引き続き誤り", () => {
    expect(extendsExpectedV2("東京都新宿区西新宿1-10-20 110ビル", "東京都新宿区西新宿1-10-2")).toBe(false);
    expect(extendsExpectedV2("東京都新宿区西新宿1-10-2", "東京都新宿区西新宿1-10-2")).toBe(true);
    expect(matchesGold("東京都新宿区西新宿", g("N06"))).toBe(false);
    expect(matchesGold("東京都大田区蒲田5丁目18-5 下川ビル6F", g("N05"))).toBe(false); // 同名に近い別店（Japan TCG Center）
    expect(matchesGold("大阪府大阪市浪速区日本橋3-8-16 安田ビル 1F", g("N13"))).toBe(false); // 近い名前の別店舗（なんば店）
  });
});

