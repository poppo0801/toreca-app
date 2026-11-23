// @vitest-environment jsdom
/**
 * 本日の調査結果（日別）の画面操作（モックのサーバー操作）。購入予定のON/OFF・購入予定ボタンでの表示切替・解除の確認・下部の合計・一括購入・完売の扱い・相場比較表・詳細の編集リンク。
 */
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DailyData } from "@/app/(app)/market-memo/daily-actions";
import type { DailyRecord } from "@/lib/zukan/daily";

const NOW = new Date("2026-11-23T03:00:00Z");
const PID = "00000000-0000-4000-8000-000000000001";
let daily: DailyData = { today: "2026-11-23", day: "2026-11-23", records: [], planned: [] };
const loadDaily = vi.fn(async (_d: string) => ({ ok: true as const, data: daily }));
const setMark = vi.fn(async (..._a: unknown[]) => ({ ok: true as const }));
const bulkBuy = vi.fn(async (..._a: unknown[]): Promise<unknown> => ({ ok: true, result: { purchaseId: "p1", itemCount: 2, totalYen: 3500, replay: false } }));
const loadCompare = vi.fn(async (..._a: unknown[]) => ({ ok: true as const, data: { today: "2026-11-23", records: [] as DailyRecord[] } }));
vi.mock("@/app/(app)/market-memo/daily-actions", () => ({
  loadDailyAction: (d: string) => loadDaily(d),
  setPlanMarkAction: (...a: unknown[]) => setMark(...a),
  bulkBuyAction: (...a: unknown[]) => bulkBuy(...a),
  loadCompareAction: (...a: unknown[]) => loadCompare(...a),
  loadStoreHistoryAction: vi.fn(async () => ({ ok: true, records: [] })),
}));
vi.mock("@/components/app-provider", () => ({ useApp: () => ({ profile: { id: PID, label: "A" }, now: NOW }) }));
vi.mock("next/link", () => ({ default: ({ href, children, ...r }: { href: string; children: React.ReactNode }) => createElement("a", { href, ...r }, children) }));

import { MarketDailyView } from "@/components/market-daily-view";

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
let n = 0;
let mounts = 0;
const rec = (o: Partial<DailyRecord> = {}): DailyRecord => ({ source: "market", id: `00000000-0000-4000-8000-0000000001${String(++n).padStart(2, "0")}`, cardName: "ミロカロス", setName: "SV8", cardNumber: "100/106", rarity: "SAR", chainName: "トレカキャピタル", storeName: "垂水店", condition: "A", priceYen: 11000, note: "", createdAt: `2026-11-23T0${Math.min(n, 9)}:00:00Z`, surveyedOn: "2026-11-23", lastConfirmedOn: "2026-11-23", soldOut: false, purchased: false, ...o });
const mount = async (planned: string[] = []) => {
  daily = { ...daily, planned };
  await act(async () => root.render(createElement(MarketDailyView, { key: `m${++mounts}` }))); // 毎回作り直して読み込み直す
  await flush();
};

beforeEach(() => {
  daily = { today: "2026-11-23", day: "2026-11-23", records: [], planned: [] };
  for (const f of [loadDaily, setMark, bulkBuy, loadCompare]) f.mockClear();
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  document.body.innerHTML = "";
});

describe("本日の調査結果: 操作の領域・購入予定", () => {
  it("行のタップ=購入予定のON/OFF（通常の一覧は即時）。カード名・画像=相場比較表。ⓘ=詳細（編集リンクは記録元ごとに該当の記録を直接開く）", async () => {
    const a = rec();
    const z = rec({ source: "zukan", cardName: "ミロカロス" }); // 同じ内容の別の記録元 → 1行にまとめる
    daily.records = [a, z];
    await mount();
    expect(qa("daily-row")).toHaveLength(1);
    await click(q("daily-toggle"));
    expect(setMark).toHaveBeenCalledTimes(1);
    expect(setMark.mock.calls[0][1]).toEqual([{ source: "market", id: a.id }, { source: "zukan", id: z.id }]); // 両方の記録に同じ状態
    expect(setMark.mock.calls[0][2]).toBe(true);
    expect(q("daily-row")!.getAttribute("data-planned")).toBe("1");
    await click(q("daily-toggle")); // 通常の一覧: 確認なしで解除
    expect(q("unmark-dialog")).toBeNull();
    expect(setMark.mock.calls[1][2]).toBe(false);
    // 相場比較表（カード名・画像の領域）
    await click(q("daily-compare"));
    expect(loadCompare).toHaveBeenCalledWith({ cardName: "ミロカロス", setName: "SV8", cardNumber: "100/106", rarity: "SAR" });
    expect(q("compare-sheet")).not.toBeNull();
    await act(async () => void document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
    await flush();
    // 詳細 → 編集（記録元ごと）
    await click(q("daily-detail"));
    expect((q("daily-edit-market") as HTMLAnchorElement).getAttribute("href")).toBe(`/market-memo?edit=${a.id}`);
    expect((q("daily-edit-zukan") as HTMLAnchorElement).getAttribute("href")).toBe(`/zukan?edit=${z.id}`);
  });

  it("購入予定ボタン: 『購入予定のみ・系列店舗別』へ切り替わる。解除しても表示方式（店舗別）は維持される", async () => {
    daily.records = [rec(), rec({ storeName: "梅田店", chainName: "カードラボ" })];
    await mount();
    expect(q("daily-mode-card")!.getAttribute("aria-checked")).toBe("true");
    await click(q("daily-planned-only"));
    expect(q("daily-planned-only")!.getAttribute("aria-pressed")).toBe("true");
    expect(q("daily-mode-store")!.getAttribute("aria-checked")).toBe("true");
    await click(q("daily-planned-only")); // 解除
    expect(q("daily-planned-only")!.getAttribute("aria-pressed")).toBe("false");
    expect(q("daily-mode-store")!.getAttribute("aria-checked")).toBe("true"); // 店舗別のまま
    await click(q("daily-mode-card")); // 利用者の操作では戻せる
    expect(q("daily-mode-card")!.getAttribute("aria-checked")).toBe("true");
  });

  it("購入予定のみの画面: マーキング済みのカードのタップは、解除の前に確認する（キャンセルなら解除しない）。下部に枚数・合計金額・一括購入が固定表示される", async () => {
    const a = rec({ priceYen: 11000 });
    const b = rec({ storeName: "梅田店", chainName: "カードラボ", priceYen: 2500 });
    const c = rec({ storeName: "対象外", priceYen: 999 });
    daily.records = [a, b, c];
    await mount([`market:${a.id}`, `market:${b.id}`]);
    await click(q("daily-planned-only"));
    expect(qa("daily-row")).toHaveLength(2); // マーク済みだけ
    expect(q("daily-planned-bar-count")!.textContent).toBe("2");
    expect(q("daily-planned-bar-total")!.textContent).toBe("13,500円");
    expect(q("daily-bulk-open")).not.toBeNull();
    const firstPrice = Number(qa("daily-row-price")[0].textContent!.replace(/[^0-9]/g, ""));
    await click(qa("daily-toggle")[0]);
    expect(q("unmark-dialog")).not.toBeNull(); // 確認
    expect(setMark).not.toHaveBeenCalled();
    await act(async () => void document.body.querySelector<HTMLElement>('[data-testid="unmark-dialog"] button')!.click()); // キャンセル（先頭のボタン）
    await flush();
    expect(setMark).not.toHaveBeenCalled();
    await click(qa("daily-toggle")[0]);
    await click(q("unmark-ok"));
    expect(setMark).toHaveBeenCalledTimes(1);
    expect(setMark.mock.calls[0][2]).toBe(false);
    expect(q("daily-planned-bar-total")!.textContent).toBe(`${(13500 - firstPrice).toLocaleString("ja-JP")}円`); // 解除後の合計（表示中の購入予定）
  });

  it("下部の合計は同じ調査記録を二重計上しない。購入予定が無いときは一括購入を押せない（通常の一覧には固定表示しない）", async () => {
    const a = rec({ priceYen: 700 });
    const z = rec({ source: "zukan", priceYen: 700 });
    daily.records = [a, z];
    await mount();
    expect(q("daily-planned-bar")).toBeNull();
    await click(q("daily-planned-only"));
    expect((q("daily-bulk-open") as HTMLButtonElement).disabled).toBe(true);
    await click(q("daily-planned-only"));
    await click(q("daily-toggle"));
    await click(q("daily-planned-only"));
    expect(q("daily-planned-bar-count")!.textContent).toBe("1");
    expect(q("daily-planned-bar-total")!.textContent).toBe("700円");
  });

  it("完売: 購入予定に新規追加できない（サーバー呼び出しなし）。既に購入予定のものは外さず完売を表示。購入済みも追加不可", async () => {
    const sold = rec({ soldOut: true, storeName: "完売店" });
    const bought = rec({ purchased: true, storeName: "購入済店" });
    daily.records = [sold, bought];
    await mount();
    expect(qa("daily-soldout")).toHaveLength(1);
    await click(qa("daily-toggle").find((e) => e.textContent!.includes("完売店"))!);
    expect(setMark).not.toHaveBeenCalled();
    expect(q("daily-error")!.textContent).toContain("完売");
    await click(qa("daily-toggle").find((e) => e.textContent!.includes("購入済店"))!);
    expect(setMark).not.toHaveBeenCalled();
    expect(q("daily-error")!.textContent).toContain("購入済み");
    // 既に購入予定（マーク済み）のものが完売: マークは残り、完売バッジも出る
    await mount([`market:${sold.id}`]);
    const row = qa("daily-row").find((e) => e.textContent!.includes("完売店"))!;
    expect(row.getAttribute("data-planned")).toBe("1");
    expect(row.getAttribute("data-soldout")).toBe("1");
  });

  it("一括購入: 枚数・合計金額・対象店舗を確認し、確定で1回だけ登録（二重タップしても1回）。完売が含まれると確定できない（マークを解除してから）", async () => {
    const a = rec({ priceYen: 1000, storeName: "A店" });
    const b = rec({ priceYen: 2500, storeName: "B店", chainName: "系列B" });
    daily.records = [a, b];
    await mount([`market:${a.id}`, `market:${b.id}`]);
    await click(q("daily-planned-only"));
    await click(q("daily-bulk-open"));
    expect(q("bulk-count")!.textContent).toBe("2枚");
    expect(q("bulk-total")!.textContent).toBe("3,500円");
    expect(q("bulk-stores")!.textContent).toContain("A店");
    expect(q("bulk-stores")!.textContent).toContain("系列B B店");
    expect(q("bulk-blocked")).toBeNull();
    await act(async () => {
      (q("bulk-confirm") as HTMLButtonElement).click();
      (q("bulk-confirm") as HTMLButtonElement).click(); // 二重タップ
    });
    await flush();
    expect(bulkBuy).toHaveBeenCalledTimes(1);
    const [pid, op, rows, date] = bulkBuy.mock.calls[0] as [string, string, { refs: unknown[] }[], string];
    expect(pid).toBe(PID);
    expect(op).toMatch(/^[0-9a-f-]{36}$/);
    expect(rows).toHaveLength(2);
    expect(date).toBe("2026-11-23");
    expect(q("daily-bulk-done")!.textContent).toContain("購入しました");
    expect(q("bulk-dialog")).toBeNull();
    // 完売が含まれる
    const s = rec({ soldOut: true, storeName: "完売店" });
    daily.records = [a, s];
    await mount([`market:${a.id}`, `market:${s.id}`]);
    await click(q("daily-planned-only"));
    await click(q("daily-bulk-open"));
    expect(q("bulk-blocked")!.textContent).toContain("完売");
    expect((q("bulk-confirm") as HTMLButtonElement).disabled).toBe(true);
    bulkBuy.mockClear();
    await click(q("bulk-confirm"));
    expect(bulkBuy).not.toHaveBeenCalled();
  });

  it("一括購入が失敗したときは、エラーを表示し（何も登録されていない旨）、ダイアログを開いたまま。同じ操作IDで再試行できる", async () => {
    const a = rec();
    daily.records = [a];
    await mount([`market:${a.id}`]);
    await click(q("daily-planned-only"));
    await click(q("daily-bulk-open"));
    bulkBuy.mockImplementationOnce(async () => ({ ok: false, error: "購入を完了できませんでした（何も登録されていません）。もう一度お試しください" }));
    await click(q("bulk-confirm"));
    expect(q("bulk-error")!.textContent).toContain("何も登録されていません");
    expect(q("bulk-dialog")).not.toBeNull();
    await click(q("bulk-confirm"));
    expect(bulkBuy).toHaveBeenCalledTimes(2);
    expect(bulkBuy.mock.calls[0][1]).toBe(bulkBuy.mock.calls[1][1]); // 再試行は同じ操作ID（二重購入にならない）
  });
});
