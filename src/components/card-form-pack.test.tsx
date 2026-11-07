import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/app/(app)/collection/actions", () => ({ addHoldingAction: async () => ({ ok: true }), saveCardAction: async () => ({ ok: true }), updateCardAction: async () => ({ ok: true }) }));
vi.mock("@/components/app-provider", () => ({
  useApp: () => ({
    data: {
      products: [
        { id: "p1", officialName: "ステラミラクル", code: "SV7", archived: false },
        { id: "p2", officialName: "テラスタルフェスex", code: "SV8a", archived: false },
      ],
    },
  }),
}));

import { CardFormDialog } from "@/components/card-form";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root | null = null;
let host: HTMLDivElement;
beforeEach(() => {
  host = document.createElement("div");
  document.body.appendChild(host);
});
afterEach(() => {
  act(() => root?.unmount());
  root = null;
  host.remove();
  document.body.innerHTML = "";
});
const input = (label: string) => document.body.querySelector(`[aria-label="${label}"]`) as HTMLInputElement | HTMLSelectElement;
const change = (el: HTMLElement, value: string) => {
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(el, value);
  act(() => {
    el.dispatchEvent(new Event("input", { bubbles: true }));
  });
};
const mount = () => {
  root = createRoot(host);
  act(() => root!.render(createElement(CardFormDialog, { open: true, onOpenChange: () => undefined, mode: { kind: "new" }, cards: [], actor: "p", onSaved: () => undefined })));
};

describe("Stage 6N: コレクション登録の収録パック・状態", () => {
  it("項目名は「収録パック」。状態の初期値は A", () => {
    mount();
    expect(input("収録パック")).not.toBeNull();
    expect(document.body.textContent).not.toContain("収録商品");
    expect((input("状態") as HTMLSelectElement).value).toBe("A");
  });
  it("商品コードを手入力すると、マスターの商品名が収録パックに入る。候補はマスターの一覧", () => {
    mount();
    change(input("商品コード"), "sv8A");
    expect(input("収録パック").value).toBe("テラスタルフェスex");
    const opts = [...document.body.querySelectorAll("#pack-options option")].map((o) => (o as HTMLOptionElement).value);
    expect(opts).toEqual(["ステラミラクル", "テラスタルフェスex"]);
  });
  it("自由入力もでき、書き換えた後は商品コードを変えても上書きしない。一致しないコードでは変えない", () => {
    mount();
    change(input("商品コード"), "SV7");
    expect(input("収録パック").value).toBe("ステラミラクル");
    change(input("収録パック"), "自分で入力したパック");
    change(input("商品コード"), "SV8a");
    expect(input("収録パック").value).toBe("自分で入力したパック");
    change(input("商品コード"), "ZZ99");
    expect(input("収録パック").value).toBe("自分で入力したパック");
  });
});
