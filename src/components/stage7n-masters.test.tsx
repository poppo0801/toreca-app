import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createMockData } from "@/data/mock";
import { ENTITY_KEYS } from "@/lib/masters";
import type { AppData } from "@/types/domain";

const NOW = new Date("2026-11-03T03:00:00Z");
let data: AppData = createMockData(NOW);
const refresh = vi.fn();
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh, push: vi.fn() }), usePathname: () => "/settings/masters", useSearchParams: () => new URLSearchParams("") }));
vi.mock("@/components/app-provider", () => ({ useApp: () => ({ data, now: NOW, profile: data.profiles[0], persistent: true, reload: async () => {}, actions: {} }) }));
vi.mock("@/app/(app)/settings/masters/actions", () => ({ retryFailedGeocoding: vi.fn(), saveRecord: vi.fn(async () => ({ ok: true })), setRetired: vi.fn(), setRetiredBulk: vi.fn() }));
vi.mock("@/app/(app)/settings/household-actions", () => ({ geocodeAddress: vi.fn() }));
vi.mock("@/app/(app)/settings/rules/actions", () => ({ setProfileTargetsAction: vi.fn() }));
vi.mock("@/components/chain-logo-manager", () => ({ ChainLogoButton: () => null }));
vi.mock("@/components/product-image", () => ({ ProductImagesButton: () => null, ProductThumbById: () => null }));
vi.mock("@/components/chain-merge-dialog", () => ({ ChainDeleteButton: () => null, ChainMergeButton: () => null }));
vi.mock("@/components/chain-store-select-toggle", () => ({ ChainStoreSelectToggle: () => null }));
vi.mock("@/components/product-merge-dialog", () => ({ ProductDeleteButton: () => null, ProductMergeButton: () => null }));
vi.mock("@/components/product-set-dialog", () => ({ SetCompositionButton: () => null }));

import { MastersView, type MasterRows, type Row } from "@/components/masters-view";
import { AppliedStoreDialog } from "@/components/applied-store-dialog";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root;
let host: HTMLDivElement;
const q = (id: string) => document.body.querySelector<HTMLElement>(`[data-testid="${id}"]`);
const qa = (id: string) => [...document.body.querySelectorAll<HTMLElement>(`[data-testid="${id}"]`)];
const click = (el: Element | null | undefined) => act(() => (el as HTMLElement).click());
const type = (el: HTMLInputElement, v: string) =>
  act(() => {
    const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
    set.call(el, v);
    el.dispatchEvent(new Event("input", { bubbles: true }));
  });

const store = (id: string, chain_id: string, name: string, over: Record<string, unknown> = {}): Row => ({ id, chain_id, name, prefecture: "兵庫県", sales_kind: "physical", is_provisional: false, archived_at: null, latitude: null, longitude: null, geo_status: "none", ...over });
function rows(): MasterRows {
  const r = Object.fromEntries(ENTITY_KEYS.map((k) => [k, [] as Row[]])) as unknown as MasterRows;
  r.chains = [
    { id: "c-g", name: "GEO", archived_at: null },
    { id: "c-f", name: "ふるいち", archived_at: null },
    { id: "c-d", name: "ドラゴンスター", archived_at: null },
  ] as Row[];
  r.stores = [store("s1", "c-g", "伊川谷店"), store("s2", "c-g", "神戸店", { is_provisional: true }), store("s3", "c-g", "GEO通販", { sales_kind: "online_only", prefecture: "" }), store("s4", "c-f", "梅田店", { prefecture: "大阪府", is_provisional: true })];
  r.chain_aliases = [];
  return r;
}

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
});

const openStores = () => {
  act(() => root.render(createElement(MastersView, { rows: rows(), rules: [] })));
  click([...document.body.querySelectorAll<HTMLElement>('[role="tab"]')].find((t) => t.textContent === "店舗"));
};

describe("Stage 7N: 店舗マスターの系列別一覧", () => {
  it("初期は系列ごとのコンパクトなカードで全て折りたたみ。系列名・店舗数・未確認数（●N）を出す", () => {
    openStores();
    const groups = qa("store-group");
    expect(groups.map((g) => g.querySelector("button")!.textContent)).toEqual(expect.arrayContaining([expect.stringContaining("GEO")]));
    expect(groups.every((g) => g.getAttribute("data-open") === "0")).toBe(true);
    expect(qa("store-row")).toHaveLength(0);
    const geo = groups.find((g) => g.textContent?.includes("GEO"))!;
    expect(geo.querySelector('[data-testid="store-group-count"]')!.textContent).toBe("3店舗");
    expect(geo.querySelector('[data-testid="store-group-unconfirmed"]')!.textContent).toBe("1");
    // 未確認のない系列には出さない
    expect(groups.find((g) => g.textContent?.includes("ドラゴンスター"))!.querySelector('[data-testid="store-group-unconfirmed"]')).toBeNull();
    // 「仮」の文字バッジは出さない
    expect(document.body.textContent).not.toContain("仮");
  });

  it("展開すると店舗が1行ずつ。未確認が先頭で店舗名の右に●（文字なし）。通販は「通販」表示で距離・交通費なし。末尾に「店舗を追加」", () => {
    openStores();
    click(qa("store-group-toggle").find((b) => b.textContent?.includes("GEO")));
    const rowsEl = qa("store-row");
    expect(rowsEl.map((r) => r.querySelector("span span")!.textContent)).toEqual(["神戸店", "GEO通販", "伊川谷店"]) // 距離なしのため名前順（距離順は lib のテストで確認）;
    expect(rowsEl[0].getAttribute("data-unconfirmed")).toBe("1");
    expect(rowsEl[0].querySelector('[data-testid="unconfirmed-dot"]')).not.toBeNull();
    expect(rowsEl[0].textContent).not.toMatch(/仮|未確認/);
    expect(rowsEl[2].querySelector('[data-testid="unconfirmed-dot"]')).toBeNull();
    expect(rowsEl[1].querySelector('[data-testid="store-mail-order"]')!.textContent).toBe("通販");
    expect(rowsEl[1].textContent).not.toContain("交通費");
    expect(q("store-add-in-chain")).not.toBeNull();
    // もう一度押すと折りたたむ
    click(qa("store-group-toggle").find((b) => b.textContent?.includes("GEO")));
    expect(qa("store-row")).toHaveLength(0);
  });

  it("検索（店舗名・都道府県・系列名）: 該当する系列を自動展開し、該当店舗だけ表示する", () => {
    openStores();
    type(q("master-search") as HTMLInputElement, "伊川谷");
    const groups = qa("store-group");
    expect(groups).toHaveLength(1);
    expect(groups[0].getAttribute("data-open")).toBe("1");
    expect(qa("store-row").map((r) => r.textContent)).toEqual([expect.stringContaining("伊川谷店")]);
    expect(qa("store-row")).toHaveLength(1);
    type(q("master-search") as HTMLInputElement, "大阪");
    expect(qa("store-group").map((g) => g.textContent)).toEqual([expect.stringContaining("ふるいち")]);
    type(q("master-search") as HTMLInputElement, "存在しない");
    expect(document.body.textContent).toContain("該当する項目がありません");
  });

  it("編集画面に「● 未確認」と明記（確認済みの店舗には出さない）。系列内の「店舗を追加」は系列が自動設定される", () => {
    openStores();
    click(qa("store-group-toggle").find((b) => b.textContent?.includes("GEO")));
    const [unconfirmedRow, , confirmedRow] = qa("store-row");
    click([...unconfirmedRow.querySelectorAll("button")].find((b) => b.textContent === "編集"));
    expect(q("unconfirmed-note")!.textContent).toContain("未確認");
    click([...document.body.querySelectorAll("button")].find((b) => b.textContent === "キャンセル"));
    click([...confirmedRow.querySelectorAll("button")].find((b) => b.textContent === "編集"));
    expect(q("unconfirmed-note")).toBeNull();
  });

  it("系列マスターにも検索欄。系列名で絞り込む", () => {
    act(() => root.render(createElement(MastersView, { rows: rows(), rules: [] })));
    expect(qa("master-row")).toHaveLength(3);
    type(q("master-search") as HTMLInputElement, "ふるい");
    expect(qa("master-row")).toHaveLength(1);
  });
});

describe("Stage 7N: 応募店舗の入力（フリーズ対策・スピナー）", () => {
  const lottery = () => data.lotteries.find((l) => l.id === "L1")!;

  it("都道府県は標準のプルダウンではなく、シート内の一覧から選ぶ（iOSのピッカーを使わない）", () => {
    act(() => root.render(createElement(AppliedStoreDialog, { lottery: lottery(), onSubmit: async () => {}, onClose: () => {} })));
    const input = document.body.querySelector<HTMLInputElement>('input[role="combobox"]')!;
    type(input, "新規の未登録店");
    expect(document.body.querySelector("select")).toBeNull();
    expect(q("pref-picker")).not.toBeNull();
    expect(qa("pref-option")).toHaveLength(0); // 閉じた状態が初期
    click(q("pref-toggle"));
    expect(qa("pref-option").length).toBeGreaterThan(40);
    click(qa("pref-option").find((o) => o.textContent === "大阪府"));
    expect(q("pref-toggle")!.textContent).toContain("大阪府");
    expect(qa("pref-option")).toHaveLength(0); // 選ぶと閉じる
  });

  it("決定を押した直後からスピナー表示・ボタン無効。二重に押しても1回だけ送信し、完了後に戻る", async () => {
    let resolve!: () => void;
    const onSubmit = vi.fn(() => new Promise<void>((r) => (resolve = r)));
    act(() => root.render(createElement(AppliedStoreDialog, { lottery: lottery(), onSubmit, onClose: () => {}, confirmLabel: "応募済みにする" })));
    type(document.body.querySelector<HTMLInputElement>('input[role="combobox"]')!, "ある店");
    const ok = q("applied-store-ok") as HTMLButtonElement;
    click(ok);
    click(ok);
    expect(onSubmit).toHaveBeenCalledTimes(1);
    expect(q("applied-store-spinner")).not.toBeNull();
    expect((q("applied-store-ok") as HTMLButtonElement).disabled).toBe(true);
    await act(async () => resolve());
    expect(q("applied-store-spinner")).toBeNull();
  });

  it("失敗したらエラーを表示してダイアログを開いたまま、再操作できる", async () => {
    const onSubmit = vi.fn(async () => ({ ok: false as const, error: "応募を記録できませんでした" }));
    act(() => root.render(createElement(AppliedStoreDialog, { lottery: lottery(), onSubmit, onClose: () => {} })));
    type(document.body.querySelector<HTMLInputElement>('input[role="combobox"]')!, "ある店");
    await act(async () => (q("applied-store-ok") as HTMLButtonElement).click());
    expect(q("applied-store-error")!.textContent).toContain("応募を記録できませんでした");
    expect((q("applied-store-ok") as HTMLButtonElement).disabled).toBe(false);
    await act(async () => (q("applied-store-ok") as HTMLButtonElement).click());
    expect(onSubmit).toHaveBeenCalledTimes(2);
  });
});
