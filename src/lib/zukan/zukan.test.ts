import { describe, expect, it } from "vitest";
import { DEX_TOTAL, dexLabel, POKEMON_151, pokemonOf } from "./pokemon151";
import { cheapestIds, collectedSet, commonRank, daysSince, isReferencePrice, matchCard, parseAmount, priceInputSchema, recentStores, resolveAcquire, sortPrices, storeHistory, zukanCardInputSchema, zukanRows, zukanStats, type PriceLike, type ZukanCard } from "./zukan";

const card = (o: Partial<ZukanCard> = {}): ZukanCard => ({ id: "c" + Math.random(), profileId: "p1", dexNo: 25, cardName: "ピカチュウ", setName: "", cardNumber: "", rarity: "", quantity: 1, acquiredOn: null, acquireMethod: "pack_opening", purchaseAmountYen: null, storeName: "", condition: "", memo: "", priceRecordId: null, ...o });

describe("151匹のマスター", () => {
  it("図鑑番号1〜151が連番・重複なしで、名称も重複しない。代表的な番号・名称が公式表記", () => {
    expect(POKEMON_151).toHaveLength(151);
    expect(DEX_TOTAL).toBe(151);
    POKEMON_151.forEach((p, i) => expect(p.no).toBe(i + 1));
    expect(new Set(POKEMON_151.map((p) => p.name)).size).toBe(151);
    const expected: Record<number, string> = { 1: "フシギダネ", 4: "ヒトカゲ", 7: "ゼニガメ", 25: "ピカチュウ", 29: "ニドラン♀", 32: "ニドラン♂", 83: "カモネギ", 94: "ゲンガー", 122: "バリヤード", 132: "メタモン", 133: "イーブイ", 143: "カビゴン", 150: "ミュウツー", 151: "ミュウ" };
    for (const [no, name] of Object.entries(expected)) expect(pokemonOf(Number(no))?.name, `No.${no}`).toBe(name);
    expect(pokemonOf(0)).toBeUndefined();
    expect(pokemonOf(152)).toBeUndefined();
    expect(dexLabel(7)).toBe("No.007");
  });
});

describe("収集済みの判定と集計", () => {
  it("1枚以上所有で収集済み。同じポケモンの複数カードは1匹として数え、登録カード枚数は枚数の合計", () => {
    const cards = [card({ dexNo: 25, quantity: 2 }), card({ dexNo: 25, cardName: "ピカチュウV", quantity: 1 }), card({ dexNo: 6 })];
    expect(collectedSet(cards)).toEqual(new Set([25, 6]));
    const s = zukanStats(cards);
    expect(s).toMatchObject({ collected: 2, total: 151, uncollected: 149, cardCount: 4, ratePercent: 1.3 });
    expect(zukanStats([]).ratePercent).toBe(0);
    expect(zukanStats(Array.from({ length: 45 }, (_, i) => card({ dexNo: i + 1 }))).ratePercent).toBe(29.8);
  });
  it("一覧は番号順。収集済み／未収集で絞り込める", () => {
    const cards = [card({ dexNo: 25 }), card({ dexNo: 3 })];
    expect(zukanRows(cards, "all")).toHaveLength(151);
    expect(zukanRows(cards, "collected").map((r) => r.no)).toEqual([3, 25]);
    expect(zukanRows(cards, "uncollected")).toHaveLength(149);
    expect(zukanRows(cards, "uncollected").every((r) => !r.collected)).toBe(true);
  });
  it("単品購入金額の合計: 金額ありのカードだけ（1枚あたり×枚数）。パック開封（null）は含めない。0円は0円として含める（未入力と区別）", () => {
    const cards = [
      card({ acquireMethod: "single_purchase", purchaseAmountYen: 500, quantity: 2 }),
      card({ acquireMethod: "single_purchase", purchaseAmountYen: 0 }),
      card({ acquireMethod: "pack_opening", purchaseAmountYen: null, quantity: 5 }),
    ];
    expect(zukanStats(cards).singlePurchaseTotalYen).toBe(1000);
    expect(zukanStats([card({ acquireMethod: "pack_opening" })]).singlePurchaseTotalYen).toBe(0);
  });
});

describe("購入金額: 未入力と0円の区別・入手方法との整合", () => {
  it("空欄は null、0は0円、カンマ・円記号は許す、不正は invalid", () => {
    expect(parseAmount("")).toBeNull();
    expect(parseAmount("  ")).toBeNull();
    expect(parseAmount("0")).toBe(0);
    expect(parseAmount("1,200円")).toBe(1200);
    expect(parseAmount("¥３００")).toBe(300);
    expect(parseAmount("abc")).toBe("invalid");
    expect(parseAmount("-5")).toBe("invalid");
    expect(parseAmount("1.5")).toBe("invalid");
  });
  it("入手方法を選ばなければ金額から決める（あり=単品購入／なし=パック開封）。明示した方法と金額が矛盾するときは保存前に止める", () => {
    expect(resolveAcquire(300, null)).toEqual({ ok: true, method: "single_purchase" });
    expect(resolveAcquire(0, null)).toEqual({ ok: true, method: "single_purchase" });
    expect(resolveAcquire(null, null)).toEqual({ ok: true, method: "pack_opening" });
    expect(resolveAcquire(null, "single_purchase").ok).toBe(false);
    expect(resolveAcquire(300, "pack_opening").ok).toBe(false);
    expect(resolveAcquire(0, "single_purchase")).toEqual({ ok: true, method: "single_purchase" });
  });
  it("入力検証: 矛盾は拒否・0円は受理・null は null のまま保存される", () => {
    const base = { dexNo: 25, cardName: "ピカチュウ", quantity: 1 };
    expect(zukanCardInputSchema.safeParse({ ...base, acquireMethod: "single_purchase", purchaseAmountYen: null }).success).toBe(false);
    expect(zukanCardInputSchema.safeParse({ ...base, acquireMethod: "pack_opening", purchaseAmountYen: 100 }).success).toBe(false);
    const zero = zukanCardInputSchema.safeParse({ ...base, acquireMethod: "single_purchase", purchaseAmountYen: 0 });
    expect(zero.success && zero.data.purchaseAmountYen).toBe(0);
    const nul = zukanCardInputSchema.safeParse({ ...base, acquireMethod: "pack_opening", purchaseAmountYen: null });
    expect(nul.success && nul.data.purchaseAmountYen).toBeNull();
    expect(zukanCardInputSchema.safeParse({ ...base, dexNo: 152, acquireMethod: "pack_opening" }).success).toBe(false);
    expect(zukanCardInputSchema.safeParse({ ...base, cardName: " ", acquireMethod: "pack_opening" }).success).toBe(false);
    expect(zukanCardInputSchema.safeParse({ ...base, acquireMethod: "pack_opening", condition: "S" }).success).toBe(false);
    expect(zukanCardInputSchema.safeParse({ ...base, quantity: 0, acquireMethod: "pack_opening" }).success).toBe(false);
  });
  it("価格記録の入力検証: 状態ランクは5段階・価格は0円以上の整数・店舗必須", () => {
    const ok = { storeName: "店A", surveyedOn: "2026-11-10", condition: "A+", priceYen: 1200 };
    expect(priceInputSchema.safeParse(ok).success).toBe(true);
    expect(priceInputSchema.safeParse({ ...ok, condition: "D" }).success).toBe(false);
    expect(priceInputSchema.safeParse({ ...ok, priceYen: -1 }).success).toBe(false);
    expect(priceInputSchema.safeParse({ ...ok, storeName: "" }).success).toBe(false);
    expect(priceInputSchema.safeParse({ ...ok, priceYen: 0 }).success).toBe(true);
  });
});

describe("価格調査の並び替え・参考価格", () => {
  const p = (id: string, condition: string, priceYen: number, surveyedOn = "2026-11-10", storeName = "店" + id): PriceLike => ({ id, condition, priceYen, surveyedOn, storeName });
  const list = [p("1", "B", 300), p("2", "A+", 900), p("3", "A", 500), p("4", "A+", 700), p("5", "C", 100), p("6", "B+", 400)];
  it("初期は状態の良い順（A+→A→B+→B→C）、同ランク内は価格の安い順", () => {
    expect(sortPrices(list, "condition").map((x) => x.id)).toEqual(["4", "2", "3", "6", "1", "5"]);
  });
  it("切り替えで、状態を問わず価格の安い順（同額は状態の良い順）。元の配列は変えない", () => {
    const copy = [...list];
    expect(sortPrices(list, "price").map((x) => x.id)).toEqual(["5", "1", "6", "3", "4", "2"]);
    expect(list).toEqual(copy);
    expect(sortPrices([p("a", "B", 100), p("b", "A", 100)], "price").map((x) => x.id)).toEqual(["b", "a"]);
  });
  it("30日を超えた記録は参考価格。30日ちょうどは対象。最安値の強調は30日以内の記録だけ（参考価格だけなら強調なし）", () => {
    expect(daysSince("2026-10-11", "2026-11-10")).toBe(30);
    expect(isReferencePrice({ surveyedOn: "2026-10-11" }, "2026-11-10")).toBe(false);
    expect(isReferencePrice({ surveyedOn: "2026-10-10" }, "2026-11-10")).toBe(true);
    const mix = [p("old", "A", 100, "2026-09-01"), p("new1", "A", 500, "2026-11-09"), p("new2", "B", 450, "2026-11-01")];
    expect(cheapestIds(mix, "2026-11-10")).toEqual(new Set(["new2"]));
    expect(cheapestIds([p("old", "A", 100, "2026-09-01")], "2026-11-10")).toEqual(new Set());
    expect(cheapestIds([p("x", "A", 300), p("y", "A", 300)], "2026-11-10")).toEqual(new Set(["x", "y"]));
  });
  it("同じ店舗の価格推移を古い順に取り出せる（表記ゆれ・空白は同じ店舗）。古い記録も残る", () => {
    const hist = [p("a", "A", 500, "2026-08-01", "ホビー 店"), p("b", "A", 450, "2026-11-01", "ホビー店"), p("c", "A", 800, "2026-11-02", "別の店")];
    expect(storeHistory(hist, "ホビー店").map((x) => x.id)).toEqual(["a", "b"]);
  });
  it("店舗名の候補は新しい順・重複なし。状態ランクは過去に最もよく使ったもの", () => {
    const recs = [
      { storeName: "A店", surveyedOn: "2026-11-01", condition: "A" },
      { storeName: "B店", surveyedOn: "2026-11-05", condition: "A" },
      { storeName: "ａ店", surveyedOn: "2026-10-01", condition: "B" },
    ];
    expect(recentStores(recs)).toEqual(["B店", "A店"]);
    expect(recentStores(recs, 1)).toEqual(["B店"]);
    expect(commonRank(recs)).toBe("A");
    expect(commonRank([])).toBeNull();
  });
});

describe("相場調査メモ: カードの同一性（カード名だけでは同一としない）", () => {
  const ex = [
    { id: "1", name: "リザードン", setName: "スカーレットex", cardNumber: "006/078", rarity: "SR" },
    { id: "2", name: "ピカチュウ", setName: "", cardNumber: "", rarity: "" },
  ];
  it("セット・番号・レアリティが一致すれば同一。表記ゆれ（全角半角・空白・大小）は同じ", () => {
    const m = matchCard(ex, { name: "リザードンex", setName: "スカーレット ex", cardNumber: "006/078", rarity: "sr" });
    expect(m.kind).toBe("same");
  });
  it("同じセット・番号でレアリティだけ違う／カード名が同じで識別情報が足りない → 曖昧（確認する）", () => {
    expect(matchCard(ex, { name: "リザードン", setName: "スカーレットex", cardNumber: "006/078", rarity: "RR" }).kind).toBe("ambiguous");
    expect(matchCard(ex, { name: "ピカチュウ", setName: "", cardNumber: "", rarity: "" }).kind).toBe("ambiguous");
    expect(matchCard(ex, { name: "ピカチュウ", setName: "151", cardNumber: "025/165", rarity: "C" }).kind).toBe("ambiguous"); // 既存に識別情報が無い
  });
  it("名前が同じでも、セット・番号が別なら別のカード（新規）。名前も違えば新規", () => {
    expect(matchCard(ex, { name: "リザードン", setName: "151", cardNumber: "006/165", rarity: "SR" }).kind).toBe("new");
    expect(matchCard(ex, { name: "フシギダネ", setName: "151", cardNumber: "001/165", rarity: "C" }).kind).toBe("new");
    expect(matchCard([], { name: "x", setName: "", cardNumber: "", rarity: "" }).kind).toBe("new");
  });
});
