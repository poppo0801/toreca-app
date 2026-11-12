import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { REAL_TARGETS } from "@/lib/agent/store-location/real-eval";
import { addressCore, verifyResearch, type PageEvidence, type StoreTarget } from "@/lib/agent/store-location/verify";

/**
 * Stage 8D-5 の初回評価（実API・未知30店舗）で見つかった、検証層の汎用的な不備の回帰テスト（保存した実ページを使用。有料APIなし）。
 * 営業時間の説明の「閉店」・日付/お知らせから始まる引用・建物名の表記ゆれによる偽の矛盾・「本店」の店舗名の照合。特定店舗の例外は無い。
 */
const fx = JSON.parse(readFileSync("src/lib/agent/store-location/fixtures/stage8d5-pages.json", "utf8")) as Record<string, { url: string; finalUrl: string; title: string; text: string }>;
const page = (k: string): PageEvidence => ({ ...fx[k], links: [], injection: false });
const store = (id: string) => REAL_TARGETS.find((t) => t.id === id)!.store;
const geo = async (q: string) => [{ title: q, lat: 35.1, lng: 135.1 }] as never;
const run = (id: string, pages: PageEvidence[], cands: { address: string; url: string; quote: string }[]) =>
  verifyResearch({ store: store(id), proposal: { candidates: cands.map((c) => ({ address: c.address, sourceUrl: c.url, quote: c.quote })) }, pages, geocode: geo, limitReached: false });

describe("営業時間の説明の「閉店」は店舗の閉店ではない（P16）", () => {
  it("「閉店1時間前の19時まで」を閉店・移転と誤検出しない（実ページ: カードラボ姫路店）", async () => {
    const r = await run("P16", [page("clabo_himeji")], [{ address: "兵庫県姫路市東駅前町54 ハリマセンタービル 3F", url: "https://www.c-labo.jp/shop/himeji/", quote: "〒670-0926 兵庫県姫路市東駅前町54 ハリマセンタービル 3F" }]);
    expect(r.candidates[0].closure).toBe(false);
  });
  it("実際の閉店の記載は引き続き検出する", async () => {
    const p: PageEvidence = { url: "https://x.test/a", finalUrl: "https://x.test/a", title: "カードラボ 姫路店", text: "カードラボ 姫路店\n住所 兵庫県姫路市東駅前町54 ハリマセンタービル 3F\n当店は2026年3月に閉店しました", links: [], injection: false };
    const r = await run("P16", [p], [{ address: "兵庫県姫路市東駅前町54", url: p.url, quote: "住所 兵庫県姫路市東駅前町54 ハリマセンタービル 3F" }]);
    expect(r.candidates[0].closure).toBe(true);
  });
});

describe("日付・お知らせから始まる引用を別系列と誤判定しない（P10）", () => {
  it("「2026/3/28移転オープン 京都店 …」の引用でも、別の系列の可能性とは判定しない。移転の記載は安全側で確認が必要のまま（実ページ: カードボックス）", async () => {
    const r = await run("P10", [page("cardbox_dm")], [{ address: "京都府京都市下京区七条通烏丸東入真苧屋町214番地 京都駅前第5ビル 3階", url: "https://cardbox.nextone-iga.co.jp/dmstore/", quote: "2026/3/28移転オープン 京都店 〒600-8211 京都府京都市下京区七条通烏丸東入真苧屋町214番地 京都駅前第5ビル 3階" }]);
    expect(r.candidates[0].problems.join()).not.toMatch(/別の系列/);
    expect(r.candidates[0].nameMatch).toBe(true);
    expect(r.candidates[0].closure).toBe(true); // 移転オープンの記載は、現在の住所の確認が必要（人が確認する）
    expect(r.status).not.toBe("confirmed");
  });
});

describe("建物名・階数の表記ゆれで矛盾にしない（P17）", () => {
  it("番地までの比較（addressCore）: 「North 2階」と「North 2F」は同じ場所。番地が違えば別の場所", () => {
    expect(addressCore("千葉県習志野市津田沼1-23-1 イオンモール津田沼North 2階")).toBe(addressCore("千葉県習志野市津田沼1丁目23-1 イオンモール津田沼North 2F"));
    expect(addressCore("三重県名張市夏見3303")).toBe(addressCore("〒518-0441 三重県名張市夏見3303 ○○ビル"));
    expect(addressCore("千葉県習志野市津田沼1-23-1")).not.toBe(addressCore("千葉県習志野市津田沼1-23-10"));
  });
  it("同じ番地で建物名・階数の書き方だけ違う2つの情報源は、矛盾（conflict）にしない", async () => {
    const a: PageEvidence = { url: "https://www.c-labo.jp/shop/tsudanuma/", finalUrl: "https://www.c-labo.jp/shop/tsudanuma/", title: "カードラボ 津田沼店", text: "カードラボ 津田沼店\n〒275-0016 千葉県習志野市津田沼1-23-1 イオンモール津田沼North 2階\n", links: [], injection: false };
    const b: PageEvidence = { url: "https://map.example.test/12237", finalUrl: "https://map.example.test/12237", title: "カードラボ 津田沼店", text: "カードラボ 津田沼店\n千葉県習志野市津田沼1-23-1 イオンモール津田沼North 2F\n", links: [], injection: false };
    const r = await run("P17", [a, b], [
      { address: "千葉県習志野市津田沼1-23-1 イオンモール津田沼North 2階", url: a.url, quote: "千葉県習志野市津田沼1-23-1 イオンモール津田沼North 2階" },
      { address: "千葉県習志野市津田沼1-23-1 イオンモール津田沼North 2F", url: b.url, quote: "千葉県習志野市津田沼1-23-1 イオンモール津田沼North 2F" },
    ]);
    expect(r.status).not.toBe("conflict");
    expect(r.status).toBe("candidate"); // 第三者・公式未検証の一致だけなので候補止まり
    // 本当に別の番地は、引き続き矛盾
    const c: PageEvidence = { ...b, url: "https://map2.example.test/1", finalUrl: "https://map2.example.test/1", text: "カードラボ 津田沼店\n千葉県習志野市津田沼1-23-10\n" };
    const d = await run("P17", [a, c], [
      { address: "千葉県習志野市津田沼1-23-1 イオンモール津田沼North 2階", url: a.url, quote: "千葉県習志野市津田沼1-23-1 イオンモール津田沼North 2階" },
      { address: "千葉県習志野市津田沼1-23-10", url: c.url, quote: "千葉県習志野市津田沼1-23-10" },
    ]);
    expect(d.status).toBe("conflict");
  });
});

describe("「〜本店」の店舗名の照合（P18）", () => {
  it("住所の近くに「本店」が無くても、店舗を見分ける語の本体（秋葉原ラジオ会館）が近くにあれば同じ店舗（実ページ: カードラボ秋葉原）", async () => {
    const r = await run("P18", [page("clabo_radio")], [{ address: "東京都千代田区外神田1-15-16 秋葉原ラジオ会館9F", url: "https://www.c-labo.jp/shop/radiohonten/", quote: "〒101-0021 東京都千代田区外神田1-15-16 秋葉原ラジオ会館9F" }]);
    expect(r.candidates[0].nameMatch).toBe(true);
  });
  it("短い語（日本橋本店→日本橋）では緩めない。別の店舗名は一致しない", async () => {
    const st: StoreTarget = { chain: "テスト", name: "日本橋本店", prefecture: "大阪府", knownDomains: [], siblingNames: ["日本橋2号店"] };
    const p: PageEvidence = { url: "https://x.test/a", finalUrl: "https://x.test/a", title: "テスト", text: "テスト 日本橋2号店\n住所 大阪府大阪市浪速区日本橋1-1-1\n", links: [], injection: false };
    const r = await verifyResearch({ store: st, proposal: { candidates: [{ address: "大阪府大阪市浪速区日本橋1-1-1", sourceUrl: p.url, quote: "住所 大阪府大阪市浪速区日本橋1-1-1" }] }, pages: [p], geocode: geo, limitReached: false });
    expect(r.candidates[0].nameMatch).toBe(false);
  });
});
