// @vitest-environment jsdom
/** 系列・店舗の表示（相場比較表・価格一覧で共通）: 系列名（ロゴ付き・店舗名より太い）→店舗名。ロゴが無いときは頭文字のタイル。 */
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/components/app-provider", () => ({ useApp: () => ({ data: { chains: [{ id: "c1", name: "トレカキャピタル", aliases: ["TCC"], logoSrc: "/api/chain-logo/c1?v=abc" }, { id: "c2", name: "ロゴ無し系列", logoSrc: null }] } }) }));
import { StoreIdentity } from "@/components/store-identity";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root;
let host: HTMLDivElement;
beforeEach(() => {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
});
const render = (chainName: string, storeName: string) => act(async () => root.render(createElement(StoreIdentity, { chainName, storeName })));

describe("StoreIdentity", () => {
  it("ロゴのある系列: 系列名の左に小さなロゴ。系列名は店舗名より太い。別表記（TCC）でもロゴが出る", async () => {
    await render("トレカキャピタル", "垂水店");
    expect(host.querySelector('[data-testid="chain-logo"]')!.getAttribute("src")).toBe("/api/chain-logo/c1?v=abc");
    const chain = host.querySelector('[data-testid="store-chain"] span.font-bold')!;
    expect(chain.textContent).toBe("トレカキャピタル");
    expect(host.querySelector('[data-testid="store-identity"]')!.lastElementChild!.className).toContain("font-normal");
    await render("TCC", "垂水店");
    expect(host.querySelector('[data-testid="chain-logo"]')).not.toBeNull();
  });
  it("ロゴの無い系列・未登録の系列: 頭文字の小さなタイルで代替（ロゴが無くても列がずれない）。系列が空なら店舗名だけ", async () => {
    await render("ロゴ無し系列", "本店");
    expect(host.querySelector('[data-testid="chain-logo"]')).toBeNull();
    expect(host.querySelector('[data-testid="chain-fallback"]')!.textContent).toBe("ロ");
    await render("", "単独の店");
    expect(host.querySelector('[data-testid="store-chain"]')).toBeNull();
    expect(host.textContent).toBe("単独の店");
  });
  it("店舗名が「系列名＋店舗名」のときは系列名を重ねて出さない", async () => {
    await render("トレカキャピタル", "トレカキャピタル垂水店");
    expect(host.querySelector('[data-testid="store-identity"]')!.lastElementChild!.textContent).toBe("垂水店");
  });
});
