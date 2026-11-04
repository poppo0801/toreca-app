import { describe, expect, it } from "vitest";
import { createMockData } from "@/data/mock";
import { matchExistingLottery, sameName } from "@/lib/collector/crossref";
import { jstDateString } from "@/lib/datetime";

const NOW = new Date("2026-11-03T03:00:00Z");
const d = createMockData(NOW);
const l = d.lotteries[0];
const store = d.stores.find((s) => s.id === l.storeId)!;
const prod = d.products.find((p) => p.id === l.items[0].productId)!;
const due = l.applyDeadline.precision === "date_time" ? jstDateString(new Date(l.applyDeadline.at)) : l.applyDeadline.precision === "date_only" ? l.applyDeadline.date : null;

describe("一覧の事実と登録済み抽選の照合（5X）", () => {
  it("店舗・商品・締切日がそろって一致したときだけ同一と判定し、根拠を返す", () => {
    const m = matchExistingLottery({ store: store.name, product: prod.officialName, dueDate: due }, d);
    expect(m?.lotteryId).toBe(l.id);
    expect(m?.evidence).toHaveLength(3);
  });
  it("商品と締切日だけが一致しても、別の店舗なら同一としない（同じ商品を複数店舗が抽選販売する）", () => {
    expect(matchExistingLottery({ store: "全く別の架空店舗の本店", product: prod.officialName, dueDate: due }, d)).toBeNull();
  });
  it("店舗だけ・締切日が違う・情報が欠けているときは同一としない", () => {
    expect(matchExistingLottery({ store: store.name, product: "別の架空商品パック", dueDate: due }, d)).toBeNull();
    expect(matchExistingLottery({ store: store.name, product: prod.officialName, dueDate: "2000-01-01" }, d)).toBeNull();
    expect(matchExistingLottery({ store: store.name, dueDate: due }, d)).toBeNull();
    expect(matchExistingLottery({ store: store.name, product: prod.officialName, dueDate: null }, d)).toBeNull();
  });
  it("名称の一致: 括弧書きは無視。短い名前の部分一致では一致させない", () => {
    expect(sameName("トレカショップなかよし(久米川駅前)", "トレカショップなかよし")).toBe(true);
    expect(sameName("古本市場", "古本市場竹の塚店")).toBe(false);
    expect(sameName("古本市場 竹の塚店", "古本市場竹の塚店")).toBe(true);
  });
});
