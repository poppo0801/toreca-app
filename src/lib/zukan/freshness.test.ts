// @vitest-environment node
/** 販売情報の最新化・更新・完売、新着順の基準、番号・レアリティの候補、購入予定の合計（二重計上なし）。 */
import { describe, expect, it } from "vitest";
import { mergeDaily, plannedTotals, type DailyRecord } from "./daily";
import { activityOf, currentWithStatus, displayPrices, indexEvents, splitCurrent, statusOf, type PriceEvent } from "./freshness";
import { numberCandidates, rarityCandidates, sortMarketCards, type KnownCard } from "./zukan";

let n = 0;
const rec = (o: Partial<{ id: string; storeName: string; chainName: string; condition: string; surveyedOn: string; createdAt: string; priceYen: number }> = {}) => ({ id: `r${++n}`, storeName: "垂水店", chainName: "トレカキャピタル", condition: "A", surveyedOn: "2026-10-01", createdAt: `2026-10-01T0${Math.min(n, 9)}:00:00Z`, priceYen: 1500, ...o });
const ev = (recordKey: string, event: "confirmed" | "sold_out", happenedOn: string, createdAt = `${happenedOn}T09:00:00Z`): PriceEvent => ({ recordKey, event, happenedOn, createdAt });

describe("最新の販売情報（同一カード・同一系列店舗・同一状態の最新1件）", () => {
  it("10/1 A 1,500円 と 10/30 A 1,000円 → 通常は 1,000円だけ。古い記録は残る（削除しない）。状態・店舗が違えば別の販売情報", () => {
    const old = rec({ id: "old", surveyedOn: "2026-10-01", priceYen: 1500 });
    const cur = rec({ id: "new", surveyedOn: "2026-10-30", priceYen: 1000 });
    const otherCond = rec({ id: "b", condition: "B", surveyedOn: "2026-10-01", priceYen: 900 });
    const otherStore = rec({ id: "s", storeName: "梅田店", surveyedOn: "2026-10-01", priceYen: 1400 });
    const { current, superseded } = splitCurrent([old, cur, otherCond, otherStore]);
    expect(current.map((r) => r.id).sort()).toEqual(["b", "new", "s"]);
    expect(superseded.map((r) => r.id)).toEqual(["old"]);
  });
  it("同じ日に同条件の複数記録: 作成の新しい1件が現在で、他は古い記録として残る（消えない・統合しない）。表記ゆれ（空白・全角）の店舗は同じ店舗", () => {
    const a = rec({ id: "a", surveyedOn: "2026-10-30", createdAt: "2026-10-30T01:00:00Z" });
    const b = rec({ id: "b", surveyedOn: "2026-10-30", createdAt: "2026-10-30T02:00:00Z", storeName: "垂水 店" });
    const { current, superseded } = splitCurrent([a, b]);
    expect(current.map((r) => r.id)).toEqual(["b"]);
    expect(superseded.map((r) => r.id)).toEqual(["a"]);
    expect(splitCurrent([a, b]).current.length + splitCurrent([a, b]).superseded.length).toBe(2);
  });
  it("カードごとに別の販売情報（151図鑑は同じポケモンの複数カードが混ざる）", () => {
    const x = rec({ id: "x" });
    const y = rec({ id: "y" });
    expect(splitCurrent([x, y], (r) => (r.id === "x" ? "cardA" : "cardB")).current).toHaveLength(2);
  });
});

describe("更新（確認）と完売", () => {
  it("更新で最終確認日が進む（価格記録は変えない）。完売の後の更新で販売中に戻る。完売の後に更新が無ければ完売のまま", () => {
    const r = rec({ id: "r", surveyedOn: "2026-10-01" });
    const idx = indexEvents([ev("market:r", "confirmed", "2026-10-20"), ev("market:r", "sold_out", "2026-10-25"), ev("market:r", "confirmed", "2026-10-28")]);
    expect(statusOf(r, idx.get("market:r"))).toMatchObject({ soldOut: false, lastConfirmedOn: "2026-10-28" });
    expect(statusOf(r, idx.get("market:r"), "2026-10-26")).toMatchObject({ soldOut: true, soldOutOn: "2026-10-25", lastConfirmedOn: "2026-10-20" });
    expect(statusOf(r, idx.get("market:r"), "2026-10-10")).toMatchObject({ soldOut: false, lastConfirmedOn: "2026-10-01" }); // 過去の日の表示は、その日までの事象で再現（後日の更新・完売で変わらない）
    expect(statusOf(r, undefined)).toMatchObject({ soldOut: false, lastConfirmedOn: "2026-10-01" });
  });
  it("同じ作成日時の事象は入力順。表示用の代表価格: 販売中が1つでもあれば販売中のみ、すべて完売なら完売のものを参考として残す。確認日が日付として使われる", () => {
    const a = rec({ id: "a", priceYen: 500 });
    const b = rec({ id: "b", storeName: "梅田店", priceYen: 800 });
    const idx = indexEvents([ev("market:a", "sold_out", "2026-10-02"), ev("market:b", "confirmed", "2026-10-29")]);
    const { current } = currentWithStatus([a, b], idx, (r) => `market:${r.id}`);
    const dp = displayPrices(current);
    expect(dp.map((r) => r.id)).toEqual(["b"]); // 安い 500円は完売なので代表にしない
    expect(dp[0].shownSurveyedOn).toBe("2026-10-29");
    const all = currentWithStatus([a], idx, (r) => `market:${r.id}`).current;
    expect(displayPrices(all).map((r) => [r.id, r.soldOut])).toEqual([["a", true]]); // 完売だけのカードは、完売として残す
    const same = indexEvents([ev("market:z", "confirmed", "2026-10-02", "t"), ev("market:z", "sold_out", "2026-10-02", "t")]);
    expect(statusOf({ surveyedOn: "2026-10-01" }, same.get("market:z")).soldOut).toBe(true);
  });
});

describe("新着順の基準（相場の更新日時）", () => {
  it("カードの登録日時ではなく、価格記録の登録・更新と更新/完売の記録で決まる。無関係な編集では変わらない", () => {
    expect(activityOf("2026-01-01T00:00:00Z", ["2026-10-01T00:00:00Z", ""], [])).toBe("2026-10-01T00:00:00Z");
    expect(activityOf("2026-01-01T00:00:00Z", ["2026-10-01T00:00:00Z"], ["2026-11-02T00:00:00Z"])).toBe("2026-11-02T00:00:00Z"); // 更新・完売の記録で上位へ
    expect(activityOf("2026-11-05T00:00:00Z", [], [])).toBe("2026-11-05T00:00:00Z"); // 価格の無いカードは登録日時
    const cards = [
      { id: "old", createdAt: "2026-01-01T00:00:00Z" },
      { id: "new", createdAt: "2026-11-01T00:00:00Z" },
    ];
    const act = new Map([["old", "2026-11-10T00:00:00Z"], ["new", "2026-11-02T00:00:00Z"]]);
    expect(sortMarketCards(cards, [], "new", "2026-11-23", undefined, act).map((c) => c.id)).toEqual(["old", "new"]); // 古いカードでも新しい相場記録があれば上位
    expect(sortMarketCards(cards, [], "new", "2026-11-23").map((c) => c.id)).toEqual(["new", "old"]); // 無ければ登録日時
  });
});

describe("番号・レアリティの候補（実際のデータだけが根拠）", () => {
  const known: KnownCard[] = [
    { cardNumber: "100/106", setName: "SV8", rarity: "SAR", name: "ミロカロス", usedAt: "2026-11-10T00:00:00Z" },
    { cardNumber: "100/106", setName: "SV8", rarity: "SAR", name: "ミロカロス", usedAt: "2026-11-20T00:00:00Z" },
    { cardNumber: "100/106", setName: "SV9", rarity: "AR", name: "別カード", usedAt: "2026-11-15T00:00:00Z" },
    { cardNumber: "050/106", setName: "SV8", rarity: "SR", usedAt: "2026-11-01T00:00:00Z" },
    { cardNumber: "", setName: "SV8", rarity: "UR" },
  ];
  it("空のとき最近使った順。先頭1文字から絞り込み。同じ組は1つにまとめる。番号の無い記録は候補にしない。同じ番号が別セットなら別の候補", () => {
    expect(numberCandidates(known, "").map((c) => `${c.cardNumber}|${c.setName}|${c.rarity}`)).toEqual(["100/106|SV8|SAR", "100/106|SV9|AR", "050/106|SV8|SR"]);
    expect(numberCandidates(known, "1").map((c) => c.setName)).toEqual(["SV8", "SV9"]); // 番号だけでは一意に決まらない → 候補が並ぶ
    expect(numberCandidates(known, "05").map((c) => c.cardNumber)).toEqual(["050/106"]);
    expect(numberCandidates(known, "９").length).toBe(0); // 全角の9にも対応（該当なし）
    expect(numberCandidates(known, "１").length).toBe(2); // 全角の1 = 半角の1
    expect(numberCandidates(known, "999")).toEqual([]); // 一覧に無い番号は候補なし（自由入力）
  });
  it("レアリティの候補: 最近使ったもの→一般的な表記。先頭の1文字で絞り込み", () => {
    expect(rarityCandidates(known, "").slice(0, 3)).toEqual(["SAR", "AR", "SR"]);
    expect(rarityCandidates(known, "S").every((r) => r.toUpperCase().startsWith("S"))).toBe(true);
    expect(rarityCandidates(known, "u")).toContain("UR");
    expect(rarityCandidates(known, "zzz")).toEqual([]);
  });
});

describe("購入予定の合計（二重計上しない）", () => {
  const r = (o: Partial<DailyRecord>): DailyRecord => ({ source: "market", id: `d${++n}`, cardName: "ミロカロス", setName: "SV8", cardNumber: "100/106", rarity: "SAR", chainName: "系列", storeName: "A店", condition: "A", priceYen: 1000, note: "", createdAt: `2026-11-23T0${Math.min(n, 9)}:00:00Z`, surveyedOn: "2026-11-23", ...o });
  it("同じ調査記録が両方の記録元にあっても1枚。完売・店舗数も集計する", () => {
    const a1 = r({ source: "market" });
    const a2 = r({ source: "zukan" }); // 同じ内容（別の記録元）
    const b = r({ storeName: "B店", priceYen: 2500, soldOut: true });
    const rows = mergeDaily([a1, a2, b], new Set([`market:${a1.id}`, `zukan:${a2.id}`, `market:${b.id}`]));
    expect(rows).toHaveLength(2);
    expect(plannedTotals(rows)).toEqual({ count: 2, totalYen: 3500, soldOut: 1, stores: ["系列 A店", "系列 B店"] });
    expect(plannedTotals(mergeDaily([a1, a2, b], new Set()))).toMatchObject({ count: 0, totalYen: 0 });
  });
});
