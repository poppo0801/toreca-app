import { describe, expect, it } from "vitest";
import { ONLINE_STORE_NAME, chainStoreLine, isOnlineStore, isOnlineStoreName, onlineStoreLabel } from "@/lib/store-online";
import { storeKey } from "@/lib/store-name";
import { matchStore } from "@/lib/lottery-match";
import { inputScrollDelta } from "@/lib/use-scroll-input-into-view";
import { storeRefLines, storeRefTotal, storeAdminErrorText } from "@/lib/store-admin";
import type { Store } from "@/types/domain";

const st = (o: Partial<Store> & { id: string; name: string }): Store => ({ chainId: "c1", prefecture: "", ...o }) as Store;

describe("Stage 7S: オンライン店舗の統一", () => {
  it("表記ゆれを同じオンライン店舗として判定する（実店舗は対象外）", () => {
    for (const n of ["オンライン", "通販", "通販店", "ネットショップ", "ＯＮＬＩＮＥ", "オンライン ストア", "eストア", "公式通販"]) expect(isOnlineStoreName(n), n).toBe(true);
    for (const n of ["梅田店", "オンライン館", "通販センター東京", "", null]) expect(isOnlineStoreName(n as string), String(n)).toBe(false);
    expect(isOnlineStoreName("GEO オンライン", "GEO")).toBe(true);
    expect(isOnlineStore({ name: "なんでも", salesKind: "online_only" })).toBe(true);
  });
  it("店舗キーは表記ゆれを同一視する", () => {
    expect(storeKey("通販店", "晴れる屋2")).toBe(storeKey("オンライン", "晴れる屋2"));
    expect(storeKey("梅田店", "X")).not.toBe(storeKey("通販", "X"));
  });
  it("照合: 表記ゆれの入力は既存のオンライン店舗に一致し、実店舗には一致しない。複数あれば確認", () => {
    const stores = [st({ id: "a", name: "梅田店" }), st({ id: "b", name: ONLINE_STORE_NAME, salesKind: "online_only" })];
    expect(matchStore("オンライン", "c1", stores, "X").item?.id).toBe("b");
    expect(matchStore("通販店", "c1", stores, "X").item?.id).toBe("b");
    expect(matchStore("通販店", "c1", [stores[0]], "X").item).toBeNull();
    const two = [...stores, st({ id: "c", name: "オンライン" })];
    const m = matchStore("通販", "c1", two, "X");
    expect(m.item).toBeNull();
    expect(m.candidates.length).toBe(2);
  });
  it("表示名: 実店舗と混在なら「系列名 通販」、通販だけなら系列名", () => {
    const online = st({ id: "b", name: "通販", salesKind: "online_only" });
    expect(onlineStoreLabel("GEO", [st({ id: "a", name: "伊川谷店" }), online])).toBe("GEO 通販");
    expect(onlineStoreLabel("ポケモンセンター", [online])).toBe("ポケモンセンター");
    expect(onlineStoreLabel("X", [online, st({ id: "p", name: "応募時に店舗選択" })])).toBe("X");
    expect(chainStoreLine("GEO", st({ id: "a", name: "伊川谷店" }), [])).toBe("GEO 伊川谷店");
    expect(chainStoreLine("GEO", online, [st({ id: "a", name: "伊川谷店" }), online])).toBe("GEO 通販");
  });
});

describe("Stage 7S: キーボードで隠れない自動スクロール", () => {
  const vv = { height: 400, offsetTop: 0, scale: 1 };
  it("見えている領域内なら動かさない", () => expect(inputScrollDelta({ top: 100, bottom: 150 }, vv)).toBe(0));
  it("下にはみ出すとその分だけ上へ", () => expect(inputScrollDelta({ top: 380, bottom: 430 }, vv)).toBe(42));
  it("上に隠れていれば戻す", () => expect(inputScrollDelta({ top: -20, bottom: 30 }, vv)).toBe(-32));
  it("ピンチ拡大中・visualViewport 無しは動かさない", () => {
    expect(inputScrollDelta({ top: 380, bottom: 430 }, { ...vv, scale: 2 })).toBe(0);
    expect(inputScrollDelta({ top: 380, bottom: 430 }, null)).toBe(0);
  });
});

describe("Stage 7S: 店舗の削除前の参照表示", () => {
  it("履歴の参照件数だけを数え、別名・距離は無視する", () => {
    const c = { lotteries: 2, applications: 1, aliases: 3, trip_distances: 1 };
    expect(storeRefTotal(c)).toBe(3);
    expect(storeRefLines(c)).toEqual(["抽選 2件", "応募記録 1件"]);
    expect(storeRefTotal({ aliases: 2 })).toBe(0);
  });
  it("エラー文", () => expect(storeAdminErrorText("store is referenced")).toContain("非表示"));
});
