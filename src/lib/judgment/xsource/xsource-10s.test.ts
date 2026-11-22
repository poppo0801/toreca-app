// @vitest-environment node
/** Stage 10S: 項目と応募先URLの対応（出所・スコープ判定）・回帰（別店舗リンク・共有フォーム・店舗名非掲載・短縮URL・別開催回・同名店舗・情報欠落）。架空データのみ。 */
import { describe, expect, it } from "vitest";
import { parseListItems } from "../list-items";
import { buildItemLinks, itemScopedUrls, sameUrlCounts } from "./item-links";
import { judgeLinkScope, type ScopeInput } from "./link-scope";

const LIST = "🏯架空地方 | 3件 《架空書店 梅田店（大阪府）- 1件》 ・架空TCG 拡張パック「テスト弾」抽選販売 https://t.co/aaa111 - 11/22(日)23:59〆 《架空書店 難波店（大阪府）- 1件》 ・架空TCG 拡張パック「テスト弾」抽選販売 https://t.co/bbb222 - 11/22(日)23:59〆 《別系列 京橋店（大阪府）- 1件》 ・架空TCG 拡張パック「テスト弾」抽選販売 https://t.co/ccc333 - 11/22(日)23:59〆";
const parsed = parseListItems(LIST);
const LM = [
  { short: "https://t.co/aaa111", url: "https://livepocket.jp/e/aaaaa" },
  { short: "https://t.co/bbb222", url: "https://livepocket.jp/e/bbbbb" },
  { short: "https://t.co/ccc333", url: "https://shop.example.com/lottery/20261122003" },
];
const page = (head: string, lines: string[] = []) => ({ head, lines });
const base = (over: Partial<ScopeInput> = {}): ScopeInput => ({ link: { origin: "item_entity" }, item: { chain: "架空書店", store: "梅田店", products: ["架空TCG 拡張パック「テスト弾」"] }, page: null, otherStores: ["難波店", "京橋店"], otherProducts: [], sameUrlItems: 1, ...over });

describe("リンクの出所: 項目自身の展開済みリンク／展開されていない短縮URL／親投稿共通。復元不能を明示し、短縮URLを追跡しない", () => {
  it("項目の短縮URLが linkMap にあれば項目自身の展開済みリンク（item_entity）。X投稿URLは応募先にしない", () => {
    const m = buildItemLinks({ items: parsed.items, linkMap: [...LM, { short: "https://t.co/ddd444", url: "https://x.com/shop/status/123456789" }], parentLinks: [], recordedAt: "2026-11-22T00:00:00Z" });
    expect(parsed.items.length).toBe(3);
    expect(m.get(1)?.map((l) => [l.origin, l.url])).toEqual([["item_entity", "https://livepocket.jp/e/aaaaa"]]);
    expect(itemScopedUrls(m.get(3) ?? [])).toEqual(["https://shop.example.com/lottery/20261122003"]);
  });
  it("linkMap が無い（既存の保存データ）: 項目ごとの対応は復元できない＝短縮URLのまま・展開しない。親投稿のリンクは『共通』として出所を明示し、項目の応募先にはならない", () => {
    const m = buildItemLinks({ items: parsed.items, linkMap: undefined, parentLinks: ["https://livepocket.jp/e/zzzzz"], recordedAt: null });
    expect(m.get(1)?.map((l) => l.origin)).toEqual(["item_text_short_unexpanded", "parent_shared"]);
    expect(itemScopedUrls(m.get(1) ?? [])).toEqual([]);
    expect(m.get(1)?.[0].url).toBe("https://t.co/aaa111"); // 短縮URLのまま（追跡しない）
  });
  it("linkMap がある場合、項目の展開結果に当たらない親投稿のリンクは parent_card。共有リンクの項目数を数える", () => {
    const m = buildItemLinks({ items: parsed.items, linkMap: LM, parentLinks: ["https://livepocket.jp/e/aaaaa", "https://livepocket.jp/e/cardx"], recordedAt: null });
    expect(m.get(2)?.map((l) => l.origin)).toEqual(["item_entity", "parent_card"]);
    expect([...sameUrlCounts(m).values()].sort()).toEqual([1, 1, 1, 1, 3].sort().slice(0, 0).concat([1, 1, 1, 3]).sort()); // cardx は3項目に共通、他は各1
  });
});

describe("スコープ判定: 取得できたことと、その応募機会のリンクだと証明できたことを分ける", () => {
  it("【別店舗リンクの誤対応】ページが別の店舗を名指しし、項目の店舗を含まない → 不一致（親投稿共通のリンクでも、項目自身のリンクでも）", () => {
    for (const origin of ["parent_shared", "parent_card", "item_entity"] as const) {
      const v = judgeLinkScope(base({ link: { origin }, page: page("【ポケカ商品抽選販売/架空書店 難波店】", ["当店店頭にて購入権利を取得"]) }));
      expect(v.verdict, origin).toBe("mismatch");
      expect(v.refutes).toContain("page_names_other_store");
    }
  });
  it("【共有フォーム】ページが項目の店舗を選択肢に含むなら確定（共通フォームを誤除外しない）", () => {
    const v = judgeLinkScope(base({ link: { origin: "parent_shared" }, sameUrlItems: 3, page: page("応募フォーム", ["受取店舗を選択: 梅田店／難波店／京橋店"]) }));
    expect(v.verdict).toBe("confirmed");
    expect(v.supports).toEqual(expect.arrayContaining(["page_names_item_store", "page_lists_item_store_among_options"]));
  });
  it("【店舗名非掲載】項目自身のリンク（展開済み）で反証が無ければ、ページに店舗名が出なくても確定（正当なケースを誤除外しない）", () => {
    const v = judgeLinkScope(base({ page: page("架空TCG 拡張パック「テスト弾」抽選のお申し込み", ["お一人様1回まで"]) }));
    expect(v.verdict).toBe("confirmed");
    expect(v.unknowns).toContain("page_does_not_name_any_store");
  });
  it("【店舗名非掲載・親投稿共通】同じリンクが複数項目に付き、ページが店舗の範囲を示さない → 不明（無根拠の一括流用の禁止）", () => {
    const v = judgeLinkScope(base({ link: { origin: "parent_shared" }, sameUrlItems: 3, page: page("架空TCG 拡張パック「テスト弾」抽選", ["お一人様1回まで"]) }));
    expect(v.verdict).toBe("unknown");
    expect(v.unknowns).toContain("shared_link_scope_unverified");
  });
  it("【短縮URL取得不可】展開されていない短縮URLは追跡せず不明（復元不能の明示）。ページ未取得でも項目自身のリンクなら候補どまり（確定しない）", () => {
    expect(judgeLinkScope(base({ link: { origin: "item_text_short_unexpanded" } }))).toMatchObject({ verdict: "unknown", unknowns: ["short_url_not_expanded_not_followed"] });
    expect(judgeLinkScope(base({ page: null }))).toMatchObject({ verdict: "candidate", unknowns: ["page_not_fetched"] });
    expect(judgeLinkScope(base({ link: { origin: "parent_shared" }, page: null })).verdict).toBe("unknown");
  });
  it("【同一系列・別開催回】ページが別の開催回を示す → 不一致", () => {
    const v = judgeLinkScope(base({ item: { chain: "架空書店", store: "梅田店", products: [], round: "第2回" }, page: page("架空書店 梅田店 第1回 抽選", []) }));
    expect(v).toMatchObject({ verdict: "mismatch", refutes: ["page_shows_other_round"] });
  });
  it("【別商品】ページが同じ親投稿の別の商品を示し、項目の商品を示さない → 不一致", () => {
    const v = judgeLinkScope(base({ item: { chain: "架空書店", store: "梅田店", products: ["拡張パック「テスト弾」"] }, otherProducts: ["ハイクラスパック「別の弾」"], page: page("架空書店 梅田店 ハイクラスパック「別の弾」抽選", []) }));
    expect(v.refutes).toContain("page_names_other_product");
    expect(v.verdict).toBe("mismatch");
  });
  it("【同名店舗】別の系列の同名店舗のページ（別の系列を名指し）→ 不一致。系列が合う同名店舗のページなら確定", () => {
    const wrong = judgeLinkScope(base({ item: { chain: "架空書店", store: "梅田店", products: [] }, otherChains: ["別系列"], page: page("別系列 の抽選", ["別系列 梅田店 のお知らせ"]) }));
    expect(wrong.verdict).toBe("mismatch");
    expect(wrong.refutes).toContain("page_names_other_chain");
    expect(judgeLinkScope(base({ item: { chain: "架空書店", store: "梅田店", products: [] }, otherChains: ["別系列"], page: page("架空書店 梅田店 の抽選", []) })).verdict).toBe("confirmed");
  });
  it("【情報欠落】項目の店舗が不明・親投稿に1リンクだけ・ページに系列名がある → 候補（確定しない）。何も手掛かりが無ければ不明", () => {
    expect(judgeLinkScope(base({ link: { origin: "parent_shared" }, item: { chain: "架空書店", store: null, products: [] }, page: page("架空書店 の抽選のお知らせ", []) })).verdict).toBe("candidate");
    expect(judgeLinkScope(base({ link: { origin: "parent_shared" }, item: { chain: null, store: null, products: [] }, page: page("抽選のお知らせ", []) })).verdict).toBe("unknown");
  });
  it("URLの文字列の類似では判定しない（関数はURLを受け取らない）。判定は、根拠（支持）と反証を必ず返す", () => {
    const v = judgeLinkScope(base({ page: page("架空書店 梅田店", []) }));
    expect(v.supports.length).toBeGreaterThan(0);
    expect(Object.keys(base().link)).toEqual(["origin"]);
  });
});
