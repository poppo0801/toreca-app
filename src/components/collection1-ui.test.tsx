import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ZukanData } from "@/app/(app)/zukan/actions";
import type { MarketData } from "@/app/(app)/market-memo/actions";

/** 2026-11-17 12:00 JST */
const NOW = new Date("2026-11-17T03:00:00Z");
const PID = "00000000-0000-4000-8000-000000000001";
let zdata: ZukanData = { cards: [], prices: [] };
let mdata: MarketData = { cards: [], prices: [], purchases: [] };
const ok = { ok: true as const };

const loadZukan = vi.fn(async (_p: string) => ({ ok: true as const, data: zdata }));
const saveCard = vi.fn(async (..._a: unknown[]) => ({ ok: true as const, id: "x" }));
const deleteCard = vi.fn(async (..._a: unknown[]) => ok);
const addPrice = vi.fn(async (..._a: unknown[]) => ({ ok: true as const, id: "p" }));
const buyZ = vi.fn(async (..._a: unknown[]) => ({ ok: true as const, cardId: "c" }));
vi.mock("@/app/(app)/zukan/actions", () => ({
  loadZukanAction: (p: string) => loadZukan(p),
  saveZukanCardAction: (...a: unknown[]) => saveCard(...a),
  deleteZukanCardAction: (...a: unknown[]) => deleteCard(...a),
  addZukanPriceAction: (...a: unknown[]) => addPrice(...a),
  updateZukanPriceAction: vi.fn(async () => ok),
  deleteZukanPriceAction: vi.fn(async () => ok),
  buyZukanFromPriceAction: (...a: unknown[]) => buyZ(...a),
  exportZukanAction: vi.fn(async () => ({ ok: true, json: "{}" })),
}));
const loadMarket = vi.fn(async (_p: string) => ({ ok: true as const, data: mdata }));
const createCard = vi.fn(async (..._a: unknown[]): Promise<unknown> => ({ ok: true, id: "m1", reused: false }));
const addMPrice = vi.fn(async (..._a: unknown[]) => ({ ok: true as const, id: "mp" }));
const buyM = vi.fn(async (..._a: unknown[]) => ({ ok: true as const, purchaseId: "b" }));
vi.mock("@/app/(app)/market-memo/actions", () => ({
  loadMarketAction: (p: string) => loadMarket(p),
  createMarketCardAction: (...a: unknown[]) => createCard(...a),
  addMarketPriceAction: (...a: unknown[]) => addMPrice(...a),
  updateMarketPriceAction: vi.fn(async () => ok),
  deleteMarketPriceAction: vi.fn(async () => ok),
  updateMarketCardAction: vi.fn(async () => ok),
  deleteMarketCardAction: vi.fn(async () => ok),
  buyMarketFromPriceAction: (...a: unknown[]) => buyM(...a),
  exportMarketAction: vi.fn(async () => ({ ok: true, json: "{}" })),
}));
let appSettings: { zukanRareMissing?: number[] } = {};
const saveSettingsMock = vi.fn(async (p: Record<string, unknown>) => {
  appSettings = { ...appSettings, ...p };
  return { ok: true as const };
});
vi.mock("@/components/app-provider", () => ({ useApp: () => ({ profile: { id: PID, label: "A" }, now: NOW, settings: appSettings, saveSettings: (p: Record<string, unknown>) => saveSettingsMock(p) }) }));

import { MarketMemoView } from "@/components/market-memo-view";
import { ZukanView } from "@/components/zukan-view";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root;
let host: HTMLDivElement;
const q = (id: string) => document.body.querySelector<HTMLElement>(`[data-testid="${id}"]`);
const qa = (id: string) => [...document.body.querySelectorAll<HTMLElement>(`[data-testid="${id}"]`)];
const flush = () => act(async () => void (await new Promise((r) => setTimeout(r, 0))));
const click = async (el: Element | null) => {
  await act(async () => void (el as HTMLElement).click());
  await flush();
};
const type = async (el: HTMLInputElement | HTMLSelectElement, value: string) => {
  await act(async () => {
    const proto = el instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, "value")!.set!.call(el, value);
    el.dispatchEvent(new Event(el instanceof HTMLSelectElement ? "change" : "input", { bubbles: true }));
  });
};
const mount = async (el: React.ReactElement) => {
  await act(async () => root.render(el));
  await flush();
};
const zc = (o: Record<string, unknown> = {}) => ({ id: "c1", profileId: PID, dexNo: 25, cardName: "ピカチュウ", setName: "", cardNumber: "", rarity: "", quantity: 1, acquiredOn: null, acquireMethod: "pack_opening", purchaseAmountYen: null, storeName: "", condition: "", memo: "", priceRecordId: null, ...o }) as ZukanData["cards"][number];
const zp = (o: Record<string, unknown> = {}) => ({ id: "r1", profileId: PID, dexNo: 25, cardName: "ピカチュウ", setName: "", cardNumber: "", rarity: "", storeName: "A店", chainName: "", surveyedOn: "2026-11-10", condition: "A", priceYen: 1000, note: "", createdAt: "2026-11-10T00:00:00Z", ...o }) as ZukanData["prices"][number];

beforeEach(() => {
  zdata = { cards: [], prices: [] };
  mdata = { cards: [], prices: [], purchases: [] };
  for (const f of [loadZukan, saveCard, deleteCard, addPrice, buyZ, loadMarket, createCard, addMPrice, buyM]) f.mockClear();
  createCard.mockImplementation(async () => ({ ok: true, id: "m1", reused: false }));
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  document.body.innerHTML = "";
});

describe("151図鑑の画面", () => {
  it("151匹を番号順に表示。収集済みは背景色とチェックマーク。上部に 収集済み/151・達成率・未収集。絞り込みができる。展開で登録カード枚数・単品購入金額合計", async () => {
    zdata = { cards: [zc({ dexNo: 25, quantity: 2, acquireMethod: "single_purchase", purchaseAmountYen: 500 }), zc({ id: "c2", dexNo: 25, cardName: "ピカチュウV" }), zc({ id: "c3", dexNo: 6, cardName: "リザードン" })], prices: [] };
    await mount(createElement(ZukanView));
    expect(qa("zukan-item")).toHaveLength(151);
    expect(qa("zukan-item")[0].textContent).toContain("フシギダネ");
    expect(qa("zukan-item")[24].textContent).toContain("ピカチュウ");
    expect(q("zukan-count")!.textContent).toBe("2 / 151"); // 同じポケモンの複数カードは1匹
    expect(q("zukan-rate")!.textContent).toBe("1.3%");
    expect(q("zukan-uncollected")!.textContent).toBe("未収集 149");
    const pika = q("zukan-list")!.querySelector('[data-no="25"]')!;
    expect(pika.getAttribute("data-collected")).toBe("true");
    expect(pika.getAttribute("data-status")).toBe("owned");
    expect(pika.className).toContain("bg-white"); // 入手済みは白ベース
    expect(pika.querySelector("svg")).not.toBeNull(); // チェックマーク
    expect(pika.querySelector('[data-testid="dex-image"]')!.getAttribute("data-dim")).toBe("false"); // 通常の色
    expect(q("zukan-list")!.querySelector('[data-no="1"] [data-testid="dex-image"]')!.getAttribute("data-dim")).toBe("true"); // 未入手は半透明
    expect(pika.textContent).not.toContain("入手済み"); // 文字バッジは出さない
    expect(q("zukan-list")!.querySelector('[data-no="1"]')!.getAttribute("data-collected")).toBe("false");
    await click(q("zukan-summary-toggle"));
    expect(q("zukan-cards")!.textContent).toBe("4枚");
    expect(q("zukan-total")!.textContent).toBe("1,000円"); // パック開封は含めない
    await click([...document.body.querySelectorAll('[data-testid="zukan-filter"] button')][1]); // 収集済み
    expect(qa("zukan-item").map((e) => e.getAttribute("data-no"))).toEqual(["6", "25"]);
    await click([...document.body.querySelectorAll('[data-testid="zukan-filter"] button')][2]); // 未収集
    expect(qa("zukan-item")).toHaveLength(149);
  });

  it("エクスポートのボタンは無く、並び替え（図鑑番号順⇔五十音順）がある。五十音順は名称の読み順", async () => {
    await mount(createElement(ZukanView));
    expect(q("zukan-export")).toBeNull();
    expect(q("zukan-sort")!.getAttribute("data-sort")).toBe("no");
    await click(q("zukan-sort"));
    expect(q("zukan-sort")!.getAttribute("data-sort")).toBe("kana");
    const names = qa("zukan-item").map((e) => e.getAttribute("data-no"));
    expect(names).toHaveLength(151);
    expect(qa("zukan-item")[0].textContent).toContain("ア"); // 先頭はア行の名前
    expect(names).not.toEqual([...names].sort((x, y) => Number(x) - Number(y))); // 番号順とは異なる並び
  });

  it("状態は 入手済み > 相場登録済み > 対象レア未収録 > 未登録。相場の記録のあるポケモンは相場登録済み、手動フラグは相場なしのときだけ対象レア未収録。詳細で状態と解除ができる", async () => {
    zdata = { cards: [zc({ dexNo: 25 })], prices: [{ id: "p1", profileId: PID, dexNo: 6, cardName: "リザードン", setName: "", cardNumber: "", rarity: "", storeName: "店", chainName: "", surveyedOn: "2026-11-10", condition: "A", priceYen: 1000, note: "", createdAt: "2026-11-10T00:00:00Z" }] };
    appSettings = { zukanRareMissing: [6, 150, 1] }; // 6 は相場あり（相場が優先）／150・1 は未入手
    await mount(createElement(ZukanView));
    const st = (no: number) => q("zukan-list")!.querySelector(`[data-no="${no}"]`)!.getAttribute("data-status");
    expect(st(25)).toBe("owned");
    expect(st(6)).toBe("market");
    expect(st(1)).toBe("rare_missing");
    expect(st(150)).toBe("rare_missing");
    expect(st(2)).toBe("unregistered");
    // 詳細: 状態の表示。フラグを外すと未登録に戻る（保存される）
    await click(q("zukan-list")!.querySelector('[data-no="1"]'));
    expect(q("zukan-status-text")!.textContent).toContain("対象レア未収録");
    expect((q("rare-missing-toggle") as HTMLInputElement).checked).toBe(true);
    await click(q("rare-missing-toggle"));
    expect(saveSettingsMock).toHaveBeenCalledWith({ zukanRareMissing: [6, 150] });
  });

  it("入手済みの詳細には「対象レア未収録」の切替を出さない（入手済みが優先）", async () => {
    zdata = { cards: [zc({ dexNo: 25 })], prices: [] };
    appSettings = {};
    await mount(createElement(ZukanView));
    await click(q("zukan-list")!.querySelector('[data-no="25"]'));
    expect(q("rare-missing-toggle")).toBeNull();
    expect(q("zukan-status-text")!.textContent).toContain("入手済み");
  });

  it("カード登録: 金額が空欄ならパック開封（金額は null＝0円ではない）、「0」は単品購入の0円。方法と金額が矛盾するときは保存せずエラー", async () => {
    await mount(createElement(ZukanView));
    await click(q("zukan-list")!.querySelector('[data-no="25"]'));
    await click(q("card-add"));
    await type(q("card-name") as HTMLInputElement, "ピカチュウ（テスト）");
    await click(q("card-submit"));
    expect(saveCard).toHaveBeenCalledTimes(1);
    expect(saveCard.mock.calls[0][2]).toMatchObject({ dexNo: 25, cardName: "ピカチュウ（テスト）", acquireMethod: "pack_opening", purchaseAmountYen: null, quantity: 1 });
    // 0円
    await click(q("card-add"));
    await type(q("card-amount") as HTMLInputElement, "0");
    await click(q("card-submit"));
    expect(saveCard.mock.calls[1][2]).toMatchObject({ acquireMethod: "single_purchase", purchaseAmountYen: 0 });
    // 矛盾: 単品購入を選んだのに金額が空欄
    await click(q("card-add"));
    await click(q("card-method")!.querySelectorAll("button")[0]);
    await click(q("card-submit"));
    expect(saveCard).toHaveBeenCalledTimes(2);
    expect(q("card-error")!.textContent).toContain("購入金額が必要");
    // 矛盾: パック開封を選んだのに金額あり
    await click(q("card-method")!.querySelectorAll("button")[1]);
    await type(q("card-amount") as HTMLInputElement, "300");
    await click(q("card-submit"));
    expect(saveCard).toHaveBeenCalledTimes(2);
    expect(q("card-error")!.textContent).toContain("入力しません");
  });

  it("カードの削除は確認が必要。確認するまで削除しない", async () => {
    zdata = { cards: [zc()], prices: [] };
    await mount(createElement(ZukanView));
    await click(q("zukan-list")!.querySelector('[data-no="25"]'));
    await click(q("card-delete"));
    expect(deleteCard).not.toHaveBeenCalled();
    expect(q("del-card-dialog")!.textContent).toContain("価格調査の履歴・他の購入記録には影響しません");
    await click(q("del-card-ok"));
    expect(deleteCard).toHaveBeenCalledWith(PID, "c1");
  });

  it("価格調査: 初期は状態の良い順→価格の安い順。切替で価格順。30日超は参考価格で最安の強調から除外", async () => {
    zdata = { cards: [], prices: [zp({ id: "a", condition: "B", priceYen: 300 }), zp({ id: "b", condition: "A+", priceYen: 900 }), zp({ id: "c", condition: "A", priceYen: 500, surveyedOn: "2026-09-01" }), zp({ id: "d", condition: "A", priceYen: 450 })] };
    await mount(createElement(ZukanView));
    await click(q("zukan-list")!.querySelector('[data-no="25"]'));
    const order = () => qa("price-row").map((r) => r.querySelector('[data-testid="price-rank-label"]')!.textContent + ":" + r.textContent!.match(/(\d[\d,]*)円/)![1]);
    expect(order()).toEqual(["A+:900", "A:450", "A:500", "B:300"]);
    await click(q("price-sort")!.querySelectorAll("button")[1]);
    expect(order()).toEqual(["B:300", "A:450", "A:500", "A+:900"]);
    const rows = qa("price-row");
    expect(rows.find((r) => r.textContent!.includes("500円"))!.getAttribute("data-ref")).toBe("true");
    expect(rows.find((r) => r.textContent!.includes("500円"))!.textContent).toContain("参考価格");
    expect(rows.filter((r) => r.getAttribute("data-best") === "true").map((r) => r.textContent!.match(/(\d[\d,]*)円/)![1])).toEqual(["300"]);
  });

  it("「この価格で購入」: 確認のあと1回だけ購入処理を呼ぶ。購入済みの記録は押せない（二重購入の防止）。購入後も価格の記録は一覧に残る", async () => {
    zdata = { cards: [zc({ id: "k", priceRecordId: "bought" })], prices: [zp({ id: "r1" }), zp({ id: "bought", priceYen: 700 })] };
    await mount(createElement(ZukanView));
    await click(q("zukan-list")!.querySelector('[data-no="25"]'));
    const buttons = qa("price-buy");
    expect(buttons).toHaveLength(2);
    expect(buttons.find((b) => b.textContent === "購入済み")).toBeTruthy();
    expect((buttons.find((b) => b.textContent === "購入済み") as HTMLButtonElement).disabled).toBe(true);
    await click(buttons.find((b) => b.textContent === "この価格で購入")!);
    expect(buyZ).not.toHaveBeenCalled();
    await click(q("buy-ok"));
    expect(buyZ).toHaveBeenCalledTimes(1);
    expect(buyZ).toHaveBeenCalledWith(PID, "r1", "2026-11-17");
  });
});

describe("相場調査メモの画面", () => {
  const mcard = (o: Record<string, unknown> = {}) => ({ id: "m1", profileId: PID, name: "リザードンex", setName: "スカーレットex", cardNumber: "006/078", rarity: "SR", note: "", createdAt: "2026-11-01T00:00:00Z", ...o }) as MarketData["cards"][number];
  const mprice = (o: Record<string, unknown> = {}) => ({ id: "mp1", profileId: PID, cardId: "m1", storeName: "A店", chainName: "", surveyedOn: "2026-11-10", condition: "A", priceYen: 1000, note: "", createdAt: "2026-11-10T00:00:00Z", ...o }) as MarketData["prices"][number];

  it("カード一覧に最安値と＋ボタン。購入済みのカードは既定で非表示（チェックで表示）。検索できる", async () => {
    mdata = { cards: [mcard(), mcard({ id: "m2", name: "ピカチュウ", setName: "151", cardNumber: "025/165" }), mcard({ id: "m3", name: "買った札", setName: "x", cardNumber: "1" })], prices: [mprice(), mprice({ id: "mp2", cardId: "m1", storeName: "B店", priceYen: 800 }), mprice({ id: "mp3", cardId: "m3" })], purchases: [{ id: "b1", cardId: "m3", priceId: "mp3", purchasedOn: "2026-11-11", storeName: "A店", priceYen: 1000, condition: "A" }] };
    await mount(createElement(MarketMemoView));
    expect(qa("market-card")).toHaveLength(2);
    expect(qa("market-card")[0].querySelector('[data-testid="market-card-summary"]')!.textContent).toContain("800円");
    expect(qa("market-card")[0].querySelector('[data-testid="market-card-summary"]')!.textContent).toContain("B店");
    expect(qa("market-card-plus")).toHaveLength(2);
    await click(q("market-show-bought"));
    expect(qa("market-card")).toHaveLength(3);
    await type(q("market-search") as HTMLInputElement, "ピカ");
    expect(qa("market-card")).toHaveLength(1);
  });

  it("カード名に151のポケモン名があれば画像を出す。入手状態に関係なく常に通常の不透明度（図鑑の未入手の半透明を適用しない）。該当なしは画像なし", async () => {
    mdata = { cards: [mcard(), mcard({ id: "m2", name: "博士のサポート", setName: "x", cardNumber: "9" })], prices: [], purchases: [] };
    await mount(createElement(MarketMemoView));
    const rows = qa("market-card");
    const img = rows[0].querySelector('[data-testid="dex-image"]') as HTMLImageElement;
    expect(img.getAttribute("src")).toBe("/api/zukan-image/6?v=1"); // リザードンex → No.6
    expect(img.getAttribute("data-dim")).toBe("false");
    expect(img.className).not.toContain("opacity-35");
    expect(rows[1].querySelector('[data-testid="dex-image"]')).toBeNull();
  });

  it("状態違いの価格を同じ店舗・調査日でまとめて登録できる。同じ状態の重複・入力不足は保存前に止める", async () => {
    mdata = { cards: [mcard()], prices: [], purchases: [] };
    await mount(createElement(MarketMemoView));
    await click(q("market-card-plus"));
    await type(q("price-store") as HTMLInputElement, "B店");
    await click(q("price-rank")!.querySelectorAll("button")[1]); // A
    await type(q("price-yen") as HTMLInputElement, "1200");
    await click(q("price-extra-add"));
    const row = q("price-extra-row")!;
    await type(row.querySelector("select") as HTMLSelectElement, "B");
    await type(row.querySelector("input") as HTMLInputElement, "900");
    await click(q("price-submit"));
    expect(addMPrice).toHaveBeenCalledTimes(2);
    expect(addMPrice.mock.calls.map((c) => (c[2] as { condition: string; priceYen: number; storeName: string }))).toMatchObject([
      { condition: "A", priceYen: 1200, storeName: "B店" },
      { condition: "B", priceYen: 900, storeName: "B店" },
    ]);
    // 重複する状態
    addMPrice.mockClear();
    mdata = { cards: [mcard()], prices: [], purchases: [] };
    await click(q("market-card-plus"));
    await type(q("price-store") as HTMLInputElement, "B店");
    await click(q("price-rank")!.querySelectorAll("button")[1]);
    await type(q("price-yen") as HTMLInputElement, "1200");
    await click(q("price-extra-add"));
    await type(q("price-extra-row")!.querySelector("select") as HTMLSelectElement, "A");
    await type(q("price-extra-row")!.querySelector("input") as HTMLInputElement, "1000");
    await click(q("price-submit"));
    expect(addMPrice).not.toHaveBeenCalled();
    expect(q("price-error")!.textContent).toContain("重複");
  });

  it("カードと価格の登録: カード→価格の順に保存。店舗の候補（過去の入力）をタップで再入力でき、状態ランクは5つのボタン。調査日は今日が初期値。自動フォーカスしない", async () => {
    mdata = { cards: [mcard()], prices: [mprice({ storeName: "過去の店" })], purchases: [] };
    await mount(createElement(MarketMemoView));
    await click(q("market-add"));
    expect(document.activeElement?.tagName).not.toBe("INPUT"); // 自動フォーカスしない
    expect((q("price-date") as HTMLInputElement).value).toBe("2026-11-17");
    expect([...q("price-rank")!.querySelectorAll("button")].map((b) => b.textContent!.trim())).toEqual(["A+", "A", "B+", "B", "C"]);
    await type(q("market-card-name") as HTMLInputElement, "メタモン");
    await click(q("store-chips")!.querySelector("button"));
    expect((q("price-store") as HTMLInputElement).value).toBe("過去の店");
    await click(q("price-rank")!.querySelectorAll("button")[1]);
    await type(q("price-yen") as HTMLInputElement, "1,200");
    await click(q("price-submit"));
    expect(createCard).toHaveBeenCalledTimes(1);
    expect(createCard.mock.calls[0][1]).toMatchObject({ name: "メタモン" });
    expect(createCard.mock.calls[0][2]).toBe(false);
    expect(addMPrice).toHaveBeenCalledTimes(1);
    expect(addMPrice.mock.calls[0][1]).toBe("m1");
    expect(addMPrice.mock.calls[0][2]).toMatchObject({ storeName: "過去の店", condition: "A", priceYen: 1200, surveyedOn: "2026-11-17" });
    expect(q("market-add-sheet")).toBeNull(); // 保存後は元の一覧に戻る
  });

  it("同じカードか曖昧なとき: 既存のカードに追加するか、別のカードとして登録するかを選ばせる（勝手に統合も新規作成もしない）", async () => {
    mdata = { cards: [mcard()], prices: [], purchases: [] };
    createCard.mockImplementationOnce(async () => ({ ok: false, error: "同じカードか判断できません", ambiguous: [mcard()] }));
    await mount(createElement(MarketMemoView));
    await click(q("market-add"));
    await type(q("market-card-name") as HTMLInputElement, "リザードンex");
    await type(q("price-store") as HTMLInputElement, "X店");
    await click(q("price-rank")!.querySelectorAll("button")[0]);
    await type(q("price-yen") as HTMLInputElement, "500");
    await click(q("price-submit"));
    expect(addMPrice).not.toHaveBeenCalled();
    expect(q("market-ambiguous")).not.toBeNull();
    await click(q("market-use-existing"));
    expect(addMPrice).toHaveBeenCalledWith(PID, "m1", expect.objectContaining({ storeName: "X店", priceYen: 500 }));
  });

  it("一覧の「＋」から価格だけを素早く追加。左スワイプでも同じ操作ができる", async () => {
    mdata = { cards: [mcard()], prices: [], purchases: [] };
    await mount(createElement(MarketMemoView));
    await click(q("market-card-plus"));
    expect(q("market-quick-sheet")).not.toBeNull();
    await type(q("price-store") as HTMLInputElement, "Y店");
    await click(q("price-rank")!.querySelectorAll("button")[2]);
    await type(q("price-yen") as HTMLInputElement, "700");
    await click(q("price-submit"));
    expect(addMPrice).toHaveBeenCalledWith(PID, "m1", expect.objectContaining({ storeName: "Y店", condition: "B+", priceYen: 700 }));
    expect(q("market-quick-sheet")).toBeNull();
    // 左スワイプ
    const row = q("market-card")!;
    const touch = (type: string, x: number, y: number) => {
      const e = new Event(type, { bubbles: true }) as Event & { touches: unknown[]; changedTouches: unknown[] };
      e.touches = type === "touchend" ? [] : [{ clientX: x, clientY: y }];
      e.changedTouches = [{ clientX: x, clientY: y }];
      return e;
    };
    await act(async () => void row.dispatchEvent(touch("touchstart", 300, 100)));
    await act(async () => void row.dispatchEvent(touch("touchend", 180, 105)));
    await flush();
    expect(q("market-quick-sheet")).not.toBeNull();
  });

  it("カード詳細: 状態優先／価格順の切替、30日超は参考価格、同じ店舗の推移、購入は確認のあと1回だけ・購入済みは押せない", async () => {
    mdata = {
      cards: [mcard()],
      prices: [mprice({ id: "a", storeName: "A店", condition: "B", priceYen: 600 }), mprice({ id: "b", storeName: "A店", condition: "A", priceYen: 900, surveyedOn: "2026-08-01" }), mprice({ id: "c", storeName: "C店", condition: "A+", priceYen: 1500 })],
      purchases: [{ id: "x", cardId: "m1", priceId: "c", purchasedOn: "2026-11-11", storeName: "C店", priceYen: 1500, condition: "A+" }],
    };
    await mount(createElement(MarketMemoView));
    await click(q("market-show-bought"));
    await click(q("market-card-open"));
    const order = () => qa("price-row").map((r) => r.querySelector('[data-testid="price-rank-label"]')!.textContent);
    expect(order()).toEqual(["A+", "A", "B"]);
    await click(q("price-sort")!.querySelectorAll("button")[1]);
    expect(order()).toEqual(["B", "A", "A+"]);
    expect(qa("price-row").find((r) => r.textContent!.includes("900円"))!.textContent).toContain("参考価格");
    await click(qa("price-history-toggle")[0]);
    expect(q("price-history")!.querySelectorAll("li")).toHaveLength(2); // A店の過去の調査も残っている
    const buys = qa("price-buy");
    expect((buys.find((b) => b.textContent === "購入済み") as HTMLButtonElement).disabled).toBe(true);
    await click(buys.find((b) => b.textContent === "この価格で購入")!);
    await click(q("buy-ok"));
    expect(buyM).toHaveBeenCalledTimes(1);
  });
});
