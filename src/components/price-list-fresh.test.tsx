// @vitest-environment jsdom
/** 価格一覧: 最新の販売情報だけ表示（古い記録は詳細の推移で確認）・完売バッジ・更新/完売ボタン・最終確認日。 */
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { COMPARE_ROW_CLASS } from "@/components/compare-row";
import { PriceList, type PriceRow } from "@/components/price-list";
import type { PriceEvent } from "@/lib/zukan/freshness";

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
const row = (o: Partial<PriceRow>): PriceRow => ({ id: "r", storeName: "垂水店", chainName: "トレカキャピタル", surveyedOn: "2026-11-01", condition: "A", priceYen: 1500, note: "", createdAt: "2026-11-01T00:00:00Z", ...o });
const TODAY = "2026-11-23";
const noop = vi.fn();

beforeEach(() => {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  noop.mockClear();
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  document.body.innerHTML = "";
});
const mount = async (rows: PriceRow[], events: PriceEvent[] = [], extra: Record<string, unknown> = {}) => {
  await act(async () => root.render(createElement(PriceList, { rows, today: TODAY, boughtIds: new Set<string>(), events, keyOf: (r: PriceRow) => `market:${r.id}`, onBuy: noop, onEdit: noop, onDelete: noop, ...extra })));
  await flush();
};

describe("価格一覧: 最新・完売・更新", () => {
  it("同じ店舗・状態の古い記録は一覧に出ない（最新の1件だけ）。詳細の「この店の推移」では古い記録も確認できる。別の状態・店舗は別の行", async () => {
    await mount([row({ id: "old", surveyedOn: "2026-10-01", priceYen: 1500 }), row({ id: "new", surveyedOn: "2026-10-30", priceYen: 1000 }), row({ id: "b", condition: "B", priceYen: 900 }), row({ id: "s", storeName: "梅田店", priceYen: 1400 })]);
    const amounts = qa("price-amount").map((e) => e.textContent!.replace(/[^0-9]/g, ""));
    expect(amounts.sort()).toEqual(["1000", "1400", "900"]); // 1,500円（古い記録）は通常一覧に無い
    await click(qa("price-row").find((r) => r.textContent!.includes("1,000円"))!);
    expect(q("price-history")!.textContent).toContain("1,500円"); // 推移には残っている
    expect(q("price-history")!.textContent).toContain("1,000円");
  });

  it("完売: 「完売」バッジ・参考として残す・最安の強調対象にしない。日付は最終確認日。更新で販売中に戻せる（ボタン名が変わる）", async () => {
    const events: PriceEvent[] = [
      { recordKey: "market:a", event: "confirmed", happenedOn: "2026-11-20", createdAt: "2026-11-20T01:00:00Z" },
      { recordKey: "market:b", event: "sold_out", happenedOn: "2026-11-22", createdAt: "2026-11-22T01:00:00Z" },
    ];
    await mount([row({ id: "a", storeName: "A店", priceYen: 1500, surveyedOn: "2026-11-10" }), row({ id: "b", storeName: "B店", priceYen: 800, surveyedOn: "2026-11-15" })], events, { onConfirm: vi.fn(async () => null), onSoldOut: vi.fn(async () => null) });
    const a = qa("price-row").find((r) => r.textContent!.includes("A店"))!;
    const b = qa("price-row").find((r) => r.textContent!.includes("B店"))!;
    expect(a.querySelector('[data-testid="price-date"]')!.textContent).toBe("11/20"); // 最終確認日（更新で進む。調査日は11/10）
    expect(b.getAttribute("data-soldout")).toBe("true");
    expect(b.querySelector('[data-testid="soldout-badge"]')!.textContent).toBe("完売");
    expect(a.getAttribute("data-best")).toBe("true"); // 安い 800円は完売なので最安にしない
    expect(b.getAttribute("data-best")).toBe("false");
    await click(b);
    expect(q("detail-soldout")).not.toBeNull();
    expect(q("price-confirm")!.textContent).toBe("更新（販売中に戻す）");
    expect((q("price-soldout") as HTMLButtonElement).disabled).toBe(true); // 完売済みは押せない
  });

  it("更新・完売ボタンは呼び出し側の処理を1回呼び、成功すると閉じる。失敗するとエラーを表示して開いたまま", async () => {
    const onConfirm = vi.fn(async () => null);
    const onSoldOut = vi.fn(async () => "保存できませんでした");
    await mount([row({ id: "a" })], [], { onConfirm, onSoldOut });
    await click(q("price-row"));
    await click(q("price-confirm"));
    expect(onConfirm).toHaveBeenCalledTimes(1);
    expect(q("price-detail")).toBeNull();
    await click(q("price-row"));
    await click(q("price-soldout"));
    expect(onSoldOut).toHaveBeenCalledTimes(1);
    expect(q("price-detail-error")!.textContent).toContain("保存できませんでした");
    expect(q("price-detail")).not.toBeNull();
  });

  it("確認から30日を超えた販売中の記録は参考価格。更新（最終確認日の更新）で参考価格から外れる", async () => {
    const old = row({ id: "o", surveyedOn: "2026-09-01" });
    await mount([old]);
    expect(q("price-row")!.getAttribute("data-ref")).toBe("true");
    await mount([old], [{ recordKey: "market:o", event: "confirmed", happenedOn: "2026-11-22", createdAt: "2026-11-22T00:00:00Z" }]);
    expect(q("price-row")!.getAttribute("data-ref")).toBe("false");
  });

  it("比較表の行は共通部品: 1行目=系列・店舗（同じ行）｜状態ランク・価格、2行目=日付（「調査」なし）。本日の調査結果の比較表と同じ枠（COMPARE_ROW_CLASS）", async () => {
    await mount([row({ id: "x", surveyedOn: "2026-11-05" })]);
    const r = q("price-row")!;
    for (const c of COMPARE_ROW_CLASS.split(" ")) expect(r.className.split(" ")).toContain(c);
    const store = q("store-identity")!;
    expect(store.querySelector('[data-testid="store-chain"] > span:last-child')!.textContent).toBe("トレカキャピタル");
    expect(store.textContent).toContain("垂水店");
    expect(store.className).toContain("flex"); // ロゴ・系列名・店舗名は同じ行
    const date = q("price-date")!;
    expect(date.textContent).not.toContain("調査");
    expect(date.compareDocumentPosition(store) & Node.DOCUMENT_POSITION_PRECEDING).toBeTruthy(); // 日付は店舗の下（後ろ）
    expect(r.querySelector('[data-testid="price-rank-label"]')).not.toBeNull();
    expect(qa("price-group-head")).toHaveLength(0); // カードの種類が1つなら見出しなし
  });

  it("151図鑑: 同じポケモンの別カード（セット・番号・レア違い）は別の販売情報（同じ店舗・状態でも1件にまとめない）。「カード情報を編集」の独立ボタンは無く、編集に統合されている", async () => {
    const onEdit = vi.fn();
    await mount([row({ id: "x", cardKey: "id:sv8|100/106|sar", cardLabel: "100/106 ・ SAR" }), row({ id: "y", cardKey: "id:sv8|101/106|sar", cardLabel: "101/106 ・ SAR" })], [], { onEdit });
    expect(qa("price-row")).toHaveLength(2);
    // 種類ごとに比較表（見出し＋行）を分ける。各行には番号・レアを出さない
    expect(qa("price-group")).toHaveLength(2);
    expect(qa("price-group-head").map((e) => e.textContent)).toEqual(["100/106 ・ SAR", "101/106 ・ SAR"]);
    qa("price-row").forEach((r) => expect(r.textContent).not.toMatch(/SAR|100\/106/));
    await click(qa("price-row")[0]);
    expect(q("price-edit-card")).toBeNull();
    await click(q("price-edit"));
    expect(onEdit).toHaveBeenCalledTimes(1);
  });

  it("詳細の操作ボタンの配置: 右側=編集・更新・完売（頻繁に使う）／左側=この価格で購入・削除", async () => {
    await mount([row({ id: "a" })], [], { onConfirm: vi.fn(async () => null), onSoldOut: vi.fn(async () => null) });
    await click(q("price-row"));
    const left = q("price-actions-left")!;
    const right = q("price-actions-right")!;
    expect([...left.querySelectorAll("button")].map((b) => b.textContent)).toEqual(["この価格で購入", "削除"]);
    expect([...right.querySelectorAll("button")].map((b) => b.textContent)).toEqual(["編集", "更新", "完売"]);
    expect(left.nextElementSibling).toBe(right); // 右側のグループが後ろ（画面の右）
  });
});
