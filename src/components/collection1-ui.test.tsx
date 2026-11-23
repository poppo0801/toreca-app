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
import type { MarketSort } from "@/lib/zukan/zukan";

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
const loadHistory = vi.fn(async () => ({
  ok: true as const,
  records: [...zdata.prices, ...mdata.prices].map((r) => ({ chainName: r.chainName, storeName: r.storeName, surveyedOn: r.surveyedOn, createdAt: r.createdAt })).sort((a, b) => b.createdAt.localeCompare(a.createdAt)),
}));
vi.mock("@/app/(app)/market-memo/daily-actions", () => ({
  loadStoreHistoryAction: () => loadHistory(),
  loadDailyAction: vi.fn(async () => ({ ok: false, error: "unused" })),
  setPlanMarkAction: vi.fn(async () => ({ ok: true })),
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
    zdata = { cards: [], prices: [zp({ id: "a", condition: "C", priceYen: 300, chainName: "系列A", storeName: "甲店", note: "秘密のメモ" }), zp({ id: "b", condition: "S", priceYen: 900 }), zp({ id: "c", storeName: "乙店", condition: "A", priceYen: 500, surveyedOn: "2026-09-01" }), zp({ id: "d", condition: "A", priceYen: 450 })] };
    await mount(createElement(ZukanView));
    await click(q("zukan-list")!.querySelector('[data-no="25"]'));
    const order = () => qa("price-row").map((r) => r.querySelector('[data-testid="price-rank-label"]')!.textContent + ":" + r.querySelector('[data-testid="price-amount"]')!.textContent!.replace(/[^\d]/g, ""));
    expect(order()).toEqual(["S:900", "A:450", "A:500", "C:300"]);
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
    expect(order()).toEqual(["C:300", "A:450", "A:500", "S:900"]);
    const rows = qa("price-row");
    expect(rows.find((r) => r.textContent!.includes("500円"))!.getAttribute("data-ref")).toBe("true");
    expect(rows.filter((r) => r.getAttribute("data-best") === "true").map((r) => r.querySelector('[data-testid="price-amount"]')!.textContent!.replace(/[^\d]/g, ""))).toEqual(["300"]);
  });

  it("価格ブロックをタップすると詳細が開き、備考・最安/参考価格/購入済みの表示・購入/編集/削除がそこに集約される", async () => {
    zdata = { cards: [], prices: [zp({ id: "a", condition: "C", priceYen: 300, note: "秘密のメモ" }), zp({ id: "c", storeName: "乙店", condition: "A", priceYen: 500, surveyedOn: "2026-09-01" })] };
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
    zdata = { cards: [zc({ id: "k", priceRecordId: "bought" })], prices: [zp({ id: "r1" }), zp({ id: "bought", storeName: "丙店", priceYen: 700 })] };
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

  /** 左スワイプ（タッチ）。一覧の価格追加の操作 */
  const swipeLeft = async (el: Element) => {
    const touch = (type: string, x: number, y: number) => {
      const e = new Event(type, { bubbles: true }) as Event & { touches: unknown[]; changedTouches: unknown[] };
      e.touches = type === "touchend" ? [] : [{ clientX: x, clientY: y }];
      e.changedTouches = [{ clientX: x, clientY: y }];
      return e;
    };
    await act(async () => void el.dispatchEvent(touch("touchstart", 300, 100)));
    await act(async () => void el.dispatchEvent(touch("touchend", 180, 105)));
    await flush();
  };

  it("カード一覧: 各行に「＋」は無く、行全体のタップで詳細が開く。購入済みのカードは既定で非表示（ボタンで切替）。検索できる。並び替えボタンがある", async () => {
    mdata = { cards: [mcard(), mcard({ id: "m2", name: "ピカチュウ", setName: "151", cardNumber: "025/165" }), mcard({ id: "m3", name: "買った札", setName: "x", cardNumber: "1" })], prices: [mprice(), mprice({ id: "mp2", cardId: "m1", storeName: "B店", priceYen: 800 }), mprice({ id: "mp3", cardId: "m3" })], purchases: [{ id: "b1", cardId: "m3", priceId: "mp3", purchasedOn: "2026-11-11", storeName: "A店", priceYen: 1000, condition: "A" }] };
    await mount(createElement(MarketMemoView));
    expect(qa("market-card")).toHaveLength(2);
    expect(qa("market-card")[0].querySelector('[data-testid="market-card-best"]')!.textContent).toBe("800円"); // 最安価格は右端
    expect(qa("market-card")[0].querySelector('[data-testid="market-card-summary"]')!.textContent).toContain("B店");
    expect(qa("market-card-plus")).toHaveLength(0); // 行の「＋」は削除
    expect(q("market-add")).not.toBeNull(); // 右上の＋（新規カード登録）は維持
    expect(q("market-sort")).not.toBeNull();
    expect(q("market-show-bought")!.getAttribute("aria-pressed")).toBe("false");
    await click(qa("market-card-open")[0]); // 行全体のタップで詳細
    expect(q("market-sheet")).not.toBeNull();
    await act(async () => void document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
    await flush();
    await click(q("market-show-bought"));
    expect(q("market-show-bought")!.getAttribute("aria-pressed")).toBe("true");
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

  it("相場調査メモの一覧: 全ポケモン（151以外を含む）の画像を、カード名から特定できたときだけ出す（常に不透明）。トレーナーズ等・特定できない名前は画像なし", async () => {
    mdata = {
      cards: [mcard({ id: "a", name: "ミロカロス", setName: "S1", cardNumber: "1" }), mcard({ id: "b", name: "ブルンゲルex", setName: "S1", cardNumber: "2" }), mcard({ id: "c", name: "ハイパーボール", setName: "S1", cardNumber: "3" }), mcard({ id: "d", name: "ピカチュウ&ゼクロムGX", setName: "S1", cardNumber: "4" })],
      prices: [],
      purchases: [],
    };
    await mount(createElement(MarketMemoView));
    const byName = (n: string) => qa("market-card").find((r) => r.textContent!.includes(n))!;
    expect(byName("ミロカロス").querySelector('[data-testid="dex-image"]')!.getAttribute("src")).toBe("/api/pokemon-image/350?v=2"); // 151以外
    expect(byName("ブルンゲルex").querySelector('[data-testid="dex-image"]')!.getAttribute("src")).toBe("/api/pokemon-image/593?v=2");
    expect(byName("ブルンゲルex").querySelector('[data-testid="dex-image"]')!.getAttribute("data-dim")).toBe("false");
    expect(byName("ハイパーボール").querySelector('[data-testid="dex-image"]')).toBeNull();
    expect(byName("ピカチュウ&ゼクロムGX").querySelector('[data-testid="dex-image"]')).toBeNull(); // 複数のポケモン=曖昧
  });

  it("相場調査メモのヘッダー: JSONダウンロードのボタンは無く、検索と右上の＋だけ", async () => {
    mdata = { cards: [mcard()], prices: [], purchases: [] };
    await mount(createElement(MarketMemoView));
    expect(q("market-export")).toBeNull();
    expect(document.body.querySelector('[aria-label*="エクスポート"]')).toBeNull();
    expect(q("market-search")).not.toBeNull();
    expect(q("market-add")).not.toBeNull();
  });

  it("相場調査メモの一覧: コンパクトな3区画（左=画像・カード名・セット枠・系列 店舗／中央=レアリティ／右=状態バッジ・価格）。長い店名は省略表示を許容し、価格は小さめ・右端・折り返さない", async () => {
    const longStore = "トレカキャピタル東京都新宿区西新宿本店（ポケモンカード専門館）";
    mdata = { cards: [mcard({ rarity: "SAR" })], prices: [mprice({ storeName: longStore, chainName: "トレカキャピタル", condition: "S", priceYen: 1500 })], purchases: [] };
    await mount(createElement(MarketMemoView));
    const store = q("market-card-store")!;
    expect(store.textContent).toBe(longStore); // 店名に系列名が含まれるときは、系列名を重ねて出さない。文字列は完全に出力される（見た目の省略はCSS）
    expect(store.className).toContain("line-clamp-2"); // 長い店名は折り返して全文を出す（最大2行）
    const btn = q("market-card-open")!;
    expect(btn.className).toContain("grid");
    expect(btn.className).toContain("items-center");
    const best = q("market-card-best")!;
    expect(best.textContent).toBe("1,500円");
    expect(best.className).toMatch(/whitespace-nowrap/); // 桁数で折り返さない
    expect(best.className).toContain("text-[15px]"); // 従来（text-lg）より小さい
    expect(best.className).not.toContain("text-lg");
    // 区画の順序: 左（画像・名前・店舗）→ 中央（レアリティ）→ 右（状態バッジ・価格）
    const [left, center, rankCol, priceCol] = [...btn.children] as HTMLElement[];
    expect(left.contains(q("market-card-name-text")!)).toBe(true);
    expect(left.contains(store)).toBe(true);
    expect(center.getAttribute("data-testid")).toBe("row-rarity");
    expect(center.textContent).toBe("SAR");
    expect(center.className).toContain("border-x"); // 独立した列（左右の細い線）
    // 列は全行で固定幅: レアリティ・状態ランク・価格の位置は店舗名の長さに影響されない
    expect(btn.className).toContain("grid-cols-[minmax(0,1fr)_2.25rem_1.75rem_4.25rem]");
    expect(rankCol.querySelector('[data-testid="rank-badge"]')!.getAttribute("data-rank")).toBe("S");
    expect(priceCol).toBe(best);
    expect(left.contains(rankCol.querySelector('[data-testid="rank-badge"]'))).toBe(false); // 状態は右側
  });

  it("相場調査メモの一覧: 店名に系列名が含まれないときは「系列 店舗」の順で出す", async () => {
    mdata = { cards: [mcard()], prices: [mprice({ storeName: "渋谷店", chainName: "別系列" })], purchases: [] };
    await mount(createElement(MarketMemoView));
    expect(q("market-card-store")!.textContent).toBe("別系列 渋谷店");
  });

  it("状態違いの価格を同じ系列・店舗・調査日でまとめて登録できる。同じ状態の重複・入力不足は保存前に止める", async () => {
    mdata = { cards: [mcard()], prices: [], purchases: [] };
    await mount(createElement(MarketMemoView));
    await swipeLeft(q("market-card")!);
    await fillPrice("系列B", "B店", "1200"); // 状態は A が初期選択
    await click(q("price-extra-add"));
    const row = q("price-extra-row")!;
    expect(row.querySelector("select")).toBeNull(); // 2件目以降も、最初の登録と同じボタン選択式
    expect([...row.querySelectorAll('[data-testid="price-extra-rank-btn"]')].map((b) => b.textContent)).toEqual(["S", "A", "B", "C", "D"]);
    await click([...row.querySelectorAll('[data-testid="price-extra-rank-btn"]')][3]); // B
    await type(row.querySelector('[data-testid="price-extra-yen"]') as HTMLInputElement, "900");
    await click(q("price-submit"));
    expect(addMPrice).toHaveBeenCalledTimes(2);
    expect(addMPrice.mock.calls.map((c) => c[2] as { condition: string; priceYen: number; storeName: string; chainName: string })).toMatchObject([
      { condition: "A", priceYen: 1200, storeName: "B店", chainName: "系列B" },
      { condition: "C", priceYen: 900, storeName: "B店", chainName: "系列B" },
    ]);
    // 重複する状態
    addMPrice.mockClear();
    await swipeLeft(q("market-card")!);
    await fillPrice("系列B", "B店", "1200");
    await click(q("price-extra-add"));
    await click(q("price-extra-row")!.querySelectorAll('[data-testid="price-extra-rank-btn"]')[1]); // A（1件目と同じ状態）
    await type(q("price-extra-row")!.querySelector('[data-testid="price-extra-yen"]') as HTMLInputElement, "1000");
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
    expect([...q("price-rank")!.querySelectorAll("button")].map((b) => b.textContent!.trim())).toEqual(["S", "A", "B", "C", "D"]);
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
    // 番号: 入力欄をタップすると候補一覧（番号・収録セット・レア）。先頭1文字から絞り込む。選ぶとセットとレアを補完する。一覧に無い番号は自由入力
    const num = q("market-card-number") as HTMLInputElement;
    await click(num);
    const opts = () => qa("market-card-number-option").map((o) => o.textContent);
    expect(opts()).toHaveLength(2); // 番号単独の候補: 006/078（2つのセットがあっても1つ）・099/100
    await type(num, "0");
    expect(opts()).toHaveLength(2);
    await type(num, "09");
    expect(opts()).toEqual(["099/100セットX"]);
    const rarityBefore = (q("market-card-rarity") as HTMLInputElement).value;
    const pick = async (el: Element) => {
      await act(async () => void el.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true })));
      await flush();
    };
    await pick(qa("market-card-number-option")[0]);
    expect(num.value).toBe("099/100");
    expect((q("market-card-set") as HTMLInputElement).value).toBe("セットX"); // 番号を選ぶと、対応する収録セットを自動補完
    expect((q("market-card-rarity") as HTMLInputElement).value).toBe(rarityBefore); // 番号とレアリティの候補は独立（番号を選んでもレアは変わらない）
    // 同じ番号が複数のセットにあるとき: 自動入力せず、収録セットを選ばせる（番号だけでセットを推測しない）
    await type(q("market-card-set") as HTMLInputElement, "");
    await type(num, "006/078");
    expect((q("market-card-set") as HTMLInputElement).value).toBe("");
    expect(opts()).toHaveLength(1);
    expect(qa("set-choice")).toHaveLength(2);
    await click(qa("set-choice")[1]);
    expect((q("market-card-set") as HTMLInputElement).value).not.toBe(""); // 選んだ収録セット
    // 一覧に無い番号・レアリティは自由入力できる
    await type(num, "999/999");
    expect(num.value).toBe("999/999");
    expect(opts()).toHaveLength(0);
    const rar = q("market-card-rarity") as HTMLInputElement;
    await click(rar);
    expect(qa("market-card-rarity-option").length).toBeGreaterThan(0);
    await type(rar, "S");
    expect(qa("market-card-rarity-option").map((o) => o.textContent!.trim()).every((t) => t.toUpperCase().startsWith("S"))).toBe(true); // 先頭の1文字で絞り込み
    await type(rar, "特別レア");
    expect(rar.value).toBe("特別レア");
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

  it("左スワイプで価格だけを素早く追加（カード名は出さない）。詳細の「価格を記録」からも追加できる", async () => {
    mdata = { cards: [mcard()], prices: [], purchases: [] };
    await mount(createElement(MarketMemoView));
    await swipeLeft(q("market-card")!);
    expect(q("market-quick-sheet")).not.toBeNull();
    expect(q("market-card-name")).toBeNull();
    await fillPrice("系列Y", "Y店", "700");
    await click(q("price-rank")!.querySelectorAll("button")[2]);
    await click(q("price-submit"));
    expect(addMPrice).toHaveBeenCalledWith(PID, "m1", expect.objectContaining({ storeName: "Y店", chainName: "系列Y", condition: "B", priceYen: 700 }));
    expect(q("market-quick-sheet")).toBeNull();
    // 詳細から
    addMPrice.mockClear();
    await click(q("market-card-open"));
    await click(q("market-price-add"));
    await fillPrice("系列Z", "Z店", "650");
    await click(q("price-submit"));
    expect(addMPrice).toHaveBeenCalledWith(PID, "m1", expect.objectContaining({ storeName: "Z店", priceYen: 650 }));
  });

  it("カード一覧の並び替え: アイコンのみのボタンで 新着順 → 図鑑番号順 → 価格降順 → 価格昇順 → 状態順 → レアリティ順 → 五十音順 → 新着順。価格の記録が無いカードは価格・状態の並びで最後。購入済みの表示切替は常に使える", async () => {
    mdata = {
      cards: [mcard({ id: "n1", name: "新しい", setName: "s", cardNumber: "1", rarity: "R", createdAt: "2026-11-15T00:00:00Z" }), mcard({ id: "n2", name: "安い", setName: "s", cardNumber: "2", rarity: "SAR", createdAt: "2026-11-10T00:00:00Z" }), mcard({ id: "n3", name: "状態良", setName: "s", cardNumber: "3", rarity: "UR", createdAt: "2026-11-05T00:00:00Z" }), mcard({ id: "n4", name: "記録なし", setName: "s", cardNumber: "4", rarity: "", createdAt: "2026-11-16T00:00:00Z" })],
      prices: [mprice({ id: "p1", cardId: "n1", condition: "C", priceYen: 900 }), mprice({ id: "p2", cardId: "n2", condition: "C", priceYen: 300 }), mprice({ id: "p3", cardId: "n3", condition: "S", priceYen: 1500 })],
      purchases: [],
    };
    await mount(createElement(MarketMemoView));
    const names = () => qa("market-card-name-text").map((e) => e.textContent);
    const sort = () => q("market-sort")!.getAttribute("data-sort");
    expect(q("market-sort")!.textContent).toBe(""); // ボタン内に文字は無い（アイコンのみ）
    expect(q("market-sort")!.querySelector("svg")).not.toBeNull();
    expect(sort()).toBe("new");
    expect(names()).toEqual(["記録なし", "新しい", "安い", "状態良"]); // 新着順（登録の新しい順）
    await click(q("market-sort"));
    expect(sort()).toBe("dex");
    expect(names()).toEqual(["記録なし", "新しい", "安い", "状態良"]); // 図鑑番号順（ポケモンでないカードは末尾＝新着順）
    await click(q("market-sort"));
    expect(sort()).toBe("priceDesc");
    expect(names()).toEqual(["状態良", "新しい", "安い", "記録なし"]); // 最安価格の高い順・記録なしは最後
    await click(q("market-sort"));
    expect(sort()).toBe("priceAsc");
    expect(names()).toEqual(["安い", "新しい", "状態良", "記録なし"]); // 最安価格の安い順・記録なしは最後
    await click(q("market-sort"));
    expect(sort()).toBe("condition");
    expect(names()).toEqual(["状態良", "安い", "新しい", "記録なし"]); // 最安記録の状態が良い順（A+→B）。同ランクは安値順
    expect(q("market-show-bought")).not.toBeNull(); // 購入済みが無くても切替ボタンは常にある
    await click(q("market-sort"));
    expect(sort()).toBe("rarity");
    expect(names()).toEqual(["状態良", "安い", "新しい", "記録なし"]); // UR > SAR > R > なし
    await click(q("market-sort"));
    expect(sort()).toBe("kana");
    await click(q("market-sort"));
    expect(sort()).toBe("new"); // 一巡（図鑑No順は長押しの一覧から選べる）
  });

  it("並び替えの長押し: 全ての項目を一覧し、直接選べる。選ぶと閉じ、通常タップの循環は選んだ並びから続く。長押しの直後のclickは次の並びへ切り替えない", async () => {
    mdata = { cards: [mcard()], prices: [mprice()], purchases: [] };
    await mount(createElement(MarketMemoView));
    const btn = q("market-sort")!;
    await act(async () => {
      btn.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true, clientX: 5, clientY: 5 }));
      await new Promise((r) => setTimeout(r, 520));
    });
    expect(q("market-sort-menu")).not.toBeNull();
    expect(qa("market-sort-option").map((o) => o.getAttribute("data-sort"))).toEqual(["new", "dex", "priceDesc", "priceAsc", "condition", "rarity", "kana"]);
    await act(async () => void btn.click()); // 長押し直後の click
    expect(btn.getAttribute("data-sort")).toBe("new"); // 切り替わらない
    await act(async () => void (qa("market-sort-option").find((o) => o.getAttribute("data-sort") === "rarity")!).click());
    expect(q("market-sort-menu")).toBeNull();
    expect(btn.getAttribute("data-sort")).toBe("rarity");
    await act(async () => void btn.click());
    expect(btn.getAttribute("data-sort")).toBe("kana"); // 循環は選んだ並びから続く
    // 通常タップ（短い押下）では一覧は開かない
    await act(async () => {
      btn.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true, clientX: 5, clientY: 5 }));
      await new Promise((r) => setTimeout(r, 100));
      btn.dispatchEvent(new MouseEvent("pointerup", { bubbles: true }));
      await new Promise((r) => setTimeout(r, 520)); // 離したので、時間が経っても一覧は開かない
    });
    expect(q("market-sort-menu")).toBeNull();
  });

  it("カード一覧の表示: 左=画像・カード名・セット（小さな枠）・系列 店舗／中央=レアリティ（独立列）／右=状態バッジ・価格。カード番号と区切りの「・」・件数は一覧に出さない。図鑑No（画像）は別の情報", async () => {
    mdata = { cards: [mcard({ name: "ピカチュウex", setName: "ステラミラクル", cardNumber: "132/165", rarity: "SAR" })], prices: [mprice({ storeName: "渋谷店", chainName: "", condition: "S", priceYen: 1500 }), mprice({ id: "mp2", storeName: "新宿店", condition: "C", priceYen: 2000 })], purchases: [] };
    await mount(createElement(MarketMemoView));
    const row = q("market-card")!;
    const set = row.querySelector('[data-testid="row-set"]') as HTMLElement;
    expect(set.textContent).toBe("ステラミラクル");
    expect(set.className).toMatch(/rounded-md/);
    expect(set.className.split(" ")).toContain("border"); // 線で囲んだ小さな枠
    const rarity = row.querySelector('[data-testid="row-rarity"]') as HTMLElement;
    expect(rarity.textContent).toBe("SAR");
    expect(rarity.className).toContain("font-extrabold");
    expect(row.querySelector('[data-testid="row-number"]')).toBeNull(); // カード番号は詳細に
    expect(row.textContent).not.toContain("・");
    expect(row.textContent).not.toContain("件");
    // 図鑑番号（ピカチュウ=25）とカード番号（132/165）は別の情報
    expect(q("market-card-summary")!.getAttribute("data-dex")).toBe("25");
    expect(q("market-card-summary")!.textContent).not.toContain("025");
    expect(row.querySelector('[data-testid="dex-image"]')!.getAttribute("src")).toBe("/api/pokemon-image/25?v=2");
    // 順序: 名前 → セット（同じ行）、店舗（次の行）、レアリティ（中央）、状態バッジ・最安価格（右端）
    const els = [...row.querySelectorAll("*")];
    const at = (el: Element) => els.indexOf(el);
    expect(at(q("market-card-name-text")!)).toBeLessThan(at(set));
    expect(at(set)).toBeLessThan(at(q("market-card-store")!));
    expect(at(q("market-card-store")!)).toBeLessThan(at(rarity));
    expect(at(rarity)).toBeLessThan(at(row.querySelector('[data-testid="rank-badge"]')!));
    expect(row.querySelector('[data-testid="rank-badge"]')!.textContent).toBe("S");
    expect(q("market-card-store")!.textContent).toBe("渋谷店");
    expect(q("market-card-best")!.textContent).toBe("1,500円");
    expect(q("market-card-open")!.lastElementChild).toBe(q("market-card-best"));
  });

  it("カード一覧の五十音順・図鑑No順（実際の表示順）。見出し用の並び順の表示も更新される", async () => {
    mdata = { cards: [mcard({ id: "a", name: "リザードンex", cardNumber: "006/078" }), mcard({ id: "b", name: "ピカチュウV", cardNumber: "001/100" }), mcard({ id: "c", name: "ハイパーボール", cardNumber: "100/100" }), mcard({ id: "d", name: "フシギダネ", cardNumber: "999/999" }), mcard({ id: "e", name: "ミュウex", cardNumber: "151/151" })], prices: [], purchases: [] };
    const seen: string[] = [];
    await mount(createElement(MarketMemoView as unknown as React.ComponentType<{ onSortChange?: (m: MarketSort) => void }>, { onSortChange: (m: MarketSort) => void seen.push(m) }));
    const names = () => qa("market-card-name-text").map((e) => e.textContent);
    await click(q("market-sort")); // dex
    expect(names()).toEqual(["フシギダネ", "リザードンex", "ピカチュウV", "ミュウex", "ハイパーボール"]); // 全国図鑑No 1,6,25,151。カードの収録番号(999/999 等)は無関係
    for (let i = 0; i < 5; i++) await click(q("market-sort")); // priceDesc, priceAsc, condition, rarity, kana
    expect(names()).toEqual(["ピカチュウV", "フシギダネ", "ミュウex", "リザードンex", "ハイパーボール"]); // 読み仮名順。ex の有無に影響されない・番号なしは末尾
    expect(seen).toEqual(["dex", "priceDesc", "priceAsc", "condition", "rarity", "kana"]); // 見出しの表示が即時更新されるための通知
  });

  it("状態ランクは四角い色分けバッジ（S/A/B/C/D で色が異なる）。カード一覧は最安記録の状態を表示", async () => {
    mdata = { cards: [mcard()], prices: [mprice({ condition: "B", priceYen: 700 })], purchases: [] };
    await mount(createElement(MarketMemoView));
    const b = q("market-card-open")!.querySelector('[data-testid="rank-badge"]') as HTMLElement;
    expect(b.textContent).toBe("B");
    const { RankBadge } = await import("@/components/rank-badge");
    const classes = ["S", "A", "B", "C", "D"].map((r) => {
      const d = document.createElement("div");
      document.body.appendChild(d);
      const root2 = createRoot(d);
      act(() => root2.render(createElement(RankBadge, { rank: r })));
      const c = d.firstElementChild!.className;
      act(() => root2.unmount());
      d.remove();
      return c;
    });
    expect(new Set(classes).size).toBe(5); // ランクごとに色が違う
    expect(classes.every((c) => /rounded-\[3px\] border/.test(c))).toBe(true); // 四角い枠
  });

  it("カード詳細（相場調査メモ）: 価格一覧は要点だけ（状態→系列・店舗→調査日→金額）。操作・推移・備考は価格をタップした詳細に。状態優先／価格順、30日超は参考価格、同じ店舗の推移、購入は確認のあと1回だけ・購入済みは押せない", async () => {
    mdata = {
      cards: [mcard()],
      prices: [mprice({ id: "a", storeName: "A店", chainName: "系列A", condition: "C", priceYen: 600 }), mprice({ id: "b", storeName: "A店", chainName: "系列A", condition: "A", priceYen: 900, surveyedOn: "2026-08-01", note: "古いメモ" }), mprice({ id: "c", storeName: "C店", chainName: "系列C", condition: "S", priceYen: 1500 })],
      purchases: [{ id: "x", cardId: "m1", priceId: "c", purchasedOn: "2026-11-11", storeName: "C店", priceYen: 1500, condition: "S" }],
    };
    await mount(createElement(MarketMemoView));
    await click(q("market-show-bought"));
    await click(q("market-card-open"));
    const order = () => qa("price-row").map((r) => r.querySelector('[data-testid="price-rank-label"]')!.textContent);
    expect(order()).toEqual(["S", "A", "C"]);
    expect(qa("price-buy")).toHaveLength(0); // 一覧に購入・編集・削除・推移は無い
    expect(qa("price-edit")).toHaveLength(0);
    expect(q("price-history")).toBeNull();
    expect(q("price-list")!.textContent).not.toMatch(/この価格で購入|この店の推移|古いメモ/);
    await click(q("price-sort")!.querySelectorAll("button")[1]);
    expect(order()).toEqual(["C", "A", "S"]);
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
