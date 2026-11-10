import { describe, expect, it } from "vitest";
import { groupStores, type MasterChainRow, type MasterStoreRow } from "@/lib/store-master-view";
import { isDummyStoreName, isMailOrderStore, storeKey } from "@/lib/store-name";

const chain = (id: string, name: string): MasterChainRow => ({ id, name, archived_at: null });
const store = (id: string, chain_id: string, name: string, over: Partial<MasterStoreRow> = {}): MasterStoreRow => ({ id, chain_id, name, prefecture: "兵庫県", is_provisional: false, archived_at: null, sales_kind: "physical", ...over });

describe("Stage 7N: 店舗名の照合（表記揺れの吸収）", () => {
  it("全半角・空白・系列名の接頭・末尾の「店」の差を吸収する", () => {
    expect(storeKey("伊川谷店", "GEO")).toBe(storeKey("ＧＥＯ 伊川谷", "GEO"));
    expect(storeKey("GEO伊川谷店", "GEO")).toBe(storeKey("伊川谷", "GEO"));
    expect(storeKey("伊川谷店", "GEO")).not.toBe(storeKey("神戸店", "GEO"));
  });
  it("架空の店舗名（店舗未確認・不明・未設定など）は店舗として扱わない。実在の名前は扱う", () => {
    for (const n of ["店舗未確認", "不明", "未設定", " 店舗 未確認 ", "応募時に店舗選択", ""]) expect(isDummyStoreName(n)).toBe(true);
    expect(isDummyStoreName("伊川谷店")).toBe(false);
  });
  it("通販・オンライン専用の店舗を判定する", () => {
    expect(isMailOrderStore("GEO通販", "physical")).toBe(true);
    expect(isMailOrderStore("公式", "online_only")).toBe(true);
    expect(isMailOrderStore("伊川谷店", "physical")).toBe(false);
  });
});

describe("Stage 7N: 店舗マスターの系列別一覧", () => {
  const chains = [chain("c-f", "ふるいち"), chain("c-g", "GEO"), chain("c-d", "ドラゴンスター")];
  const stores = [
    store("s1", "c-g", "伊川谷店"),
    store("s2", "c-g", "神戸店", { is_provisional: true }),
    store("s3", "c-g", "三宮店"),
    store("s4", "c-g", "GEO通販", { sales_kind: "online_only", prefecture: "" }),
    store("s5", "c-f", "梅田店", { prefecture: "大阪府" }),
    store("s6", "c-g", "応募時に店舗選択"),
  ];
  const km: Record<string, number | null> = { s1: 5, s2: 30, s3: 2, s4: 0.1, s5: 20 };
  const opts = { q: "", showRetired: false, distanceKm: (s: MasterStoreRow) => km[s.id] ?? null };

  it("系列は五十音順（かな→英字の並びは日本語ロケール順）。店舗数・未確認数を返し、仮の店舗（応募時に店舗選択）は含めない", () => {
    const g = groupStores(chains, stores, opts);
    expect(g.map((x) => x.chain.name)).toEqual(["GEO", "ドラゴンスター", "ふるいち"]);
    const geo = g[0];
    expect(geo.total).toBe(4);
    expect(geo.unconfirmed).toBe(1);
    expect(g[1].total).toBe(0);
  });
  it("店舗は 未確認 → 距離が近い順 → 距離不明。通販は距離があっても距離不明として最後", () => {
    const geo = groupStores(chains, stores, opts)[0];
    expect(geo.stores.map((s) => s.name)).toEqual(["神戸店", "三宮店", "伊川谷店", "GEO通販"]);
  });
  it("検索: 店舗名・都道府県・系列名。該当しない系列は出ない（「伊川谷」でGEOだけ）", () => {
    expect(groupStores(chains, stores, { ...opts, q: "伊川谷" }).map((g) => [g.chain.name, g.stores.map((s) => s.name)])).toEqual([["GEO", ["伊川谷店"]]]);
    expect(groupStores(chains, stores, { ...opts, q: "大阪" }).map((g) => g.chain.name)).toEqual(["ふるいち"]);
    // 系列名に一致したら、その系列の店舗すべて
    expect(groupStores(chains, stores, { ...opts, q: "geo" })[0].stores).toHaveLength(4);
    expect(groupStores(chains, stores, { ...opts, q: "ｇｅｏ" })).toHaveLength(1); // 全角でも一致
  });
  it("非表示の店舗は「非表示を表示」のときだけ", () => {
    const hidden = [...stores, store("s7", "c-g", "非表示店", { archived_at: "2026-01-01" })];
    expect(groupStores(chains, hidden, opts)[0].total).toBe(4);
    expect(groupStores(chains, hidden, { ...opts, showRetired: true })[0].total).toBe(5);
  });
});
