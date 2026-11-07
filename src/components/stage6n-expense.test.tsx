import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const saveExpense = vi.fn(async (..._a: unknown[]) => ({ ok: true }) as { ok: boolean; error?: string });
const loadCtx = vi.fn(async (chainId: string | null, storeId: string | null): Promise<unknown> => ({ ok: true, settings: { pricePerL: 155, kmPerL: 16.7 }, oneWayKm: chainId === "c1" && storeId === "s1" ? 34 : null }));
const saveTrip = vi.fn(async (..._a: unknown[]) => ({ ok: true }));
vi.mock("@/app/(app)/finance/fuel-actions", () => ({
  loadFuelContextAction: (chainId: string | null, storeId: string | null) => loadCtx(chainId, storeId),
  saveTripDistanceAction: (...a: unknown[]) => saveTrip(...a),
  saveFuelSettingsAction: async () => ({ ok: true }),
}));
vi.mock("@/components/app-provider", () => ({
  useApp: () => ({
    data: {
      chains: [
        { id: "c1", name: "A系列" },
        { id: "c2", name: "B系列" },
      ],
      stores: [
        { id: "s1", chainId: "c1", name: "三宮店", prefecture: "兵庫県" },
        { id: "s2", chainId: "c1", name: "大阪店", prefecture: "大阪府" },
        { id: "s3", chainId: "c2", name: "B店", prefecture: "京都府" },
      ],
      products: [],
    },
    actions: { saveExpense: (...a: unknown[]) => saveExpense(...a) },
    persistent: true,
  }),
}));

import { ExpenseDialog } from "@/components/expense-dialog";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let host: HTMLDivElement;
beforeEach(() => {
  saveExpense.mockClear();
  saveTrip.mockClear();
  loadCtx.mockClear();
  host = document.createElement("div");
  document.body.appendChild(host);
});
afterEach(() => {
  act(() => root?.unmount());
  root = null;
  host.remove();
  document.body.innerHTML = "";
});
const flush = () => act(async () => { await Promise.resolve(); await Promise.resolve(); });
const mount = async () => {
  root = createRoot(host);
  await act(async () => root!.render(createElement(ExpenseDialog, { open: true, onOpenChange: () => undefined, purchase: null })));
  await flush();
};
const q = (sel: string) => document.body.querySelector(sel) as HTMLElement | null;
const input = (label: string) => q(`[aria-label="${label}"]`) as HTMLInputElement;
const change = (el: HTMLElement, value: string) => {
  const proto = el instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(proto, "value")!.set!.call(el, value);
  act(() => {
    el.dispatchEvent(new Event(el instanceof HTMLSelectElement ? "change" : "input", { bubbles: true }));
  });
};
const click = async (el: HTMLElement) => {
  await act(async () => el.click());
  await flush();
};
const selectCategory = (v: string) => change(q('[data-testid="expense-category"]')!, v);

describe("Stage 6N: 支出登録の系列＋店舗", () => {
  it("購入店舗の1欄ではなく、系列と店舗の2欄になる（全品目）", async () => {
    await mount();
    for (const cat of ["pokemon_card", "goods", "expense"]) {
      selectCategory(cat);
      expect(input("系列")).not.toBeNull();
      expect(input("購入店舗")).not.toBeNull();
    }
  });
  it("系列を選ぶと、店舗の候補はその系列の店舗に絞られる", async () => {
    await mount();
    change(input("系列"), "A系列");
    await act(async () => input("購入店舗").focus());
    change(input("購入店舗"), "店");
    const storeOpts = [...document.body.querySelectorAll('[role="option"]')].map((o) => o.textContent ?? "");
    expect(storeOpts.some((t) => t.includes("三宮店"))).toBe(true);
    expect(storeOpts.some((t) => t.includes("B店"))).toBe(false);
  });
  it("店舗がない系列は、系列のみで保存できる（店舗名は任意）", async () => {
    await mount();
    selectCategory("goods");
    change(input("系列"), "店舗なしの新系列");
    change(q('[data-testid="expense-item-name"]')!, "スリーブ");
    change(input("購入金額1"), "500");
    await click([...document.body.querySelectorAll("button")].find((b) => b.textContent === "保存")!);
    expect(saveExpense).toHaveBeenCalledTimes(1);
    const sent = saveExpense.mock.calls[0][1] as { chain: { name: string }; store: { id: string | null; name: string } };
    expect(sent.chain.name).toBe("店舗なしの新系列");
    expect(sent.store).toEqual({ id: null, name: "" });
  });
});

describe("Stage 6N: ガソリン代の計算", () => {
  it("ガソリン代のチェックは経費のときだけ。通常の支出入力欄は維持され、燃費の入力欄は出ない", async () => {
    await mount();
    expect(q('[data-testid="fuel-toggle"]')).toBeNull();
    selectCategory("expense");
    expect(q('[data-testid="fuel-toggle"]')).not.toBeNull();
    expect(q('[data-testid="expense-item-name"]')).not.toBeNull();
    await click(q('[data-testid="fuel-toggle"]')!);
    expect(q('[data-testid="fuel-form"]')).not.toBeNull();
    expect(document.body.textContent).not.toContain("燃費");
    expect((q('[data-testid="expense-item-name"]') as HTMLInputElement).value).toBe("ガソリン代");
    expect(q('[data-testid="expense-item-name"]')).not.toBeNull(); // 通常の経費入力欄も残る
  });
  it("単価の初期値は155円。往復の計算結果が金額欄に入り、手動で修正できる", async () => {
    await mount();
    selectCategory("expense");
    await click(q('[data-testid="fuel-toggle"]')!);
    expect(input("ガソリン単価").value).toBe("155");
    change(input("片道距離"), "8.5");
    await click(q('[data-testid="fuel-calc-btn"]')!);
    expect(input("購入金額1").value).toBe("158"); // 8.5×2÷16.7×155 = 157.8 → 158
    change(input("購入金額1"), "200"); // 計算後の手動修正
    expect(input("購入金額1").value).toBe("200");
    // 片道に切り替えて再計算
    await click(q('[data-testid="fuel-oneway"]')!);
    await click(q('[data-testid="fuel-calc-btn"]')!);
    expect(input("購入金額1").value).toBe("79"); // 8.5÷16.7×155 = 78.9 → 79
  });
  it("不正な距離は計算せず、理由を表示する", async () => {
    await mount();
    selectCategory("expense");
    await click(q('[data-testid="fuel-toggle"]')!);
    await click(q('[data-testid="fuel-calc-btn"]')!);
    expect(q('[data-testid="fuel-error"]')!.textContent).toContain("片道距離");
    expect(input("購入金額1").value).toBe("");
  });
  it("保存済みの系列＋店舗を選ぶと片道距離が自動入力され、別の店舗では流用されない", async () => {
    await mount();
    selectCategory("expense");
    change(input("系列"), "A系列");
    change(input("購入店舗"), "三宮店");
    await click(q('[data-testid="fuel-toggle"]')!);
    // マスターの系列・店舗として一致しているので、保存済みの距離(34km)が入る
    expect(input("片道距離").value).toBe("34");
    change(input("購入店舗"), "大阪店");
    await flush();
    expect(input("片道距離").value).toBe(""); // 別の店舗の距離は使わない
  });
  it("計算時に、系列が決まっていれば距離を系列＋店舗に保存する", async () => {
    await mount();
    selectCategory("expense");
    change(input("系列"), "A系列");
    change(input("購入店舗"), "大阪店");
    await click(q('[data-testid="fuel-toggle"]')!);
    change(input("片道距離"), "20");
    await click(q('[data-testid="fuel-calc-btn"]')!);
    expect(saveTrip).toHaveBeenCalledWith("c1", "s2", 20, null);
  });
  it("チェックをOFFに戻すと、通常の経費入力へ戻る（内容を元に戻す）", async () => {
    await mount();
    selectCategory("expense");
    change(q('[data-testid="expense-item-name"]')!, "駐車場代");
    await click(q('[data-testid="fuel-toggle"]')!);
    expect((q('[data-testid="expense-item-name"]') as HTMLInputElement).value).toBe("ガソリン代");
    await click(q('[data-testid="fuel-toggle"]')!);
    expect(q('[data-testid="fuel-form"]')).toBeNull();
    expect((q('[data-testid="expense-item-name"]') as HTMLInputElement).value).toBe("駐車場代");
  });
});
