import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createMockData } from "@/data/mock";
import type { AppData, Purchase } from "@/types/domain";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const NOW = new Date("2026-11-09T03:00:00Z");
let data: AppData = createMockData(NOW);
const saveOpening = vi.fn(async (...args: unknown[]) => ({ ok: args.length >= 0, id: "new" }));
const updateOpening = vi.fn(async (...args: unknown[]) => ({ ok: args.length >= 0, id: "x" }));
const cancelOpening = vi.fn(async (...args: unknown[]) => ({ ok: args.length >= 0, id: "x" }));
vi.mock("next/navigation", () => ({ usePathname: () => "/purchases", useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }), useSearchParams: () => new URLSearchParams("") }));
vi.mock("@/app/(app)/purchases/opening-actions", () => ({
  saveOpeningAction: (...a: unknown[]) => saveOpening(...a),
  updateOpeningAction: (...a: unknown[]) => updateOpening(...a),
  cancelOpeningAction: (...a: unknown[]) => cancelOpening(...a),
}));
vi.mock("@/components/app-provider", () => ({
  useApp: () => ({ data, now: NOW, profile: data.profiles[0], settings: {}, actions: { saveExpense: vi.fn(), deleteExpense: vi.fn() }, persistent: true, reload: async () => null }),
}));
vi.mock("@/components/expense-dialog", () => ({ ExpenseDialog: () => createElement("div", { "data-testid": "expense-dialog-mock" }) }));

import { PurchasesView } from "@/components/purchases-view";

let root: Root;
let host: HTMLDivElement;
beforeEach(() => {
  data = createMockData(NOW);
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  vi.spyOn(window, "confirm").mockReturnValue(true);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  document.body.innerHTML = "";
  vi.clearAllMocks();
  vi.restoreAllMocks();
});
const q = (id: string) => document.body.querySelector<HTMLElement>(`[data-testid="${id}"]`);
const qa = (id: string) => [...document.body.querySelectorAll<HTMLElement>(`[data-testid="${id}"]`)];
const click = (el: Element | null) => act(async () => void (el as HTMLElement).click());
const flush = () => act(async () => void (await new Promise((r) => setTimeout(r, 0))));
const pk = (id: string, date: string, items: Purchase["items"], category = "pokemon_card"): Purchase => ({ id, applicationId: null, storeId: null, purchasedOn: { precision: "date_only", date }, channel: "store", source: "manual", items, note: "", category }) as Purchase;

const setup = () => {
  const [pa, pb] = data.profiles;
  data = {
    ...data,
    products: [
      { id: "p-box", officialName: "30th CELEBRATION", aliases: ["30th"], code: "M6a", packsPerBox: 20 },
      { id: "p-pack", officialName: "単品パック商品", aliases: [], code: "", packsPerBox: null },
    ] as never,
    productSetItems: [],
    purchases: [
      pk("pu-box", "2026-11-01", [{ id: "i-box", productId: "p-box", quantity: 3, unit: "box", amountPaid: 21600 }]),
      pk("pu-pack", "2026-11-02", [{ id: "i-pack", productId: "p-pack", quantity: 5, unit: "pack", amountPaid: 750 }]),
      pk("pu-s", "2026-11-05", [{ id: "i-s", productId: null, productLabel: "ピカチュウ SAR", quantity: 2, unit: "piece", amountPaid: 4200 }], "single_card"),
    ],
    boxLotItemIds: ["i-box"],
    boxOpenings: [{ id: "m1", opId: "op1", lotId: "lot1", productId: "p-box", quantity: 1, occurredAt: "2026-11-08T15:30:00Z", profileId: pa.id, unitPrice: 7200, storeId: null, purchaseItemId: "i-box" }],
    openingRecords: [{ id: "o1", productId: "p-pack", label: "", quantity: 2, unit: "pack", openedOn: "2026-11-06", amountYen: 300, profileId: pb.id, purchaseItemId: "i-pack", note: "" }],
  };
  act(() => root.render(createElement(PurchasesView)));
};
const toAll = async () => {
  await click(q("period-label"));
  const allTab = [...document.body.querySelectorAll<HTMLElement>('[role="tab"]')].find((t) => t.textContent === "全期間")!;
  await click(allTab);
};

describe("Stage 7K: 購入記録ページ（開封とシングルカード）", () => {
  it("未開封BOXは含めず、開封した分だけ集計: BOX1・パック22(20+2)・総額 ¥11,700(7,200+300+4,200)。シングルカードは「その他商品」に入らない", async () => {
    setup();
    await toAll();
    const v = (k: string) => q(`stat-${k}`)!.querySelector("dd")!.textContent?.replace("＊", "");
    expect([v("box"), v("pack"), v("other"), v("amount")]).toEqual(["1", "22", "0", "¥11,700"]);
  });

  it("商品別累計: 20パック／開封1BOX｜総額 7,200円。単品パックは開封パック数。シングルカードは枚数。商品名は正式名称", async () => {
    setup();
    await toAll();
    const row = (name: string) => qa("product-total-row").find((r) => r.querySelector('[data-testid="total-name"]')!.textContent === name)!;
    expect(row("30th CELEBRATION").querySelector('[data-testid="total-qty"]')!.textContent).toBe("20パック");
    expect(row("30th CELEBRATION").querySelector('[data-testid="total-sub"]')!.textContent).toBe("開封1BOX ｜ 総額 7,200円");
    expect(row("単品パック商品").querySelector('[data-testid="total-qty"]')!.textContent).toBe("2パック");
    expect(row("ピカチュウ SAR").querySelector('[data-testid="total-qty"]')!.textContent).toBe("2枚");
    expect(qa("total-name").map((n) => n.textContent)).not.toContain("30th"); // 略称は使わない（正式名称のみ）
  });

  it("購入履歴: BOXは購入日ではなく開封日。未開封BOXの購入は出ない。BOX開封はBOXコレクションへのリンク、開封記録・シングルカードは編集できる", async () => {
    setup();
    await toAll();
    await click(q("tab-history"));
    const rows = qa("purchase-row");
    expect(rows).toHaveLength(3);
    const box = rows.find((r) => r.getAttribute("data-source") === "box_open")!;
    expect(box.tagName).toBe("A");
    expect(box.getAttribute("href")).toBe("/collection?tab=box");
    expect(box.querySelector('[data-testid="purchase-date"]')!.textContent).toBe("開封 11/9"); // 開封日(JST)。購入日(11/1)ではない
    expect(box.querySelector('[data-testid="purchase-qty"]')!.textContent).toBe("1BOX（20パック）");
    expect(box.querySelector('[data-testid="purchase-amount"]')!.textContent).toBe("7,200円");
    expect(rows.map((r) => r.querySelector('[data-testid="purchase-title"]')!.textContent)).not.toContain("30th");
    const single = rows.find((r) => r.getAttribute("data-source") === "single_purchase")!;
    expect(single.querySelector('[data-testid="purchase-date"]')!.textContent).toBe("購入 11/5");
    expect(single.querySelector('[data-testid="purchase-qty"]')!.textContent).toBe("2枚");
  });

  it("開封状態が不明な購入が一覧に出る。「開封済みにする」で購入明細に関連づけて登録（商品・単位は固定、金額は購入金額を按分）。収支の支出は作らない", async () => {
    setup();
    expect(q("unconfirmed")!.textContent).toContain("1件"); // 単品パックの残り3パック（5のうち2は確認済み）
    q("unconfirmed")!.setAttribute("open", "");
    const row = qa("unconfirmed-row")[0];
    expect(row.textContent).toContain("単品パック商品");
    expect(row.textContent).toContain("3パック");
    await click(row.querySelector('[data-testid="unconfirmed-open"]'));
    const form = q("opening-form")!;
    expect(form.querySelector('[data-testid="opening-product"]')!.textContent).toBe("単品パック商品");
    expect((form.querySelector('[aria-label="開封の数量"]') as HTMLInputElement).value).toBe("3");
    expect((form.querySelector('[aria-label="開封の単位"]') as HTMLSelectElement).disabled).toBe(true);
    expect((form.querySelector('[aria-label="開封分の購入金額"]') as HTMLInputElement).value).toBe("450"); // 750円×3/5
    await click(q("opening-save"));
    await flush();
    expect(saveOpening).toHaveBeenCalledTimes(1);
    const [input, actor, opId] = saveOpening.mock.calls[0] as [Record<string, unknown>, string, string | null];
    expect(input).toMatchObject({ productId: "p-pack", quantity: 3, unit: "pack", amountYen: 450, purchaseItemId: "i-pack" });
    expect(actor).toBe(data.profiles[0].id);
    expect(typeof opId).toBe("string");
    expect(q("opening-form")).toBeNull();
  });

  it("未確認の数量を超える数量は保存できない", async () => {
    setup();
    q("unconfirmed")!.setAttribute("open", "");
    await click(qa("unconfirmed-open")[0]);
    const input = q("opening-form")!.querySelector('[aria-label="開封の数量"]') as HTMLInputElement;
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
    await act(async () => {
      setter.call(input, "9");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await click(q("opening-save"));
    expect(q("opening-error")!.textContent).toContain("超えています");
    expect(saveOpening).not.toHaveBeenCalled();
  });

  it("開封の記録を取り消すと確認のうえ非表示になる（購入の記録は変わらない）", async () => {
    setup();
    await toAll();
    await click(q("tab-history"));
    const rec = qa("purchase-row").find((r) => r.getAttribute("data-source") === "opening")!;
    await click(rec);
    await click(q("opening-cancel"));
    await flush();
    expect(window.confirm).toHaveBeenCalled();
    expect(cancelOpening).toHaveBeenCalledWith("o1");
    expect(data.purchases).toHaveLength(3);
  });

  it("「＋記録」: 開封・使用開始の記録か、シングルカードの購入かを選ぶ。BOXの開封はコレクションで行う案内", async () => {
    setup();
    await click(q("purchase-add"));
    const ch = q("purchase-add-choose")!;
    expect(ch.textContent).toContain("開封・使用開始を記録");
    expect(ch.textContent).toContain("シングルカードの購入を記録");
    expect(ch.textContent).toContain("コレクションの「開封済みにする」");
    await click(q("choose-opening"));
    expect(q("opening-form")).not.toBeNull();
    expect(q("opening-form")!.textContent).toContain("収支の支出は増えません");
    // 入力欄に自動フォーカスしない（Stage 7D）
    expect(document.activeElement && (document.activeElement as HTMLElement).tagName).not.toBe("INPUT");
  });

  it("金額未設定の記録は0円とせず、総額に含めず件数を示す", async () => {
    setup();
    data = { ...data, boxOpenings: [{ ...data.boxOpenings![0], unitPrice: null }] };
    act(() => root.render(createElement(PurchasesView, { key: "again" })));
    await toAll();
    expect(q("amount-unknown-note")!.textContent).toContain("金額未設定が1件");
    expect(q("stat-amount")!.querySelector("dd")!.textContent).toContain("＊");
    await click(q("tab-history"));
    expect(qa("purchase-row").find((r) => r.getAttribute("data-source") === "box_open")!.querySelector('[data-testid="purchase-amount"]')!.textContent).toBe("金額未設定");
  });

  it("絞り込み: 分類（すべて／開封／シングルカード）とプロフィール。集計・累計・履歴に同じ条件", async () => {
    setup();
    await toAll();
    await click(q("filter-toggle"));
    const set = (sel: string, value: string) =>
      act(async () => {
        const el = q(sel) as HTMLSelectElement;
        Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")!.set!.call(el, value);
        el.dispatchEvent(new Event("change", { bubbles: true }));
      });
    await set("filter-kind", "single");
    expect(q("stat-amount")!.querySelector("dd")!.textContent).toBe("¥4,200");
    expect(qa("product-total-row")).toHaveLength(1);
    await set("filter-kind", "all");
    await set("filter-profile", data.profiles[1].id);
    expect(q("stat-pack")!.querySelector("dd")!.textContent).toBe("2"); // Bの単品パック2
    await click(q("filter-clear"));
    expect(qa("product-total-row")).toHaveLength(3);
  });
});
