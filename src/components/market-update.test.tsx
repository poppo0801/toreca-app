import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const update = vi.fn();
const link = vi.fn();
vi.mock("@/app/(app)/collection/market-actions", () => ({ updateMarketPricesAction: (o: unknown) => update(o), setMarketLinkAction: (a: string, b: string) => link(a, b) }));

import { MarketUpdateDialog } from "@/components/market-update";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let host: HTMLDivElement;
const result = (over = {}) => ({ ok: true, result: { summary: { total: 3, updated: 1, unlisted: 1, ambiguous: 1, insufficient: 0, noPrice: 0 }, priceRows: 2, csvRows: 2788, csvUpdatedAt: "2026-11-04T21:09:00.000Z", fetchedAt: "2026-11-05T01:00:00.000Z", ambiguous: [{ cardId: "c3", name: "アローラナッシー", reason: "同じ番号に複数の候補があります", variants: [{ key: "AR|a", name: "アローラナッシー", rarity: "AR" }, { key: "AR|b", name: "アローラナッシー(30th)", rarity: "AR" }] }], source: "download", ...over } });
const q = (s: string) => document.body.querySelector(s) as HTMLElement | null;
const click = async (el: Element | null) => {
  await act(async () => (el as HTMLElement).click());
};
beforeEach(() => {
  update.mockReset();
  link.mockReset();
  host = document.createElement("div");
  document.body.appendChild(host);
});
afterEach(() => {
  act(() => root?.unmount());
  root = null;
  host.remove();
});
const render = async (cardCount = 3) => {
  root = createRoot(host);
  await act(async () => root!.render(createElement(MarketUpdateDialog, { open: true, onOpenChange: () => undefined, cardCount, market: [], onDone: () => undefined })));
};

describe("Stage 6G: 相場を一括更新（画面）", () => {
  it("更新すると、更新・未掲載・照合未確定の件数と出典を表示する", async () => {
    update.mockResolvedValue(result());
    await render();
    expect(q('[data-testid="market-meta"]')?.textContent).toContain("対象 3枚");
    await click(q('[data-testid="market-run"]'));
    expect(update).toHaveBeenCalledWith({});
    const t = q('[data-testid="market-result"]')?.textContent ?? "";
    expect(t).toContain("更新 1");
    expect(t).toContain("未掲載 1");
    expect(t).toContain("照合未確定 1");
    expect(document.body.textContent).toContain("実際の取引価格や査定額を保証しません");
    expect(document.body.querySelector('a[href="https://card.pricebest.jp/data/"]')).not.toBeNull();
  });
  it("失敗したら成功と表示せず、エラーを出す", async () => {
    update.mockResolvedValue({ ok: false, error: "相場データを取得できませんでした（通信エラー）。既存の価格は変更していません" });
    await render();
    await click(q('[data-testid="market-run"]'));
    expect(q('[data-testid="market-error"]')?.textContent).toContain("既存の価格は変更していません");
    expect(q('[data-testid="market-result"]')).toBeNull();
  });
  it("照合未確定のカードは、候補から選ぶと対応を保存してそのカードだけ更新する", async () => {
    update.mockResolvedValue(result());
    link.mockResolvedValue({ ok: true });
    await render();
    await click(q('[data-testid="market-run"]'));
    update.mockResolvedValue(result({ ambiguous: [], summary: { total: 1, updated: 1, unlisted: 0, ambiguous: 0, insufficient: 0, noPrice: 0 } }));
    const btn = [...document.body.querySelectorAll('[data-testid="market-ambiguous"] button')].find((b) => b.textContent?.includes("30th"));
    await click(btn ?? null);
    expect(link).toHaveBeenCalledWith("c3", "AR|b");
    expect(update).toHaveBeenLastCalledWith({ cardId: "c3" });
    expect(q('[data-testid="market-ambiguous"]')).toBeNull();
  });
  it("カードが無いときは更新できない", async () => {
    await render(0);
    expect((q('[data-testid="market-run"]') as HTMLButtonElement).disabled).toBe(true);
  });
});
