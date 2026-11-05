import { describe, expect, it } from "vitest";
import { judgeTcg, otherTcgItemIndexes } from "@/lib/collector/category";
import { evaluateCandidate, normalizeConditions } from "@/lib/collector/conditions";
import { judgeRelevance } from "@/lib/collector/listing";
import { identifyAccount, identityHint, parseAccountName, prefectureFromProfile, prefectureInText } from "@/lib/collector/store-identity";
import { parseXPosts } from "@/lib/collector/x-posts";
import type { LotteryInput } from "@/lib/lottery-input";
import type { Chain, Store } from "@/types/domain";

const NOW = new Date("2026-11-05T03:00:00Z");
const tsutaya: Chain = { id: "c-tsu", name: "TSUTAYA", aliases: ["ツタヤ"] };
const geo: Chain = { id: "c-geo", name: "GEO", aliases: ["ゲオ"] };
const store = (id: string, chainId: string, name: string, prefecture: string): Store => ({ id, chainId, name, prefecture });

describe("Stage 6H: Xアカウントの表示名から系列・店舗を読み取る", () => {
  const chains = [tsutaya, geo];
  it("TSUTAYA竹原店・TSUTAYA瀬戸店", () => {
    expect(parseAccountName("TSUTAYA 竹原店", "tsutayatakehara", chains)).toEqual({ kind: "store", chainName: "TSUTAYA", storeName: "竹原店" });
    expect(parseAccountName("TSUTAYA瀬戸店", "seto_tsutaya_t", chains)).toEqual({ kind: "store", chainName: "TSUTAYA", storeName: "瀬戸店" });
    expect(parseAccountName("TSUTAYA 瀬戸店【公式】", "seto_tsutaya_t", chains).storeName).toBe("瀬戸店");
  });
  it("マスターに無い系列でも目印（ゲオ・ツタヤ）で系列名をそろえる。系列だけの公式アカウントは店舗を確定しない", () => {
    expect(parseAccountName("ゲオ梅田店", "geo_umeda", [])).toMatchObject({ kind: "store", chainName: "GEO", storeName: "梅田店" });
    expect(parseAccountName("TSUTAYA公式", "tsutaya_official", chains)).toMatchObject({ kind: "chain", chainName: "TSUTAYA", storeName: "" });
  });
  it("抽選まとめ・情報アカウントは店舗として扱わない", () => {
    expect(parseAccountName("ポケカ抽選情報まとめ", "pokecachan", chains).kind).toBe("aggregator");
    expect(parseAccountName("TSUTAYA 抽選まとめ", "tsutaya_matome", chains).kind).toBe("aggregator");
  });
  it("表示名が無い・系列が読めないときは何も確定しない", () => {
    expect(parseAccountName("", "tsutayatakehara", chains).kind).toBe("unknown");
    expect(parseAccountName("ほげ店", "hoge", chains).kind).toBe("unknown");
  });
});

describe("Stage 6H: 所在地（都道府県）の根拠", () => {
  it("文章に明記された都道府県だけを使う。複数・無しは空", () => {
    expect(prefectureInText("広島県竹原市中央1-1")).toBe("広島県");
    expect(prefectureInText("大阪府・兵庫県で営業")).toBe("");
    expect(prefectureInText("竹原店")).toBe("");
  });
  it("プロフィール: 所在地欄を優先。自己紹介は住所らしい記載（郵便番号・番地）のときだけ", () => {
    expect(prefectureFromProfile({ name: "x", location: "広島県竹原市", description: "" })).toBe("広島県");
    expect(prefectureFromProfile({ name: "x", location: "", description: "〒725-0026 広島県竹原市中央2-1-1" })).toBe("広島県");
    expect(prefectureFromProfile({ name: "x", location: "", description: "大阪府の情報もお届け" })).toBe("");
    expect(prefectureFromProfile(undefined)).toBe("");
  });
  const chains = [tsutaya];
  it("マスターに店舗があれば、そのIDと都道府県を使う", () => {
    const stores = [store("s1", "c-tsu", "竹原店", "広島県")];
    const id = identifyAccount({ username: "tsutayatakehara", profile: { name: "TSUTAYA 竹原店", location: "", description: "" }, chains, stores });
    expect(id).toMatchObject({ kind: "store", chainId: "c-tsu", storeId: "s1", prefecture: "広島県", prefectureBasis: "master", storeBasis: "master" });
  });
  it("マスターに無い店舗: 店舗名は表示名から、都道府県はプロフィールに明記があるときだけ。無ければ未確認（推測しない）", () => {
    const withLoc = identifyAccount({ username: "tsutayatakehara", profile: { name: "TSUTAYA 竹原店", location: "広島県竹原市", description: "" }, chains, stores: [] });
    expect(withLoc).toMatchObject({ storeId: null, storeName: "竹原店", prefecture: "広島県", prefectureBasis: "profile", storeBasis: "name" });
    const noLoc = identifyAccount({ username: "seto_tsutaya_t", profile: { name: "TSUTAYA 瀬戸店", location: "", description: "" }, chains, stores: [] });
    expect(noLoc).toMatchObject({ storeName: "瀬戸店", prefecture: "", prefectureBasis: "" });
  });
  it("同名の店舗が複数あるときは決めない。プロフィールの所在地で1つに絞れるときだけ確定する", () => {
    const stores = [store("s1", "c-tsu", "瀬戸店", "愛知県"), store("s2", "c-tsu", "瀬戸店", "岡山県")];
    const amb = identifyAccount({ username: "seto_tsutaya_t", profile: { name: "TSUTAYA 瀬戸店", location: "", description: "" }, chains, stores });
    expect(amb).toMatchObject({ storeId: null, storeBasis: "ambiguous", prefecture: "" });
    const narrowed = identifyAccount({ username: "seto_tsutaya_t", profile: { name: "TSUTAYA 瀬戸店", location: "愛知県瀬戸市", description: "" }, chains, stores });
    expect(narrowed).toMatchObject({ storeId: "s1", prefecture: "愛知県", storeBasis: "master" });
  });
  it("マスターの都道府県とプロフィールの所在地が食い違うときは確定しない", () => {
    const stores = [store("s1", "c-tsu", "瀬戸店", "愛知県")];
    const id = identifyAccount({ username: "seto_tsutaya_t", profile: { name: "TSUTAYA 瀬戸店", location: "岡山県瀬戸内市", description: "" }, chains, stores });
    expect(id.storeId).toBeNull();
    expect(id.prefecture).toBe("");
    expect(id.notes.join()).toContain("異なります");
  });
  it("まとめアカウントの対応づけは使わない。確認済みの対応づけは表示名が取れなくても再利用する", () => {
    const saved = { username: "tsutayatakehara", chainName: "TSUTAYA", storeName: "竹原店", chainId: "c-tsu", storeId: null, prefecture: "広島県", basis: "profile" };
    const reuse = identifyAccount({ username: "tsutayatakehara", chains, stores: [], saved });
    expect(reuse).toMatchObject({ storeName: "竹原店", prefecture: "広島県", prefectureBasis: "saved", storeBasis: "saved" });
    const agg = identifyAccount({ username: "tsutayatakehara", profile: { name: "ポケカ抽選まとめ", location: "", description: "" }, chains, stores: [], saved });
    expect(agg.kind).toBe("aggregator");
  });
  it("告知から読み取れた系列・店舗・都道府県は上書きせず、読めなかった項目だけ補う（補った項目を返す）", () => {
    const id = identifyAccount({ username: "tsutayatakehara", profile: { name: "TSUTAYA 竹原店", location: "広島県竹原市", description: "" }, chains, stores: [] });
    const filled = identityHint({ chainName: "", storeName: "", prefecture: "" }, id);
    expect(filled).toMatchObject({ chainName: "TSUTAYA", storeName: "竹原店", prefecture: "広島県" });
    expect(filled.used.length).toBe(3);
    const kept = identityHint({ chainName: "GEO", storeName: "梅田店", prefecture: "大阪府" }, id);
    expect(kept).toMatchObject({ chainName: "GEO", storeName: "梅田店", prefecture: "大阪府" });
    expect(kept.used).toEqual([]);
  });
});

describe("Stage 6H: ポケモンカード以外の商品の除外", () => {
  it("明確な他TCGは other。複数TCGの案内は mixed。種別が分からないだけでは unknown", () => {
    expect(judgeTcg(["ONE PIECEカードゲーム 新弾 抽選販売のお知らせ"]).category).toBe("other");
    expect(judgeTcg(["ワンピースカード OP-13 予約抽選"]).category).toBe("other");
    expect(judgeTcg(["遊戯王OCG 抽選"]).category).toBe("other");
    expect(judgeTcg(["デュエル・マスターズ 抽選"]).category).toBe("other");
    expect(judgeTcg(["ポケモンカード 拡張パック 抽選", "ONE PIECEカード 抽選"]).category).toBe("mixed");
    expect(judgeTcg(["新弾BOX 抽選販売のお知らせ"]).category).toBe("unknown");
    expect(judgeTcg(["ポケモンカードゲーム 抽選販売"]).category).toBe("pokemon");
  });
  const cond = normalizeConditions({ prefectures: ["大阪府"], includeOnline: true });
  const base = { applyDeadline: { precision: "date_only", date: "2026-11-20", time: "" }, applyStart: { precision: "unknown", date: "", time: "" }, receiveMethod: "store", applyMethod: "web", requirementTags: [], sourceUrls: [] } as unknown as LotteryInput;
  const item = (name: string) => ({ product: { id: null, name } });
  const ev = (names: string[], texts: string[] = []) => evaluateCandidate({ ...base, items: names.map(item) } as unknown as LotteryInput, cond, { prefecture: "大阪府", storeKind: "physical", distanceKm: null, now: NOW, texts });
  it("他TCGの商品は除外（理由つき）、ポケモンカードや種別不明は除外しない", () => {
    const o = ev(["ONE PIECEカードゲーム ブースターパック"]);
    expect(o.verdict).toBe("exclude");
    expect(o.reasons[0]).toContain("ポケモンカード以外");
    expect(ev(["拡張パック「テスト」 BOX"]).verdict).toBe("match");
    expect(ev(["新弾BOX"]).verdict).toBe("match");
  });
  it("複数TCGの告知はポケモンカードの情報を取りこぼさない（除外せず注意の補足のみ）", () => {
    const m = ev(["拡張パック「テスト」 BOX"], ["ポケモンカードとONE PIECEカードの抽選のお知らせ"]);
    expect(m.verdict).toBe("match");
    expect(m.reasons.join()).toContain("複数のTCG");
  });
  it("明細に他TCGが混ざるときは、ポケモンカードの明細だけを残す（ポケモンの明細が無ければ何もしない）", () => {
    expect(otherTcgItemIndexes([item("拡張パック「テスト」"), item("ONE PIECEカード ブースター")])).toEqual([1]);
    expect(otherTcgItemIndexes([item("ONE PIECEカード ブースター"), item("遊戯王OCG パック")])).toEqual([]);
    expect(otherTcgItemIndexes([item("拡張パック「テスト」")])).toEqual([]);
  });
  it("一覧の事前判定でも、ONE PIECEのみの告知は対象外", () => {
    expect(judgeRelevance("ONE PIECEカードゲーム 抽選", { fromPokemonList: false }).relevant).toBe(false);
    expect(judgeRelevance("ポケモンカード と ONE PIECE の抽選", { fromPokemonList: false }).relevant).toBe(true);
  });
});

describe("Stage 6H: X APIの応答からプロフィールを読む", () => {
  it("投稿者と引用元の投稿者の表示名・所在地を保持する", () => {
    const json = {
      data: [{ id: "100", text: "抽選", author_id: "u1", created_at: "2026-11-04T00:00:00Z", referenced_tweets: [{ type: "quoted", id: "200" }] }],
      includes: {
        users: [
          { id: "u1", username: "pokecachan", name: "ポケカ抽選まとめ" },
          { id: "u2", username: "tsutayatakehara", name: "TSUTAYA 竹原店", location: "広島県竹原市", description: "" },
        ],
        tweets: [{ id: "200", text: "ポケカ抽選", author_id: "u2", created_at: "2026-11-04T00:00:00Z" }],
      },
    };
    const [p] = parseXPosts(json, "pokecachan");
    expect(p.profile).toMatchObject({ name: "ポケカ抽選まとめ" });
    expect(p.quoted?.username).toBe("tsutayatakehara");
    expect(p.quoted?.profile).toMatchObject({ name: "TSUTAYA 竹原店", location: "広島県竹原市" });
  });
});


describe("Stage 6H: 他TCGの『拡張パック』（共通の語）だけでポケモンカードとみなさない", () => {
  it("ONE PIECEの拡張パックは除外。ポケモンカードの語と併記されていれば混在として残す", () => {
    expect(judgeTcg(["ONE PIECEカードゲーム 拡張パック 神の支配"]).category).toBe("other");
    expect(judgeTcg(["ワンピース ヒロインズエディションVol.2"]).category).toBe("other");
    expect(judgeTcg(["ポケモンカード 拡張パック", "ONE PIECEカードゲーム 拡張パック"]).category).toBe("mixed");
    expect(judgeRelevance("ホビーステーション ONE PIECEカードゲーム 拡張パック 抽選", {}).relevant).toBe(false);
    expect(judgeTcg(["拡張パック 抽選"]).category).toBe("unknown");
  });
});

describe("Stage 6H: 商品がすべて他TCGなら、周囲の文にポケモンカードの語があっても除外", () => {
  const cond = normalizeConditions({ prefectures: ["大阪府"], includeOnline: true });
  const base = { applyDeadline: { precision: "date_only", date: "2026-11-20", time: "" }, applyStart: { precision: "unknown", date: "", time: "" }, receiveMethod: "store", applyMethod: "web", requirementTags: [], sourceUrls: [] } as unknown as LotteryInput;
  it("まとめの引用元などに『ポケカ』があっても、ONE PIECEの商品だけなら除外。ポケモンカードの商品が残るなら除外しない", () => {
    const ev = (names: string[]) => evaluateCandidate({ ...base, items: names.map((n) => ({ product: { id: null, name: n } })) } as unknown as LotteryInput, cond, { prefecture: "大阪府", storeKind: "physical", distanceKm: null, now: new Date("2026-11-05T03:00:00Z"), texts: ["ポケカ抽選まとめ"] });
    expect(ev(["ONE PIECEカードゲーム 拡張パック 神の支配"]).verdict).toBe("exclude");
    expect(ev(["ONE PIECEカードゲーム 拡張パック", "拡張パック「テスト」"]).verdict).toBe("match");
  });
});
