import { describe, expect, it } from "vitest";
import { findDuplicates, isClearlyOtherRound } from "@/lib/lottery-match";
import { autoDedupeKey } from "@/lib/lottery-dedupe-key";
import { EMPTY_FLEX, type LotteryInput } from "@/lib/lottery-input";
import type { Chain, Lottery, Store } from "@/types/domain";

/** Stage 7P: 重複判定（系列・店舗・商品が同じ抽選は、日付・情報元が違っても重複。明確に別の開催回・店舗別・商品構成が違うものは誤統合しない） */
const NOW = new Date("2026-11-10T03:00:00Z"); // 2026-11-10 12:00 JST
const flex = (date: string | null, time = "") => (date ? { precision: time ? ("date_time" as const) : ("date_only" as const), date, time } : { precision: "unknown" as const, date: "", time: "" });
const jflex = (date: string | null) => (date ? { precision: "date_only" as const, date } : { precision: "unknown" as const });

const chains = [{ id: "geo", name: "GEO" }, { id: "ds", name: "ドラゴンスター" }, { id: "yd", name: "ヤマダデンキ" }] as unknown as Chain[];
const stores = [
  { id: "ds1", chainId: "ds", name: "三宮店", salesKind: "physical" },
  { id: "ds2", chainId: "ds", name: "梅田店", salesKind: "physical" },
  { id: "geoph", chainId: "geo", name: "応募時に店舗選択", salesKind: "physical" },
] as unknown as Store[];
const master = { chains, stores };

const lot = (id: string, o: Partial<Lottery> & { products?: string[] } = {}): Lottery => {
  const { products = ["p1"], ...rest } = o;
  return {
    id,
    chainId: "yd",
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
    chain: { id: "yd", name: "ヤマダデンキ" },
    store: { id: null, name: "", prefecture: "" },
    items: products.map((p) => ({ product: { id: p, name: p ?? "未登録" }, quantity: 1, unit: "box" })),
    applyStart: flex("2026-11-09"),
    applyDeadline: flex("2026-11-12"),
    sourceUrls: ["https://x.com/b/status/200000002"],
    multiMode: "single",
    ...rest,
  } as unknown as LotteryInput;
};
const dup = (i: LotteryInput, ls: Lottery[]) => findDuplicates(i, ls, undefined, master, { now: NOW });

describe("Stage 7P: 店舗が未確定の抽選も重複判定の対象（以前は判定自体を行わず二重登録されていた）", () => {
  it("店舗未確定どうし・同じ商品構成・同じ締切 → 別の告知（別URL）でも重複として検出する（要確認）", () => {
    const d = dup(input(), [lot("L1")]);
    expect(d).toHaveLength(1);
    expect(d[0]).toMatchObject({ lotteryId: "L1", level: "medium" });
    // 同じ投稿・応募URLなら確定（high）
    const same = dup(input({ sourceUrls: ["https://twitter.com/z/status/100000001"] }), [lot("L1")]);
    expect(same[0]).toMatchObject({ level: "high", reason: "同じ情報源URLで登録済みです" });
  });
  it("店舗未確定の登録（要確認）に回るため、新規カードは作られない（high でなくても重複の疑いは decideRegistration で確認待ちになる）", () => {
    expect(dup(input({ applyDeadline: flex(null) }), [lot("L1")])[0]?.level).toBe("medium");
  });
  it("店舗が未確定のものと、店舗が確定しているものは同一にしない", () => {
    expect(dup(input({ chain: { id: "ds", name: "ドラゴンスター" }, store: { id: "ds1", name: "三宮店", prefecture: "" } }), [lot("L1", { chainId: "ds" })])).toEqual([]);
  });
  it("応募時に店舗選択（店舗未確定扱い）と、店舗未確定の抽選は同じ区分", () => {
    const sel = input({ chain: { id: "geo", name: "GEO" }, storeMode: "select_on_apply", store: { id: "geoph", name: "応募時に店舗選択", prefecture: "" } });
    expect(dup(sel, [lot("L1", { chainId: "geo", storeId: "geoph", storeMode: "select_on_apply" })])[0]).toMatchObject({ level: "high" }); // 同じ店舗（プレースホルダ）
    expect(dup({ ...sel, store: { id: null, name: "", prefecture: "" } }, [lot("L1", { chainId: "geo" })])[0]?.level).toBe("medium");
  });
});

describe("Stage 7P: 系列・店舗・商品が同じなら、応募期間・情報元が違っても重複", () => {
  const ds = { chain: { id: "ds", name: "ドラゴンスター" }, store: { id: "ds1", name: "三宮店", prefecture: "" } };
  it("別URL・別の締切日（期間が重なる）でも high（開催回を判断できない場合は重複を優先）", () => {
    const l = lot("L1", { chainId: "ds", storeId: "ds1", applyStart: jflex("2026-11-01"), applyDeadline: jflex("2026-11-20") });
    const d = dup(input({ ...ds, applyStart: flex("2026-11-05"), applyDeadline: flex("2026-11-15") }), [l]);
    expect(d[0]).toMatchObject({ lotteryId: "L1", level: "high" });
    expect(d[0].reason).toContain("別の開催回と確認できない");
  });
  it("応募開始日が不明でも、締切が違えば（既存が終了前なら）重複を優先", () => {
    const l = lot("L1", { chainId: "ds", storeId: "ds1", applyDeadline: jflex("2026-11-20") });
    expect(dup(input({ ...ds, applyStart: flex(null), applyDeadline: flex("2026-11-25") }), [l])[0]?.level).toBe("high");
  });
  it("店舗別の抽選: 別の店舗は別カードとして維持する", () => {
    const l = lot("L1", { chainId: "ds", storeId: "ds2" });
    expect(dup(input({ ...ds }), [l])).toEqual([]);
  });
  it("明確に別の開催回（応募期間が重ならない）は登録を許可する", () => {
    const l = lot("L1", { chainId: "ds", storeId: "ds1", applyStart: jflex("2026-10-20"), applyDeadline: jflex("2026-10-25") });
    expect(dup(input({ ...ds, applyStart: flex("2026-11-09"), applyDeadline: flex("2026-11-12") }), [l])).toEqual([]);
  });
  it("既存の応募締切がすでに過ぎていて、新しい告知の締切がそれより後なら、前回が終わったあとの別の開催回（開始日が告知にない場合）", () => {
    const l = lot("L1", { chainId: "ds", storeId: "ds1", applyStart: jflex("2026-10-20"), applyDeadline: jflex("2026-11-02") });
    expect(dup(input({ ...ds, applyStart: flex(null), applyDeadline: flex("2026-11-15") }), [l])).toEqual([]);
  });
  it("同じ締切日なら、開催回が別とは言えない（高）", () => {
    expect(isClearlyOtherRound({ start: "2026-11-09", deadline: "2026-11-12" }, { start: "2026-10-01", deadline: "2026-11-12" }, "2026-11-10")).toBe(false);
  });
});

describe("Stage 7P: 複数商品の抽選は、一部の商品が一致するだけで同一にしない", () => {
  const base = { chain: { id: "ds", name: "ドラゴンスター" }, store: { id: "ds1", name: "三宮店", prefecture: "" } };
  it("商品構成が同じ（順序違い）なら同一", () => {
    const l = lot("L1", { chainId: "ds", storeId: "ds1", products: ["p1", "p2"] });
    expect(dup(input({ ...base, products: ["p2", "p1"] }), [l])[0]?.level).toBe("high");
  });
  it("一部だけ共通: 同じ締切日なら要確認（medium）、締切が違えば対象外", () => {
    const l = lot("L1", { chainId: "ds", storeId: "ds1", products: ["p1", "p2"] });
    expect(dup(input({ ...base, products: ["p1"] }), [l])[0]?.level).toBe("medium");
    expect(dup(input({ ...base, products: ["p1"], applyDeadline: flex("2026-11-14") }), [l])).toEqual([]);
  });
  it("未登録の商品（ID なし）を含む複数商品は、商品構成が同じとは言い切れない", () => {
    const l = lot("L1", { chainId: "ds", storeId: "ds1", products: ["p1"] });
    expect(dup(input({ ...base, products: ["p1", null] }), [l])[0]?.level).toBe("medium");
  });
  it("商品が共通しなければ対象外", () => {
    expect(dup(input({ ...base, products: ["p9"] }), [lot("L1", { chainId: "ds", storeId: "ds1" })])).toEqual([]);
  });
});

describe("Stage 7P: 並行登録を防ぐ同一性キー", () => {
  it("系列・店舗・商品構成（順序に依らない）・締切日が同じなら同じキー", () => {
    const a = autoDedupeKey(input({ products: ["p2", "p1"] }));
    const b = autoDedupeKey(input({ products: ["p1", "p2"], sourceUrls: ["https://x.com/q/status/1"] }));
    expect(a).toBe(b);
    expect(a).toContain("yd|none|p1,p2|2026-11-12");
  });
  it("店舗・締切日・商品が違えば別のキー", () => {
    const k = autoDedupeKey(input());
    expect(autoDedupeKey(input({ applyDeadline: flex("2026-11-13") }))).not.toBe(k);
    expect(autoDedupeKey(input({ store: { id: "ds1", name: "三宮店", prefecture: "" } }))).not.toBe(k);
    expect(autoDedupeKey(input({ products: ["p3"] }))).not.toBe(k);
  });
  it("系列・商品が未登録のとき、締切が未定のときの扱い", () => {
    expect(autoDedupeKey(input({ chain: { id: null, name: "未登録" } }))).toBeNull();
    expect(autoDedupeKey(input({ products: ["p1", null] }))).toBeNull();
    expect(autoDedupeKey(input({ applyDeadline: EMPTY_FLEX }))).toContain("|-");
  });
});
