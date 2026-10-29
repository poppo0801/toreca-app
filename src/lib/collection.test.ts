// @vitest-environment node
import { describe, expect, it } from "vitest";
import { normalizeCardExtraction } from "@/lib/ai/card-provider";
import { batchDuplicateKey, breakdown, DEFAULT_FILTERS, filterCards, isShine, latestPrice, matchCard, sortCards, summarizeCards, totalsOf, type CardRow, type FavoriteRow, type HoldingRow, type PriceRow } from "@/lib/collection";
import { cardInputSchema, holdingInputSchema, parseYen, priceInputSchema } from "@/lib/collection-input";
import { DEFAULT_COLLECTION_PREFS, normalizeCollectionPrefs, normalizeProfileSettings } from "@/lib/profile-settings";

const card = (id: string, name: string, over: Partial<CardRow> = {}): CardRow => ({
  id,
  name,
  cardNumber: "",
  setCode: "",
  rarity: "",
  cardType: "",
  productName: "",
  imagePath: null,
  thumbPath: null,
  imageSha: null,
  sourceUrl: null,
  analysisRunId: null,
  createdAt: `2026-10-${id.padStart(2, "0")}T00:00:00Z`,
  ...over,
});
const hold = (id: string, cardId: string, quantity: number, unitPriceYen: number | null, acquiredOn: string | null = null): HoldingRow => ({ id, cardId, quantity, unitPriceYen, acquiredOn, source: "", condition: "", note: "", purchaseId: null, createdAt: `2026-10-29T00:00:0${id}Z` });
const price = (id: string, cardId: string, kind: "sale" | "buyback", amountYen: number, confirmedOn: string): PriceRow => ({ id, cardId, kind, amountYen, confirmedOn, source: "", sourceUrl: null, createdAt: `2026-10-29T00:00:0${id}Z` });

describe("所持枚数・購入額・参考価値（取得記録の合算）", () => {
  const cards = [card("1", "ピカチュウex", { rarity: "SAR", cardNumber: "201/165", setCode: "sv2a" })];
  // 同じカードを 15,000 / 18,000 / 20,000 円で1枚ずつ購入
  const holdings = [hold("1", "1", 1, 15000, "2026-01-10"), hold("2", "1", 1, 18000, "2026-02-10"), hold("3", "1", 1, 20000, "2026-03-10")];

  it("一覧では1種類・所持3枚。購入額は取得記録ごとの金額の合計。相場が複数あれば最新の確認日", () => {
    const prices = [price("1", "1", "sale", 30000, "2026-03-01"), price("2", "1", "sale", 33000, "2026-04-01"), price("3", "1", "buyback", 25000, "2026-04-01")];
    const [r] = summarizeCards(cards, holdings, prices, [], null);
    expect(r.qty).toBe(3);
    expect(r.costTotal).toBe(53000);
    expect(r.costUnknownQty).toBe(0);
    expect(r.sale?.amountYen).toBe(33000); // 最新の相場。過去の価格は履歴として残る
    expect(r.saleValue).toBe(99000);
    expect(r.buybackValue).toBe(75000);
    expect(r.saleDiff).toBe(99000 - 53000);
    expect(r.buybackDiff).toBe(75000 - 53000);
    expect(r.lastAcquiredOn).toBe("2026-03-10");
    expect(latestPrice(prices, "buyback")?.amountYen).toBe(25000);
  });

  it("価格未設定は0円にしない: 購入金額が一部不明なら差額は計算せず、相場が無ければ価値も null", () => {
    const [partial] = summarizeCards(cards, [hold("1", "1", 2, 10000), hold("2", "1", 1, null)], [price("1", "1", "sale", 20000, "2026-04-01")], [], null);
    expect(partial.costTotal).toBe(20000); // 分かる分だけ
    expect(partial.costUnknownQty).toBe(1);
    expect(partial.saleValue).toBe(60000);
    expect(partial.saleDiff).toBeNull(); // 全枚数の購入価格がそろっていないので差額は出さない
    const [none] = summarizeCards(cards, [hold("1", "1", 1, null)], [], [], null);
    expect(none.costTotal).toBeNull();
    expect(none.refValue).toBeNull();
    expect(none.saleDiff).toBeNull();
  });

  it("集計: 相場が未設定のカードは参考価値の合計に含めず、未設定の種類数と枚数を別に数える", () => {
    const cs = [...cards, card("2", "ミュウex", { rarity: "SR" })];
    const rows = summarizeCards(cs, [...holdings, hold("4", "2", 2, null)], [price("1", "1", "sale", 33000, "2026-04-01")], [], null);
    const t = totalsOf(rows);
    expect(t).toMatchObject({ kinds: 2, qty: 5, costTotal: 53000, costUnknownQty: 2, saleTotal: 99000, saleMissingKinds: 1, saleDiffKinds: 1 });
    expect(breakdown(rows, "rarity")).toEqual([{ key: "SAR", kinds: 1, qty: 3 }, { key: "SR", kinds: 1, qty: 2 }]);
  });
});

describe("お気に入り・並び替え・絞り込み・検索", () => {
  const cards = [card("1", "A", { rarity: "SR", productName: "弾1" }), card("2", "B", { rarity: "SAR", productName: "弾2", thumbPath: "t" }), card("3", "C", { rarity: "SR" }), card("4", "D", { rarity: "R" })];
  const holdings = [hold("1", "1", 1, 100), hold("2", "2", 3, 200), hold("3", "3", 1, 300), hold("4", "4", 1, 400)];
  const prices = [price("1", "1", "sale", 1000, "2026-01-01"), price("2", "2", "sale", 5000, "2026-01-01"), price("3", "4", "buyback", 700, "2026-01-01")];
  const favs: FavoriteRow[] = [
    { profileId: "A", cardId: "1", rank: 1 },
    { profileId: "A", cardId: "3", rank: 0 },
    { profileId: "B", cardId: "2", rank: 0 },
  ];
  const rowsOf = (pid: string | null) => summarizeCards(cards, holdings, prices, favs, pid);

  it("お気に入りはプロフィールごと（Aのお気に入りはBに影響しない）", () => {
    expect(rowsOf("A").filter((r) => r.favRank !== null).map((r) => r.id).sort()).toEqual(["1", "3"]);
    expect(rowsOf("B").filter((r) => r.favRank !== null).map((r) => r.id)).toEqual(["2"]);
    expect(rowsOf("C").filter((r) => r.favRank !== null)).toEqual([]);
  });

  it("標準の並び: お気に入り → お気に入り内の順位 → 参考価値の高い順。価値が未設定のカードは末尾（0円として扱わない）", () => {
    expect(sortCards(rowsOf("A"), "default").map((r) => r.id)).toEqual(["3", "1", "2" /* 5000×3 */, "4" /* 買取700 */]);
    // 価値: 2=15000, 4=700（買取）。3 は相場なし(null)だがお気に入りなので先頭側
    expect(sortCards(rowsOf("B"), "default").map((r) => r.id)).toEqual(["2", "1", "4", "3"]);
    expect(sortCards(rowsOf(null), "valueAsc").map((r) => r.id)).toEqual(["4", "1", "2", "3"]); // 昇順でも未設定は末尾
    expect(sortCards(rowsOf(null), "valueDesc").map((r) => r.id)).toEqual(["2", "1", "4", "3"]);
    expect(sortCards(rowsOf(null), "qty")[0].id).toBe("2");
    expect(sortCards(rowsOf(null), "name").map((r) => r.id)).toEqual(["1", "2", "3", "4"]);
  });

  it("検索（名前・番号・収録パック・レアリティ。全角半角・大小文字の揺れを吸収）と絞り込み", () => {
    const rows = rowsOf("A");
    expect(filterCards(rows, { ...DEFAULT_FILTERS, q: "ｓａｒ" }).map((r) => r.id)).toEqual(["2"]);
    expect(filterCards(rows, { ...DEFAULT_FILTERS, q: "弾1" }).map((r) => r.id)).toEqual(["1"]);
    expect(filterCards(rows, { ...DEFAULT_FILTERS, favOnly: true }).map((r) => r.id).sort()).toEqual(["1", "3"]);
    expect(filterCards(rows, { ...DEFAULT_FILTERS, rarity: "SR" }).map((r) => r.id).sort()).toEqual(["1", "3"]);
    expect(filterCards(rows, { ...DEFAULT_FILTERS, qty: "multi" }).map((r) => r.id)).toEqual(["2"]);
    expect(filterCards(rows, { ...DEFAULT_FILTERS, priced: "no" }).map((r) => r.id)).toEqual(["3"]);
    expect(filterCards(rows, { ...DEFAULT_FILTERS, image: "yes" }).map((r) => r.id)).toEqual(["2"]);
    expect(filterCards(rows, { ...DEFAULT_FILTERS, product: "弾2" }).map((r) => r.id)).toEqual(["2"]);
  });
});

describe("カードマスターとの照合（名称の類似だけで統合しない）", () => {
  const cards = [
    card("1", "ピカチュウex", { cardNumber: "201/165", setCode: "sv2a", rarity: "SAR" }),
    card("2", "ピカチュウex", { cardNumber: "132/165", setCode: "sv2a", rarity: "RR" }), // 同名・別カード
    card("3", "リザードン", {}),
  ];
  it("商品コード・番号・レアリティが一致すれば同じカード", () => {
    const m = matchCard({ name: "ピカチュウEX", cardNumber: "201/165", setCode: "SV2A", rarity: "sar" }, cards);
    expect(m.kind === "exact" && m.card.id).toBe("1");
  });
  it("同名でも、番号・レアリティが違えば別のカード（自動では確定しない）。同じ番号で収録商品が不明なら候補", () => {
    expect(matchCard({ name: "ピカチュウex", cardNumber: "300/165", setCode: "sv2a", rarity: "SAR" }, cards).kind).toBe("none");
    const c = matchCard({ name: "ピカチュウex", cardNumber: "201/165", setCode: "sv2a", rarity: "UR" }, cards);
    expect(c.kind).toBe("candidates"); // 番号は同じだがレアリティが違う → 利用者が選ぶ
    expect(c.kind === "candidates" && c.candidates[0].id).toBe("1");
    expect(matchCard({ name: "ミュウex", cardNumber: "", setCode: "", rarity: "" }, cards).kind).toBe("none");
  });
  it("番号なしのカードは、名称が同じものだけ候補にする（確定しない）", () => {
    const m = matchCard({ name: "リザードン", cardNumber: "", setCode: "", rarity: "" }, cards);
    expect(m.kind).toBe("candidates");
  });
  it("一括登録の重複: 同じ画像、または同じ（商品コード・番号・レアリティ）", () => {
    expect(batchDuplicateKey({ name: "x", cardNumber: "1", setCode: "a", rarity: "SR" }, "ab".repeat(32))).toEqual([`sha:${"ab".repeat(32)}`, "id:a|1|sr"]);
    expect(batchDuplicateKey({ name: "x", cardNumber: "", setCode: "", rarity: "" }, null)).toEqual([]);
  });
});

describe("AI画像解析の結果の整形（説明文を欄に入れない・推測しない）", () => {
  it("読み取れた項目だけ。「読み取れませんでした」などの説明は欄を空にして要確認の理由へ移す", () => {
    const x = normalizeCardExtraction({ is_card: true, name: "ピカチュウex", card_number: "201/165", set_code: "判別できません", rarity: "SAR", card_type: "ポケモン", product_name: "", confidence: { name: "high", card_number: "high", set_code: "low", rarity: "high", product_name: "low" }, notes: ["光が反射している"] });
    expect(x).toMatchObject({ name: "ピカチュウex", cardNumber: "201/165", setCode: "", rarity: "SAR", cardType: "ポケモン", productName: "" });
    expect(x.issues.some((i) => i.field === "setCode" && i.message.includes("読み取れませんでした"))).toBe(true);
    expect(x.issues.some((i) => i.field === "general" && i.message === "光が反射している")).toBe(true);
    expect(x.confidence.setCode).toBe("low");
  });
  it("不正な出力は安全な既定値に倒す（創作しない）", () => {
    const x = normalizeCardExtraction({ name: 123, confidence: "x" });
    expect(x.name).toBe("");
    expect(x.confidence.name).toBe("low");
    expect(normalizeCardExtraction(null).isCard).toBe(true);
    expect(normalizeCardExtraction({ is_card: false }).isCard).toBe(false);
  });
});

describe("入力の検証と表示設定", () => {
  it("カード・所有記録・相場の入力検証", () => {
    expect(cardInputSchema.safeParse({ name: "" }).success).toBe(false);
    expect(cardInputSchema.safeParse({ name: "A", sourceUrl: "javascript:alert(1)" }).success).toBe(false);
    expect(cardInputSchema.safeParse({ name: "A", imagePath: "../etc/passwd" }).success).toBe(false);
    expect(cardInputSchema.parse({ name: " A " }).name).toBe("A");
    expect(holdingInputSchema.safeParse({ quantity: 0 }).success).toBe(false);
    expect(holdingInputSchema.safeParse({ quantity: 1, unitPriceYen: -1 }).success).toBe(false);
    expect(holdingInputSchema.parse({ quantity: 2 }).unitPriceYen).toBeNull(); // 省略は不明（0円にしない）
    expect(priceInputSchema.safeParse({ kind: "sale", amountYen: 100, confirmedOn: "2026-10-29" }).success).toBe(true);
    expect(priceInputSchema.safeParse({ kind: "other", amountYen: 100, confirmedOn: "2026-10-29" }).success).toBe(false);
    expect(parseYen("1,200円")).toBe(1200);
    expect(parseYen("")).toBeNull();
    expect(parseYen("abc")).toBe("invalid");
  });
  it("コレクションの表示設定: 列数は3/4/5（既定4）、形式、演出。コピーの対象に含まれ、お気に入りの順位は含まれない", () => {
    expect(DEFAULT_COLLECTION_PREFS).toEqual({ cols: 4, view: "grid", fx: true });
    expect(normalizeCollectionPrefs({ cols: 5, view: "list", fx: false })).toEqual({ cols: 5, view: "list", fx: false });
    expect(normalizeCollectionPrefs({ cols: 9, view: "x" })).toEqual(DEFAULT_COLLECTION_PREFS);
    expect(normalizeProfileSettings({ collection: { cols: 3 } }).collection?.cols).toBe(3);
    expect(Object.keys(DEFAULT_COLLECTION_PREFS)).not.toContain("favorites");
  });
  it("光沢の演出はハイレアリティだけ", () => {
    expect(isShine("SAR")).toBe(true);
    expect(isShine("sr")).toBe(true);
    expect(isShine("C")).toBe(false);
    expect(isShine("")).toBe(false);
  });
});
