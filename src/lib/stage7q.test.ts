import { describe, expect, it } from "vitest";
import { findDuplicates, storeRelation } from "@/lib/lottery-match";
import { excludedChainReason, matchExcludedChain, type ExcludedChain } from "@/lib/collector/chain-exclusion";
import { addMergedSource, MERGED_SOURCES_MAX, snapshotOfInput, type MergedSource } from "@/lib/merged-sources";
import type { LotteryInput } from "@/lib/lottery-input";
import type { Chain, Lottery, Store } from "@/types/domain";

/** Stage 7Q: 店舗未確定・店舗選択式・店舗固定式の区別と重複判定、除外系列（信頼性なし）の判定、統合した情報元の記録 */
const NOW = new Date("2026-11-10T03:00:00Z"); // 2026-11-10 12:00 JST
const flex = (date: string | null) => (date ? { precision: "date_only" as const, date, time: "" } : { precision: "unknown" as const, date: "", time: "" });
const jflex = (date: string | null) => (date ? { precision: "date_only" as const, date } : { precision: "unknown" as const });

const chains = [
  { id: "geo", name: "GEO" },
  { id: "ds", name: "ドラゴンスター" },
  { id: "yd", name: "ヤマダデンキ" },
  { id: "lr", name: "Luruna Card", aliases: ["るるなカード"] },
] as unknown as Chain[];
const stores = [
  { id: "ds1", chainId: "ds", name: "三宮店", salesKind: "physical" },
  { id: "ds2", chainId: "ds", name: "梅田店", salesKind: "physical" },
  { id: "geoph", chainId: "geo", name: "応募時に店舗選択", salesKind: "physical" },
  { id: "geo1", chainId: "geo", name: "GEO三宮店", salesKind: "physical" },
  { id: "ydon", chainId: "yd", name: "オンライン", salesKind: "online_only" },
] as unknown as Store[];
const master = { chains, stores };

const lot = (id: string, o: Partial<Lottery> & { products?: string[] } = {}): Lottery => {
  const { products = ["p1"], ...rest } = o;
  return {
    id,
    chainId: "ds",
    storeId: null,
    storeMode: "fixed",
    items: products.map((p) => ({ productId: p, quantity: 1, unit: "box" })),
    sourceUrls: ["https://x.com/a/status/100000001"],
    applyStart: jflex("2026-11-09"),
    applyDeadline: jflex("2026-11-12"),
    ...rest,
  } as unknown as Lottery;
};
const input = (o: Partial<LotteryInput> & { products?: (string | null)[] } = {}): LotteryInput => {
  const { products = ["p1"], ...rest } = o;
  return {
    chain: { id: "ds", name: "ドラゴンスター" },
    store: { id: null, name: "", prefecture: "" },
    storeMode: "fixed",
    items: products.map((p) => ({ product: { id: p, name: p ?? "未登録" }, quantity: 1, unit: "box" })),
    applyStart: flex("2026-11-09"),
    applyDeadline: flex("2026-11-12"),
    sourceUrls: ["https://x.com/b/status/200000002"],
    multiMode: "single",
    ...rest,
  } as unknown as LotteryInput;
};
const dup = (i: LotteryInput, ls: Lottery[]) => findDuplicates(i, ls, undefined, master, { now: NOW });

describe("Stage 7Q: 店舗未確定どうしは、同じ系列・商品で明確に別でなければ重複（high）", () => {
  it("別URL・同じ締切 → high（以前は要確認で別カードになっていた）", () => {
    const d = dup(input(), [lot("L1")]);
    expect(d).toHaveLength(1);
    expect(d[0]).toMatchObject({ lotteryId: "L1", level: "high" });
    expect(d[0].reason).toContain("店舗が未確定");
  });
  it("締切日だけ違う（期間が重なる）同じ抽選も high", () => {
    expect(dup(input({ applyDeadline: flex("2026-11-15") }), [lot("L1")])[0]).toMatchObject({ level: "high" });
    expect(dup(input({ applyStart: flex(null), applyDeadline: flex("2026-11-20") }), [lot("L1")])[0]).toMatchObject({ level: "high" });
  });
  it("店舗未確定の同一抽選を複数回収集しても、1件に統合される（登録済みが1件あれば毎回 high）", () => {
    const existing = [lot("L1")];
    for (const url of ["https://x.com/c/status/300000003", "https://example.com/p", "https://x.com/d/status/400000004"]) {
      expect(findDuplicates(input({ sourceUrls: [url] }), existing, url, master, { now: NOW })[0]?.level).toBe("high");
    }
  });
  it("明確に別の開催回（応募期間が重ならない）は別カード", () => {
    const old = lot("L1", { applyStart: jflex("2026-10-01"), applyDeadline: jflex("2026-10-05") });
    expect(dup(input({ applyStart: flex("2026-11-09"), applyDeadline: flex("2026-11-12") }), [old])).toEqual([]);
  });
  it("締切が不明なときは断定せず要確認（medium）", () => {
    expect(dup(input({ applyDeadline: flex(null) }), [lot("L1")])[0]?.level).toBe("medium");
  });
  it("商品構成が違えば別カード。一部だけ共通で同じ締切日なら要確認、締切が違えば対象外", () => {
    expect(dup(input({ products: ["p9"] }), [lot("L1")])).toEqual([]);
    const two = lot("L1", { products: ["p1", "p2"] });
    expect(dup(input({ products: ["p1"] }), [two])[0]?.level).toBe("medium");
    expect(dup(input({ products: ["p1"], applyDeadline: flex("2026-11-14") }), [two])).toEqual([]);
    // 複数商品の構成が同じ（順序違い）なら high
    expect(dup(input({ products: ["p2", "p1"] }), [two])[0]?.level).toBe("high");
  });
  it("別の系列は対象外", () => {
    expect(dup(input({ chain: { id: "yd", name: "ヤマダデンキ" } }), [lot("L1")])).toEqual([]);
  });
});

describe("Stage 7Q: 店舗未確定・店舗選択式・店舗固定式・通販の区別", () => {
  const fixed = { store: { id: "ds1", name: "三宮店", prefecture: "" } };
  const select = { chain: { id: "geo", name: "GEO" }, storeMode: "select_on_apply" as const, store: { id: "geoph", name: "応募時に店舗選択", prefecture: "" } };
  it("storeRelation: 店舗IDが無いだけで同じ扱いにしない", () => {
    expect(storeRelation({ cls: "fixed", id: "a" }, { cls: "fixed", id: "a" })).toBe("same");
    expect(storeRelation({ cls: "fixed", id: "a" }, { cls: "fixed", id: "b" })).toBeNull();
    expect(storeRelation({ cls: "unconfirmed", id: null }, { cls: "unconfirmed", id: null })).toBe("same");
    expect(storeRelation({ cls: "fixed", id: "a" }, { cls: "unconfirmed", id: null })).toBe("weak");
    expect(storeRelation({ cls: "select", id: null }, { cls: "unconfirmed", id: null })).toBeNull();
    expect(storeRelation({ cls: "select", id: "p" }, { cls: "fixed", id: "a" })).toBeNull();
    expect(storeRelation({ cls: "select", id: "p" }, { cls: "select", id: "p" })).toBe("same");
    expect(storeRelation({ cls: "online", id: null }, { cls: "fixed", id: "a" })).toBeNull();
  });
  it("店舗選択式（GEO）と店舗固定式は誤統合しない（同じ商品・同じ締切でも別カード）", () => {
    const sel = lot("S1", { chainId: "geo", storeId: "geoph", storeMode: "select_on_apply" });
    const fixedGeo = lot("F1", { chainId: "geo", storeId: "geo1" });
    expect(dup(input({ chain: { id: "geo", name: "GEO" }, store: { id: "geo1", name: "GEO三宮店", prefecture: "" } }), [sel])).toEqual([]);
    expect(dup(input(select), [fixedGeo])).toEqual([]);
  });
  it("店舗選択式と店舗未確定も区別する（店舗未確定の抽選は店舗選択式に統合しない）", () => {
    const sel = lot("S1", { chainId: "geo", storeId: "geoph", storeMode: "select_on_apply" });
    expect(dup(input({ chain: { id: "geo", name: "GEO" } }), [sel])).toEqual([]);
    expect(dup(input(select), [lot("U1", { chainId: "geo" })])).toEqual([]);
  });
  it("店舗選択式どうしは同じ抽選（high）", () => {
    expect(dup(input(select), [lot("S1", { chainId: "geo", storeId: "geoph", storeMode: "select_on_apply" })])[0]).toMatchObject({ level: "high" });
  });
  it("店舗が確定していて別の店舗（店舗別抽選）は別カードのまま", () => {
    expect(dup(input(fixed), [lot("L1", { storeId: "ds2" })])).toEqual([]);
  });
  it("店舗固定式と店舗未確定は、同じ商品・同じ締切なら要確認（medium。抽選候補で確認）", () => {
    expect(dup(input(fixed), [lot("L1")])[0]).toMatchObject({ level: "medium" });
    expect(dup(input(), [lot("L1", { storeId: "ds1" })])[0]).toMatchObject({ level: "medium" });
    expect(dup(input({ ...fixed, applyDeadline: flex("2026-11-20") }), [lot("L1")])).toEqual([]);
  });
  it("通販（オンライン）は店舗とも店舗未確定とも別。通販どうしは同じ", () => {
    const on = { chain: { id: "yd", name: "ヤマダデンキ" }, store: { id: "ydon", name: "オンライン", prefecture: "" } };
    expect(dup(input(on), [lot("L1", { chainId: "yd", storeId: "ydon" })])[0]).toMatchObject({ level: "high" });
    expect(dup(input(on), [lot("L1", { chainId: "yd" })])).toEqual([]);
  });
  it("手動登録（確認済み・店舗確定）と自動登録の重複は、経路にかかわらず同じ判定", () => {
    const manual = lot("M1", { storeId: "ds1" });
    const a = findDuplicates(input({ store: { id: "ds1", name: "三宮店", prefecture: "" }, sourceUrls: [] }), [manual], undefined, master, { now: NOW });
    const b = findDuplicates(input({ store: { id: "ds1", name: "三宮店", prefecture: "" } }), [manual], "https://example.com/x", master, { now: NOW });
    expect(a[0]?.level).toBe("high");
    expect(b[0]?.level).toBe("high");
  });
});

describe("Stage 7Q: 除外系列（信頼性なし）の判定", () => {
  const ex: ExcludedChain[] = [{ ruleId: "r1", chainId: "lr", name: "Luruna Card", aliases: ["るるなカード"], at: "2026-11-09T00:00:00Z", reasonCode: "untrusted_shop", note: "" }];
  it("系列マスターのIDで一致", () => {
    expect(matchExcludedChain(ex, { chainId: "lr" })).toMatchObject({ via: "id" });
    expect(matchExcludedChain(ex, { chainId: "other" })).toBeNull();
  });
  it("系列名・別名・表記ゆれ（空白・全半角・大文字小文字・通販などの語）でも一致。系列IDが未特定でも除外される", () => {
    for (const name of ["Luruna Card", "LURUNA CARD", "ＬＵＲＵＮＡ　Ｃａｒｄ", "luruna card 通販", "るるなカード", "Luruna-Card"]) expect(matchExcludedChain(ex, { chainId: null, chainName: name })?.via, name).toBe("name");
  });
  it("別名で新しい系列マスターとして登録されそうな名称（IDなし）も除外される", () => {
    expect(matchExcludedChain(ex, { chainId: "new-provisional", chainName: "るるなカード" })).toMatchObject({ via: "name" });
  });
  it("別の系列・短い名称は一致しない", () => {
    expect(matchExcludedChain(ex, { chainId: "x", chainName: "ドラゴンスター" })).toBeNull();
    expect(matchExcludedChain(ex, { chainName: "ル" })).toBeNull();
  });
  it("題名の系列名: 解析前・候補の作成前(always)は一致。解析後(unresolved)は系列が特定できないときだけ", () => {
    const t = "Luruna Card(るるなカード) 11/27(金) 23:45まで 通販";
    expect(matchExcludedChain(ex, { texts: [t], textMode: "always" })).toMatchObject({ via: "text" });
    expect(matchExcludedChain(ex, { chainId: null, chainName: "", texts: [t], textMode: "unresolved" })).toMatchObject({ via: "text" });
    // 別の系列と確定しているものは、名称の言及だけでは除外しない
    expect(matchExcludedChain(ex, { chainId: "ds", chainName: "ドラゴンスター", texts: [t], textMode: "unresolved" })).toBeNull();
    // textMode なしでは本文を見ない
    expect(matchExcludedChain(ex, { texts: [t] })).toBeNull();
  });
  it("除外が無ければ何もしない。理由に除外指定日が入る", () => {
    expect(matchExcludedChain([], { chainId: "lr" })).toBeNull();
    const m = matchExcludedChain(ex, { chainId: "lr" });
    expect(excludedChainReason(m!)).toContain("2026-11-09");
    expect(excludedChainReason(m!)).toContain("Luruna Card");
  });
});

describe("Stage 7Q: 統合した情報元の記録", () => {
  const src = (o: Partial<MergedSource> = {}): MergedSource => ({ url: "https://x.com/a/status/1", collectedAt: "2026-11-10T00:00:00Z", chainName: "ドラゴンスター", mergedAt: "2026-11-10T01:00:00Z", reason: "同じ抽選", candidateId: "c1", ...o });
  it("複数の情報元をすべて保存し、同じURLは重複して保存しない", () => {
    let cur: MergedSource[] = [];
    cur = addMergedSource(cur, src());
    cur = addMergedSource(cur, src({ url: "https://example.com/p", candidateId: "c2" }));
    cur = addMergedSource(cur, src()); // 同じURL
    expect(cur.map((x) => x.url)).toEqual(["https://x.com/a/status/1", "https://example.com/p"]);
    expect(cur[0]).toMatchObject({ chainName: "ドラゴンスター", collectedAt: "2026-11-10T00:00:00Z", candidateId: "c1" });
  });
  it("URLが無い統合元は、統合元の抽選IDで重複を判定する。統合元の抽選ID・元データを保持する", () => {
    let cur: MergedSource[] = [];
    cur = addMergedSource(cur, src({ url: null, fromLotteryId: "l1", snapshot: snapshotOfInput(input()) }));
    cur = addMergedSource(cur, src({ url: null, fromLotteryId: "l1" }));
    cur = addMergedSource(cur, src({ url: null, fromLotteryId: "l2" }));
    expect(cur).toHaveLength(2);
    expect(cur[0].snapshot).toMatchObject({ chain: { id: "ds" }, items: [{ productId: "p1" }] });
  });
  it("上限を超えたら古いものから落とす", () => {
    let cur: MergedSource[] = [];
    for (let i = 0; i < MERGED_SOURCES_MAX + 5; i++) cur = addMergedSource(cur, src({ url: `https://example.com/${i}` }));
    expect(cur).toHaveLength(MERGED_SOURCES_MAX);
    expect(cur[cur.length - 1].url).toBe(`https://example.com/${MERGED_SOURCES_MAX + 4}`);
  });
});
