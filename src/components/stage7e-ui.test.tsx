import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createMockData } from "@/data/mock";
import type { ApplyExitApi } from "@/components/apply-exit";
import type { AppData, Application, Purchase } from "@/types/domain";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const NOW = new Date("2026-11-08T03:00:00Z");
let data: AppData = createMockData(NOW);
const actions = { setFulfillment: vi.fn(), saveExpense: vi.fn(async () => ({ ok: true as const, data })), deleteExpense: vi.fn() };
vi.mock("next/navigation", () => ({ usePathname: () => "/purchases", useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }), useSearchParams: () => new URLSearchParams("") }));
vi.mock("@/components/app-provider", () => ({
  useApp: () => ({ data, now: NOW, profile: data.profiles[0], settings: {}, actions, persistent: true, reload: async () => null }),
}));

import { PurchasesView, totalDisplay } from "@/components/purchases-view";
import { ExpenseDialog } from "@/components/expense-dialog";
import { WonRecordButtons } from "@/components/won-actions";
import { ApplyExitProvider } from "@/components/apply-exit";
import { productTotals, filterPurchases, ALL_PURCHASES } from "@/lib/purchase-records";

let root: Root;
let host: HTMLDivElement;
beforeEach(() => {
  data = createMockData(NOW);
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  document.body.innerHTML = "";
  vi.clearAllMocks();
});
const q = (id: string) => document.body.querySelector<HTMLElement>(`[data-testid="${id}"]`);
const qa = (id: string) => [...document.body.querySelectorAll<HTMLElement>(`[data-testid="${id}"]`)];

const pk = (id: string, date: string, items: Purchase["items"], category = "pokemon_card", extra: Partial<Purchase> = {}): Purchase => ({
  id, applicationId: null, storeId: null, purchasedOn: { precision: "date_only", date }, channel: "store", source: "manual", items, note: "", category, ...extra,
});
const setup = () => {
  data = {
    ...data,
    products: [
      { id: "p-box", officialName: "30th CELEBRATION", aliases: [], code: "", packsPerBox: 20 },
      { id: "p-deck", officialName: "スタートデッキセット", aliases: [], code: "", packsPerBox: null },
    ] as never,
    productSetItems: [],
    defaultImages: { single_card: { url: "/api/default-image/single_card?v=abc" } },
    purchases: [
      pk("a", "2026-11-01", [{ id: "i1", productId: "p-box", quantity: 3, unit: "box", amountPaid: 21600 }]),
      pk("d", "2026-11-04", [{ id: "i4", productId: "p-deck", quantity: 3, unit: "set", amountPaid: 9000 }]),
      pk("e", "2026-11-05", [{ id: "i5", productId: null, productLabel: "シングルカード", quantity: 6, unit: "piece", amountPaid: 6260 }], "single_card"),
    ],
  };
};
const mountView = () => {
  setup();
  act(() => root.render(createElement(PurchasesView)));
  // 期間は今月（実際の日付）なので、全期間にして固定データを見る
};
const toAll = async () => {
  await act(async () => q("period-label")!.click());
  const allTab = [...document.body.querySelectorAll<HTMLElement>('[role="tab"]')].find((t) => t.textContent === "全期間")!;
  await act(async () => allTab.click());
};

describe("Stage 7E: 購入記録ページ", () => {
  it("タブは左が商品別の累計・右が購入履歴で、初期表示は商品別の累計", () => {
    mountView();
    const tabs = [...document.body.querySelectorAll<HTMLElement>('[role="tablist"][aria-label="表示の切替"] [role="tab"]')];
    expect(tabs.map((t) => t.textContent)).toEqual(["商品別の累計", "購入履歴"]);
    expect(tabs[0].getAttribute("aria-selected")).toBe("true");
    expect(q("product-totals")).not.toBeNull();
    expect(q("purchase-list")).toBeNull();
  });
  it("上部は『購入件数・購入金額』の大きなカードではなく、BOX・パック・その他商品・総額の横4分割", async () => {
    mountView();
    await toAll();
    const cells = ["box", "pack", "other", "amount"].map((k) => q(`stat-${k}`)!);
    expect(cells.map((c) => c.querySelector("dt")!.textContent)).toEqual(["BOX", "パック", "その他商品", "総額"]);
    expect(cells.map((c) => c.querySelector("dd")!.textContent)).toEqual(["3", "60", "3", "¥36,860"]);
    expect(q("purchase-summary")!.className).toContain("grid-cols-4");
    expect(q("purchase-count")).toBeNull();
    expect(document.body.textContent).not.toContain("購入金額");
  });
  it("商品別: 商品名・累計パック数を大きく、BOX数と購入総額を補足に。セット商品は個数、シングルカードは枚。説明文は出ない", async () => {
    mountView();
    await toAll();
    const rows = qa("product-total-row");
    const by = (name: string) => rows.find((r) => r.querySelector('[data-testid="total-name"]')!.textContent === name)!;
    expect(by("30th CELEBRATION").querySelector('[data-testid="total-qty"]')!.textContent).toBe("60パック");
    expect(by("30th CELEBRATION").querySelector('[data-testid="total-sub"]')!.textContent).toBe("3BOX ｜ 購入総額 21,600円");
    expect(by("スタートデッキセット").querySelector('[data-testid="total-qty"]')!.textContent).toBe("3個");
    expect(by("スタートデッキセット").querySelector('[data-testid="total-sub"]')!.textContent).toBe("購入総額 9,000円");
    expect(by("シングルカード").querySelector('[data-testid="total-qty"]')!.textContent).toBe("6枚");
    expect(by("シングルカード").querySelector('[data-testid="total-sub"]')!.textContent).toBe("購入総額 6,260円");
    expect(document.body.textContent).not.toContain("構成商品には数量だけを参考として加えます");
    // シングルカードは標準画像を表示（商品個別の画像が無いとき）
    expect(by("シングルカード").querySelector('[data-testid="default-image"]')?.getAttribute("src")).toBe("/api/default-image/single_card?v=abc");
  });
  it("パック換算できない商品は、無理にパック数を出さない", () => {
    const r = productTotals({ ...data, products: [{ id: "x", officialName: "入数不明", aliases: [], code: "", packsPerBox: null }] as never, productSetItems: [] }, [pk("x1", "2026-11-01", [{ id: "q", productId: "x", quantity: 2, unit: "box", amountPaid: 100 }])])[0];
    expect(totalDisplay(r)).toEqual({ qty: "2BOX", sub: "購入総額 100円" });
  });
  it("購入履歴: 日付見出しを廃止し、各カードに購入日。数量は『3BOX』『6個』『6枚』の形。『コレクションに追加』のリンクは無い。金額は右寄せ", async () => {
    mountView();
    await toAll();
    await act(async () => q("tab-history")!.click());
    const rows = qa("purchase-row");
    expect(rows).toHaveLength(3);
    expect(qa("purchase-list")[0].querySelector("ul")).toBeNull(); // 日付ごとのグループ（入れ子の一覧）が無い
    expect(q("to-collection")).toBeNull();
    expect(document.body.textContent).not.toContain("コレクションに追加");
    expect(rows.map((r) => r.querySelector('[data-testid="purchase-qty"]')!.textContent)).toEqual(["6枚", "3セット", "3BOX"]);
    expect(rows.map((r) => r.querySelector('[data-testid="purchase-date"]')!.textContent)).toEqual(["11/5（木）", "11/4（水）", "11/1（日）"]);
    expect(rows[0].querySelector('[data-testid="purchase-amount"]')!.className).toContain("text-right");
    // 1件ごとの独立したカード
    expect(rows.every((r) => r.className.includes("rounded-xl") && r.className.includes("border"))).toBe(true);
  });
  it("絞り込みは月選択欄の右の小さなアイコンボタン（専用の1行を使わない）", () => {
    mountView();
    const f = q("filter-toggle")!;
    expect(f.textContent).toBe("");
    expect(f.className).toContain("size-10");
    expect(f.parentElement).toBe(q("period-label")!.parentElement!.parentElement);
    act(() => f.click());
    expect(q("purchase-filters")).not.toBeNull();
  });
});

describe("Stage 7E: 支出登録の品目と数量・単位", () => {
  const mountDialog = () => act(() => root.render(createElement(ExpenseDialog, { open: true, onOpenChange: () => undefined, purchase: null })));
  const setCategory = async (v: string) => {
    const sel = q("expense-category") as HTMLSelectElement;
    const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")!.set!;
    await act(async () => {
      setter.call(sel, v);
      sel.dispatchEvent(new Event("change", { bubbles: true }));
    });
  };
  it("品目は5つ。開いた直後にキーボードや選択UIは自動で開かない（入力欄にフォーカスしない）", async () => {
    mountDialog();
    await act(async () => void (await new Promise((r) => setTimeout(r, 30))));
    const opts = [...(q("expense-category") as HTMLSelectElement).options].map((o) => o.textContent);
    expect(opts).toEqual(["ポケモンカード", "シングルカード", "周辺グッズ", "経費", "その他"]);
    expect(/^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement?.tagName ?? "")).toBe(false);
  });
  it("数量の右に単位が横並び（同じ行）。複数商品でも同じ形式", async () => {
    mountDialog();
    const row = q("qty-unit-row")!;
    const qty = row.querySelector('input[aria-label="数量1"]')!;
    const unit = row.querySelector('select[aria-label="単位1"]')!;
    expect(qty).not.toBeNull();
    expect(unit).not.toBeNull();
    expect(qty.compareDocumentPosition(unit) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(unit.className).toContain("flex-1");
    expect(qty.className).toContain("w-20");
    const add = [...document.body.querySelectorAll("button")].find((b) => b.textContent?.includes("商品を追加"))!;
    await act(async () => add.click());
    expect(qa("qty-unit-row")).toHaveLength(2);
  });
  it("シングルカードは単位が『枚』で固定（選び直せない）。保存は個として送る", async () => {
    mountDialog();
    await setCategory("single_card");
    const unit = q("unit-fixed") as HTMLSelectElement;
    expect(unit.disabled).toBe(true);
    expect([...unit.options].map((o) => o.textContent)).toEqual(["枚"]);
    const name = document.body.querySelector<HTMLInputElement>('input[aria-label="カード名1"]')!;
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
    await act(async () => {
      setter.call(name, "ピカチュウ");
      name.dispatchEvent(new Event("input", { bubbles: true }));
    });
    const form = document.body.querySelector("form")!;
    await act(async () => void form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
    expect(actions.saveExpense).toHaveBeenCalledTimes(1);
    const input = (actions.saveExpense.mock.calls[0] as unknown as [string | null, { category: string; items: { unit: string; quantity: number }[] }])[1];
    expect(input.category).toBe("single_card");
    expect(input.items[0]).toMatchObject({ unit: "piece", quantity: 1 });
  });
  it("その他・周辺グッズ・経費では、ポケモンカードの単位選択を出さない", async () => {
    mountDialog();
    for (const c of ["other", "goods"]) {
      await setCategory(c);
      expect(document.body.querySelector('select[aria-label="単位1"]')).toBeNull();
    }
  });
});

describe("Stage 7E: 受取の記録の退出アニメーション（当選タブ）", () => {
  const mkExit = () => {
    const calls: string[] = [];
    const handle = { ok: vi.fn(() => void calls.push("ok")), fail: vi.fn(() => void calls.push("fail")) };
    const api: ApplyExitApi = { begin: vi.fn((id: string) => (calls.push(`begin:${id}`), handle)), cancel: vi.fn(), active: vi.fn(() => false), pin: vi.fn() };
    return { api, handle, calls };
  };
  const wonSetup = () => {
    const lot = data.lotteries.find((l) => l.id === "L7")!;
    const app = data.applications.find((a) => a.id === "ap5")! as Application;
    return { lot, app };
  };
  const press = async () => {
    const btn = q("record-receive") ?? q("record-purchase");
    await act(async () => btn!.click());
    await act(async () => void (await new Promise((r) => setTimeout(r, 10))));
  };
  it("受取を記録すると、共通の退出アニメーションを開始し、保存に成功したら退出を続ける", async () => {
    const { lot, app } = wonSetup();
    data = { ...data, lotteries: data.lotteries.map((l) => (l.id === lot.id ? { ...l, procedureStart: { precision: "date_only", date: "2026-11-01" }, procedureDeadline: { precision: "date_only", date: "2026-11-20" }, procedureSplit: false } : l)) };
    actions.setFulfillment.mockResolvedValue({ ok: true, data });
    const { api, handle, calls } = mkExit();
    act(() => root.render(createElement(ApplyExitProvider, { value: api }, createElement(WonRecordButtons, { lottery: data.lotteries.find((l) => l.id === lot.id)!, app }))));
    await press();
    expect(calls).toEqual([`begin:${lot.id}`, "ok"]);
    expect(handle.fail).not.toHaveBeenCalled();
    expect(actions.setFulfillment).toHaveBeenCalledWith(app.id, "purchased");
  });
  it("保存に失敗したら退出を取り消してカードを元に戻す（エラーは表示）", async () => {
    const { lot, app } = wonSetup();
    data = { ...data, lotteries: data.lotteries.map((l) => (l.id === lot.id ? { ...l, procedureStart: { precision: "date_only", date: "2026-11-01" }, procedureDeadline: { precision: "date_only", date: "2026-11-20" }, procedureSplit: false } : l)) };
    actions.setFulfillment.mockResolvedValue({ ok: false, error: "保存できませんでした" });
    const { api, calls } = mkExit();
    act(() => root.render(createElement(ApplyExitProvider, { value: api }, createElement(WonRecordButtons, { lottery: data.lotteries.find((l) => l.id === lot.id)!, app }))));
    await press();
    expect(calls).toEqual([`begin:${lot.id}`, "fail"]);
  });
  it("購入の記録（当選タブに残る操作）では退出アニメーションを使わない", async () => {
    const { lot, app } = wonSetup();
    data = { ...data, lotteries: data.lotteries.map((l) => (l.id === lot.id ? { ...l, procedureSplit: true, procedureStart: { precision: "date_only", date: "2026-11-01" }, procedureDeadline: { precision: "date_only", date: "2026-11-20" }, receiveStart: { precision: "date_only", date: "2026-11-21" }, receiveDeadline: { precision: "date_only", date: "2026-11-30" } } : l)) };
    actions.setFulfillment.mockResolvedValue({ ok: true, data });
    const { api, calls } = mkExit();
    act(() => root.render(createElement(ApplyExitProvider, { value: api }, createElement(WonRecordButtons, { lottery: data.lotteries.find((l) => l.id === lot.id)!, app: { ...app, fulfillment: "none" } }))));
    await press();
    expect(actions.setFulfillment).toHaveBeenCalledWith(app.id, "procedure_done");
    expect(calls).toEqual([]);
  });
});

void filterPurchases;
void ALL_PURCHASES;
