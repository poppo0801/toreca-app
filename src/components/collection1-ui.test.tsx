import { act, createElement } from "react";
import { vi as vitest } from "vitest";

// 画像の配信を有効にした環境（既定は無効=プレースホルダーのみ）での表示を検証する
vitest.hoisted(() => {
  process.env.NEXT_PUBLIC_POKEMON_IMAGES = "on";
});
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
    expect(q("zukan-status-badge")!.textContent).toBe("対象レア未収録"); // 詳細ヘッダーの短い色分けバッジ1個
    expect(q("zukan-sheet")!.textContent).not.toMatch(/手動で付け|価格調査の記録あり|状態:|カードを登録済み/); // 冗長な説明文は無い
    expect(q("rare-missing-toggle")!.closest("section")!.textContent!.trim()).toBe("対象レア未収録"); // チェックと短い項目名だけ（説明文なし）
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
    expect(q("zukan-status-badge")!.textContent).toBe("入手済み");
    expect(q("zukan-status-badge")!.getAttribute("data-status")).toBe("owned");
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

  it("価格一覧: 1件=1ブロック。常時表示は 状態→系列・店舗→調査日→金額（右端）だけで、購入・編集・削除・推移・備考のボタンや文は一覧に無い。初期は状態の良い順、切替で価格順、30日超は参考価格", async () => {
    zdata = { cards: [], prices: [zp({ id: "a", condition: "B", priceYen: 300, chainName: "系列A", storeName: "甲店", note: "秘密のメモ" }), zp({ id: "b", condition: "A+", priceYen: 900 }), zp({ id: "c", condition: "A", priceYen: 500, surveyedOn: "2026-09-01" }), zp({ id: "d", condition: "A", priceYen: 450 })] };
    await mount(createElement(ZukanView));
    await click(q("zukan-list")!.querySelector('[data-no="25"]'));
    const order = () => qa("price-row").map((r) => r.querySelector('[data-testid="price-rank-label"]')!.textContent + ":" + r.querySelector('[data-testid="price-amount"]')!.textContent!.replace(/[^\d]/g, ""));
    expect(order()).toEqual(["A+:900", "A:450", "A:500", "B:300"]);
    // 一覧には操作・補足が無い
    expect(qa("price-buy")).toHaveLength(0);
    expect(qa("price-edit")).toHaveLength(0);
    expect(qa("price-delete")).toHaveLength(0);
    expect(q("price-history")).toBeNull();
    expect(q("price-list")!.textContent).not.toMatch(/この価格で購入|編集|削除|この店の推移|秘密のメモ|参考価格|最安/);
    // 1行の中の順序: 状態 → 系列・店舗 → 調査日 → 金額（右端）
    const row = qa("price-row").find((r) => r.textContent!.includes("甲店"))!;
    const order4 = ["price-rank-label", "price-store", "price-date", "price-amount"].map((id) => [...row.querySelectorAll("*")].indexOf(row.querySelector(`[data-testid="${id}"]`)!));
    expect(order4).toEqual([...order4].sort((x, y) => x - y));
    expect(row.lastElementChild!.getAttribute("data-testid")).toBe("price-amount");
    expect(row.querySelector('[data-testid="price-store"]')!.textContent).toContain("系列A");
    expect(row.querySelector('[data-testid="price-date"]')!.textContent).toBe("11/10"); // 年は詳細で確認
    await click(q("price-sort")!.querySelectorAll("button")[1]);
    expect(order()).toEqual(["B:300", "A:450", "A:500", "A+:900"]);
    const rows = qa("price-row");
    expect(rows.find((r) => r.textContent!.includes("500円"))!.getAttribute("data-ref")).toBe("true");
    expect(rows.filter((r) => r.getAttribute("data-best") === "true").map((r) => r.querySelector('[data-testid="price-amount"]')!.textContent!.replace(/[^\d]/g, ""))).toEqual(["300"]);
  });

  it("価格ブロックをタップすると詳細が開き、備考・最安/参考価格/購入済みの表示・購入/編集/削除がそこに集約される", async () => {
    zdata = { cards: [], prices: [zp({ id: "a", condition: "B", priceYen: 300, note: "秘密のメモ" }), zp({ id: "c", condition: "A", priceYen: 500, surveyedOn: "2026-09-01" })] };
    await mount(createElement(ZukanView));
    await click(q("zukan-list")!.querySelector('[data-no="25"]'));
    await click(qa("price-row").find((r) => r.textContent!.includes("300円"))!);
    const d = q("price-detail")!;
    expect(d.textContent).toContain("秘密のメモ");
    expect(q("price-detail-badges")!.textContent).toContain("最安");
    expect(q("price-buy")).not.toBeNull();
    expect(q("price-edit")).not.toBeNull();
    expect(q("price-delete")).not.toBeNull();
    // 参考価格（30日超）の詳細
    await act(async () => void document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
    await flush();
    await click(qa("price-row").find((r) => r.textContent!.includes("500円"))!);
    expect(q("price-detail-badges")!.textContent).toContain("参考価格");
  });

  it("「この価格で購入」は詳細から。確認のあと1回だけ購入処理を呼ぶ。購入済みの記録は押せない（二重購入の防止）。購入後も価格の記録は一覧に残る", async () => {
    zdata = { cards: [zc({ id: "k", priceRecordId: "bought" })], prices: [zp({ id: "r1" }), zp({ id: "bought", priceYen: 700 })] };
    await mount(createElement(ZukanView));
    await click(q("zukan-list")!.querySelector('[data-no="25"]'));
    expect(qa("price-row").find((r) => r.getAttribute("data-bought") === "true")!.textContent).toContain("700円"); // 一覧には控えめな記号（✓）だけ
    await click(qa("price-row").find((r) => r.getAttribute("data-bought") === "true")!);
    expect(q("price-detail-badges")!.textContent).toContain("購入済み");
    expect((q("price-buy") as HTMLButtonElement).disabled).toBe(true);
    await click(q("price-buy")); // 押せない（何も起きない）
    expect(buyZ).not.toHaveBeenCalled();
    // 別の価格（未購入）を詳細から購入
    await act(async () => void document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
    await flush();
    await click(qa("price-row").find((r) => r.getAttribute("data-bought") === "false")!);
    await click(q("price-buy"));
    expect(buyZ).not.toHaveBeenCalled(); // 確認の前は呼ばない
    await click(q("buy-ok"));
    expect(buyZ).toHaveBeenCalledTimes(1);
    expect(buyZ).toHaveBeenCalledWith(PID, "r1", "2026-11-17");
  });

  it("価格登録フォームの順序: カード名 → 系列 → 店舗 → 調査日 → 販売価格 → 状態ランク → 任意項目（セット・番号・レア・備考）。状態は A が初期選択、レアは AR が初期値", async () => {
    await mount(createElement(ZukanView));
    await click(q("zukan-list")!.querySelector('[data-no="25"]'));
    await click(q("price-add"));
    const form = q("price-form")!;
    const ids = ["price-card-name", "price-chain", "price-store", "price-date", "price-yen", "price-rank", "price-card-set", "price-card-number", "price-card-rarity", "price-note"];
    const pos = ids.map((id) => [...form.querySelectorAll("*")].indexOf(form.querySelector(`[data-testid="${id}"]`)!));
    expect(pos.every((p) => p >= 0)).toBe(true);
    expect(pos).toEqual([...pos].sort((x, y) => x - y));
    expect(q("price-optional")!.contains(q("price-card-set"))).toBe(true); // 任意項目は必須項目の下
    expect(q("price-rank")!.querySelector('[aria-checked="true"]')!.textContent!.trim()).toBe("A");
    expect((q("price-card-rarity") as HTMLInputElement).value).toBe("AR");
    expect((q("price-card-name") as HTMLInputElement).value).toBe("ピカチュウ");
    expect(document.activeElement?.tagName).not.toBe("INPUT"); // 自動フォーカスしない
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
    expect(img.getAttribute("src")).toBe("/api/pokemon-image/6?v=2"); // リザードンex → No.6
    expect(img.getAttribute("data-dim")).toBe("false");
    expect(img.className).not.toContain("opacity-35");
    expect(rows[1].querySelector('[data-testid="dex-image"]')).toBeNull();
  });

  /** 価格フォームの必須項目を埋める（系列→店舗→価格。状態は初期値 A のまま） */
  const fillPrice = async (chain: string, store: string, yenText: string) => {
    await type(q("price-chain") as HTMLInputElement, chain);
    await type(q("price-store") as HTMLInputElement, store);
    await type(q("price-yen") as HTMLInputElement, yenText);
  };

  it("状態違いの価格を同じ系列・店舗・調査日でまとめて登録できる。同じ状態の重複・入力不足は保存前に止める", async () => {
    mdata = { cards: [mcard()], prices: [], purchases: [] };
    await mount(createElement(MarketMemoView));
    await click(q("market-card-plus"));
    await fillPrice("系列B", "B店", "1200"); // 状態は A が初期選択
    await click(q("price-extra-add"));
    const row = q("price-extra-row")!;
    await type(row.querySelector("select") as HTMLSelectElement, "B");
    await type(row.querySelector("input") as HTMLInputElement, "900");
    await click(q("price-submit"));
    expect(addMPrice).toHaveBeenCalledTimes(2);
    expect(addMPrice.mock.calls.map((c) => c[2] as { condition: string; priceYen: number; storeName: string; chainName: string })).toMatchObject([
      { condition: "A", priceYen: 1200, storeName: "B店", chainName: "系列B" },
      { condition: "B", priceYen: 900, storeName: "B店", chainName: "系列B" },
    ]);
    // 重複する状態
    addMPrice.mockClear();
    await click(q("market-card-plus"));
    await fillPrice("系列B", "B店", "1200");
    await click(q("price-extra-add"));
    await type(q("price-extra-row")!.querySelector("select") as HTMLSelectElement, "A");
    await type(q("price-extra-row")!.querySelector("input") as HTMLInputElement, "1000");
    await click(q("price-submit"));
    expect(addMPrice).not.toHaveBeenCalled();
    expect(q("price-error")!.textContent).toContain("重複");
  });

  it("系列・店舗はどちらも必須（未入力は保存前にエラー）。どちらかが空ならカードも作らない", async () => {
    mdata = { cards: [mcard()], prices: [], purchases: [] };
    await mount(createElement(MarketMemoView));
    await click(q("market-add"));
    await type(q("market-card-name") as HTMLInputElement, "メタモン");
    await type(q("price-store") as HTMLInputElement, "店のみ");
    await type(q("price-yen") as HTMLInputElement, "500");
    await click(q("price-submit"));
    expect(q("price-error")!.textContent).toContain("系列");
    await type(q("price-chain") as HTMLInputElement, "系列のみ");
    await type(q("price-store") as HTMLInputElement, "");
    await click(q("price-submit"));
    expect(q("price-error")!.textContent).toContain("店舗");
    expect(createCard).not.toHaveBeenCalled();
    expect(addMPrice).not.toHaveBeenCalled();
  });

  it("価格登録フォーム（相場調査メモ）の順序: カード名 → 系列 → 店舗 → 調査日 → 販売価格 → 状態ランク → 任意項目（セット・番号・レア・補足・備考）。状態は A が初期選択、レアは AR が初期値、調査日は今日。自動フォーカスしない", async () => {
    mdata = { cards: [mcard()], prices: [], purchases: [] };
    await mount(createElement(MarketMemoView));
    await click(q("market-add"));
    expect(document.activeElement?.tagName).not.toBe("INPUT");
    const form = q("market-add-sheet")!;
    const ids = ["market-card-name", "price-chain", "price-store", "price-date", "price-yen", "price-rank", "market-card-set", "market-card-number", "market-card-rarity", "price-note"];
    const pos = ids.map((id) => [...form.querySelectorAll("*")].indexOf(form.querySelector(`[data-testid="${id}"]`)!));
    expect(pos.every((p) => p >= 0)).toBe(true);
    expect(pos).toEqual([...pos].sort((x, y) => x - y));
    expect(q("price-optional")!.contains(q("market-card-set"))).toBe(true); // 任意項目は必須項目の下
    expect((q("price-date") as HTMLInputElement).value).toBe("2026-11-17");
    expect([...q("price-rank")!.querySelectorAll("button")].map((b) => b.textContent!.trim())).toEqual(["A+", "A", "B+", "B", "C"]);
    expect(q("price-rank")!.querySelector('[aria-checked="true"]')!.textContent!.trim()).toBe("A");
    expect((q("market-card-rarity") as HTMLInputElement).value).toBe("AR");
  });

  it("過去の「系列＋店舗」はワンタップで両方に入る候補ボタン。収録セットとカード番号は相互補完（番号→セット。セットが複数あれば補完しない）", async () => {
    mdata = {
      cards: [mcard(), mcard({ id: "m2", name: "別カード", setName: "別セット", cardNumber: "006/078" }), mcard({ id: "m3", name: "三枚目", setName: "セットX", cardNumber: "099/100" })],
      prices: [mprice({ chainName: "系列甲", storeName: "過去の店" }), mprice({ id: "mp2", chainName: "", storeName: "系列なしの店" })],
      purchases: [],
    };
    await mount(createElement(MarketMemoView));
    await click(q("market-add"));
    expect(qa("pair-chip").map((c) => c.textContent)).toEqual(["系列甲 過去の店"]); // 系列が空の過去記録は候補にしない
    await click(qa("pair-chip")[0]);
    expect((q("price-chain") as HTMLInputElement).value).toBe("系列甲");
    expect((q("price-store") as HTMLInputElement).value).toBe("過去の店");
    // 相互補完: 099/100 はセットXだけ → セットに入る。006/078 は2つのセットにあるので補完しない
    await type(q("market-card-number") as HTMLInputElement, "099/100");
    expect((q("market-card-set") as HTMLInputElement).value).toBe("セットX");
    await type(q("market-card-set") as HTMLInputElement, "");
    await type(q("market-card-number") as HTMLInputElement, "006/078");
    expect((q("market-card-set") as HTMLInputElement).value).toBe("");
    // セットを選ぶとそのセットの番号が候補に出る
    await type(q("market-card-set") as HTMLInputElement, "セットX");
    expect([...document.querySelectorAll("#market-number-options option")].map((o) => (o as HTMLOptionElement).value)).toEqual(["099/100"]);
  });

  it("カードと価格の登録: カード→価格の順に保存。過去の系列＋店舗をタップで再入力でき、状態は A が初期値", async () => {
    mdata = { cards: [mcard()], prices: [mprice({ chainName: "系列甲", storeName: "過去の店" })], purchases: [] };
    await mount(createElement(MarketMemoView));
    await click(q("market-add"));
    await type(q("market-card-name") as HTMLInputElement, "メタモン");
    await click(qa("pair-chip")[0]);
    await type(q("price-yen") as HTMLInputElement, "1,200");
    await click(q("price-submit"));
    expect(createCard).toHaveBeenCalledTimes(1);
    expect(createCard.mock.calls[0][1]).toMatchObject({ name: "メタモン", rarity: "AR" });
    expect(createCard.mock.calls[0][2]).toBe(false);
    expect(addMPrice).toHaveBeenCalledTimes(1);
    expect(addMPrice.mock.calls[0][1]).toBe("m1");
    expect(addMPrice.mock.calls[0][2]).toMatchObject({ chainName: "系列甲", storeName: "過去の店", condition: "A", priceYen: 1200, surveyedOn: "2026-11-17" });
    expect(q("market-add-sheet")).toBeNull(); // 保存後は元の一覧に戻る
  });

  it("同じカードか曖昧なとき: 既存のカードに追加するか、別のカードとして登録するかを選ばせる（勝手に統合も新規作成もしない）", async () => {
    mdata = { cards: [mcard()], prices: [], purchases: [] };
    createCard.mockImplementationOnce(async () => ({ ok: false, error: "同じカードか判断できません", ambiguous: [mcard()] }));
    await mount(createElement(MarketMemoView));
    await click(q("market-add"));
    await type(q("market-card-name") as HTMLInputElement, "リザードンex");
    await fillPrice("系列X", "X店", "500");
    await click(q("price-submit"));
    expect(addMPrice).not.toHaveBeenCalled();
    expect(q("market-ambiguous")).not.toBeNull();
    await click(q("market-use-existing"));
    expect(addMPrice).toHaveBeenCalledWith(PID, "m1", expect.objectContaining({ storeName: "X店", chainName: "系列X", priceYen: 500 }));
  });

  it("一覧の「＋」から価格だけを素早く追加（カード名は出さない）。左スワイプでも同じ操作ができる", async () => {
    mdata = { cards: [mcard()], prices: [], purchases: [] };
    await mount(createElement(MarketMemoView));
    await click(q("market-card-plus"));
    expect(q("market-quick-sheet")).not.toBeNull();
    expect(q("market-card-name")).toBeNull();
    await fillPrice("系列Y", "Y店", "700");
    await click(q("price-rank")!.querySelectorAll("button")[2]);
    await click(q("price-submit"));
    expect(addMPrice).toHaveBeenCalledWith(PID, "m1", expect.objectContaining({ storeName: "Y店", chainName: "系列Y", condition: "B+", priceYen: 700 }));
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

  it("カード詳細（相場調査メモ）: 価格一覧は要点だけ（状態→系列・店舗→調査日→金額）。操作・推移・備考は価格をタップした詳細に。状態優先／価格順、30日超は参考価格、同じ店舗の推移、購入は確認のあと1回だけ・購入済みは押せない", async () => {
    mdata = {
      cards: [mcard()],
      prices: [mprice({ id: "a", storeName: "A店", chainName: "系列A", condition: "B", priceYen: 600 }), mprice({ id: "b", storeName: "A店", chainName: "系列A", condition: "A", priceYen: 900, surveyedOn: "2026-08-01", note: "古いメモ" }), mprice({ id: "c", storeName: "C店", chainName: "系列C", condition: "A+", priceYen: 1500 })],
      purchases: [{ id: "x", cardId: "m1", priceId: "c", purchasedOn: "2026-11-11", storeName: "C店", priceYen: 1500, condition: "A+" }],
    };
    await mount(createElement(MarketMemoView));
    await click(q("market-show-bought"));
    await click(q("market-card-open"));
    const order = () => qa("price-row").map((r) => r.querySelector('[data-testid="price-rank-label"]')!.textContent);
    expect(order()).toEqual(["A+", "A", "B"]);
    expect(qa("price-buy")).toHaveLength(0); // 一覧に購入・編集・削除・推移は無い
    expect(qa("price-edit")).toHaveLength(0);
    expect(q("price-history")).toBeNull();
    expect(q("price-list")!.textContent).not.toMatch(/この価格で購入|この店の推移|古いメモ/);
    await click(q("price-sort")!.querySelectorAll("button")[1]);
    expect(order()).toEqual(["B", "A", "A+"]);
    const old = qa("price-row").find((r) => r.textContent!.includes("900円"))!;
    expect(old.getAttribute("data-ref")).toBe("true");
    await click(old); // 詳細: 備考・参考価格・同じ店舗の推移
    expect(q("price-detail")!.textContent).toContain("古いメモ");
    expect(q("price-detail-badges")!.textContent).toContain("参考価格");
    expect(q("price-history")!.querySelectorAll("li")).toHaveLength(2); // A店の過去の調査も残っている
    await act(async () => void document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
    await flush();
    await click(qa("price-row").find((r) => r.getAttribute("data-bought") === "true")!);
    expect((q("price-buy") as HTMLButtonElement).disabled).toBe(true); // 購入済みは押せない
    await act(async () => void document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
    await flush();
    await click(qa("price-row").find((r) => r.getAttribute("data-bought") === "false" && r.textContent!.includes("600円"))!);
    await click(q("price-buy"));
    expect(buyM).not.toHaveBeenCalled();
    await click(q("buy-ok"));
    expect(buyM).toHaveBeenCalledTimes(1);
  });
});
