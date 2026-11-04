import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createMockData } from "@/data/mock";
import type { MemoRow } from "@/lib/collector/memos";

const NOW = new Date("2026-11-04T03:00:00Z");
const data = createMockData(NOW);
const create = vi.fn(async (..._a: unknown[]) => ({ ok: true as const }));
const recheck = vi.fn(async (..._a: unknown[]) => ({ ok: true as const }));
const withdraw = vi.fn(async (..._a: unknown[]) => ({ ok: true as const }));
let memos: MemoRow[] = [];
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: () => {} }) }));
vi.mock("@/components/app-provider", () => ({ useApp: () => ({ data, now: NOW, profile: data.profiles[0] }) }));
vi.mock("@/app/(app)/lotteries/memo-actions", () => ({
  createMemoAction: (...a: unknown[]) => create(...a),
  recheckMemoAction: (...a: unknown[]) => recheck(...a),
  setMemoStateAction: (...a: unknown[]) => withdraw(...a),
  listMemosAction: async () => memos,
}));

import { MemoFormDialog, MemoListDialog } from "@/components/collection-memos";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root;
let host: HTMLDivElement;
const flush = () => act(async () => { await Promise.resolve(); await Promise.resolve(); });
const q = (id: string) => document.querySelector<HTMLElement>(`[data-testid="${id}"]`);
const row = (o: Partial<MemoRow> = {}): MemoRow => ({ id: "m1", chainId: data.chains[0].id, chainName: "", storeId: null, storeName: "", productIds: [data.products[0].id], productNames: [], referenceUrl: "https://example.invalid/x", note: "", announcedStart: null, priority: "high", state: "surveying", stateDetail: "既存の収集元には該当する告知がまだありません", fetchState: "ok", checkCount: 1, lastCheckedAt: "2026-11-04T01:00:00Z", lastContentHash: null, foundCandidateId: null, lotteryId: null, createdAt: "2026-11-03T00:00:00Z", ...o });

beforeEach(() => {
  create.mockClear();
  recheck.mockClear();
  withdraw.mockClear();
  memos = [];
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  document.body.innerHTML = "";
});

describe("優先収集メモのUI", () => {
  it("メモの登録画面から、メモ一覧へ移動できる", () => {
    const calls: string[] = [];
    act(() => root.render(createElement(MemoFormDialog, { open: true, onOpenChange: () => {}, onList: () => calls.push("list") })));
    act(() => q("open-memo-list")!.click());
    expect(calls).toEqual(["list"]);
  });

  it("系列＋商品だけで保存できる（検証はサーバー側）", async () => {
    act(() => root.render(createElement(MemoFormDialog, { open: true, onOpenChange: () => {} })));
    const sel = q("memo-chain") as HTMLSelectElement;
    await act(async () => {
      sel.value = data.chains[0].id;
      sel.dispatchEvent(new Event("change", { bubbles: true }));
    });
    const box = q("memo-products")!.querySelector<HTMLInputElement>('input[type="checkbox"]')!;
    await act(async () => box.click());
    await act(async () => q("memo-save")!.click());
    await flush();
    expect(create).toHaveBeenCalledTimes(1);
    const arg = create.mock.calls[0][0] as { chainId: string; productIds: string[]; priority: string };
    expect(arg.chainId).toBe(data.chains[0].id);
    expect(arg.productIds).toHaveLength(1);
    expect(arg.priority).toBe("normal");
    expect(create.mock.calls[0][1]).toBe(data.profiles[0].id);
  });

  it("一覧に系列・商品・参考URLの有無・調査状態・最終確認日時を出し、再調査と取り下げができる", async () => {
    memos = [row(), row({ id: "m2", state: "registered", lotteryId: "l1", priority: "normal" })];
    await act(async () => root.render(createElement(MemoListDialog, { open: true, onOpenChange: () => {} })));
    await flush();
    const rows = [...document.querySelectorAll('[data-testid="memo-row"]')];
    expect(rows).toHaveLength(2);
    expect(rows[0].textContent).toContain("調査中");
    expect(rows[0].textContent).toContain(data.chains[0].name);
    expect(rows[0].textContent).toContain(data.products[0].officialName);
    expect(rows[0].textContent).toContain("参考URLあり");
    expect(rows[0].textContent).toContain("最終確認");
    expect(rows[1].textContent).toContain("登録済み");
    expect(rows[1].querySelector('[data-testid="memo-recheck"]')).toBeNull(); // 終了した状態は再調査できない（履歴）
    await act(async () => rows[0].querySelector<HTMLElement>('[data-testid="memo-recheck"]')!.click());
    expect(recheck).toHaveBeenCalledWith("m1");
    await act(async () => rows[0].querySelector<HTMLElement>('[data-testid="memo-withdraw"]')!.click());
    expect(withdraw).toHaveBeenCalledWith("m1", "withdrawn");
  });
});
