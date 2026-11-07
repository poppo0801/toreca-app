import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const addManual = vi.fn(async (..._a: unknown[]) => ({ ok: true }) as { ok: boolean; error?: string });
vi.mock("@/app/(app)/collection/box-actions", () => ({
  addBoxPricesAction: async () => ({ ok: true }),
  addManualBoxAction: (...a: unknown[]) => addManual(...a),
  importPurchaseItemAction: async () => ({ ok: true }),
  saveBoxSettingsAction: async () => ({ ok: true }),
}));
vi.mock("@/components/product-image", () => ({ ProductThumb: () => null }));
vi.mock("@/components/app-provider", () => ({
  useApp: () => ({
    profile: { id: "p1" },
    data: {
      purchases: [],
      chains: [
        { id: "c1", name: "A系列", aliases: ["エー"] },
        { id: "c2", name: "B系列" },
      ],
      stores: [
        { id: "s1", chainId: "c1", name: "三宮店" },
        { id: "s2", chainId: "c2", name: "B店" },
      ],
      products: [
        { id: "pr1", officialName: "定価ありBOX", code: "", archived: false, listPriceBox: 5400 },
        { id: "pr2", officialName: "定価なしBOX", code: "", archived: false, listPriceBox: null },
        { id: "pr3", officialName: "別の定価BOX", code: "", archived: false, listPriceBox: 6000 },
      ],
    },
  }),
}));

import { BoxFormDialog } from "@/components/box-dialogs";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root | null = null;
let host: HTMLDivElement;
beforeEach(() => {
  addManual.mockClear();
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
  await act(async () => root!.render(createElement(BoxFormDialog, { onClose: () => undefined, onSaved: () => undefined })));
  await flush();
};
const input = (label: string) => document.body.querySelector(`[aria-label="${label}"]`) as HTMLInputElement | HTMLSelectElement;
const change = (el: HTMLElement, value: string) => {
  const proto = el instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(proto, "value")!.set!.call(el, value);
  act(() => {
    el.dispatchEvent(new Event(el instanceof HTMLSelectElement ? "change" : "input", { bubbles: true }));
  });
};
const pickProduct = (name: string) => {
  // マスターの商品名と一致する入力は、その商品を確定した扱いになる
  change(input("BOXの商品"), name);
};

describe("Stage 6P: BOX登録フォーム", () => {
  it("新規登録のシュリンク状態は「シュリンクあり」が初期選択。選択肢は あり／なし／－", async () => {
    await mount();
    const sel = input("シュリンク状態") as HTMLSelectElement;
    expect(sel.value).toBe("shrink");
    expect([...sel.options].map((o) => o.textContent)).toEqual(["シュリンクあり", "シュリンクなし", "－"]);
    expect(document.body.textContent).not.toContain("状態未確認");
  });
  it("商品を確定すると、商品マスターの定価が購入価格に入る。定価が無ければ空欄のまま", async () => {
    await mount();
    expect(input("実際の購入価格").value).toBe("");
    pickProduct("定価ありBOX");
    expect(input("実際の購入価格").value).toBe("5400");
    pickProduct("定価なしBOX");
    expect(input("実際の購入価格").value).toBe(""); // 前の商品の定価を残さない
  });
  it("商品を変えると、自動入力した価格は新しい商品の定価に更新される", async () => {
    await mount();
    pickProduct("定価ありBOX");
    pickProduct("別の定価BOX");
    expect(input("実際の購入価格").value).toBe("6000");
  });
  it("手入力した購入価格は、商品を選んでも・変えても上書きしない", async () => {
    await mount();
    change(input("実際の購入価格"), "4980");
    pickProduct("定価ありBOX");
    expect(input("実際の購入価格").value).toBe("4980");
    pickProduct("別の定価BOX");
    expect(input("実際の購入価格").value).toBe("4980");
  });
  it("購入元は系列と店舗の2項目。店舗は選んだ系列の店舗に絞られ、系列の別名は既存の系列として扱う", async () => {
    await mount();
    expect(input("購入元の系列")).not.toBeNull();
    expect(input("購入元の店舗")).not.toBeNull();
    change(input("購入元の系列"), "エー"); // 別名
    act(() => input("購入元の店舗").focus());
    change(input("購入元の店舗"), "店");
    const opts = [...document.body.querySelectorAll('[role="option"]')].map((o) => o.textContent ?? "");
    expect(opts.some((t) => t.includes("三宮店"))).toBe(true);
    expect(opts.some((t) => t.includes("B店"))).toBe(false);
    expect(input("購入元の系列").value).toBe("A系列"); // 別名から正式名称にそろう（重複した系列を作らない）
  });
  it("保存すると、系列と店舗を合わせた購入元と、初期値のシュリンクありで登録される。店舗なしの系列は系列のみ", async () => {
    await mount();
    pickProduct("定価ありBOX");
    change(input("購入元の系列"), "B系列");
    await act(async () => (document.body.querySelector('[data-testid="box-dialog-save"]') as HTMLElement).click());
    await flush();
    expect(addManual).toHaveBeenCalledTimes(1);
    const sent = addManual.mock.calls[0][0] as { state: string; storeLabel: string; actualUnitPrice: number; productId: string };
    expect(sent).toMatchObject({ productId: "pr1", state: "shrink", storeLabel: "B系列", actualUnitPrice: 5400 });
  });
});
