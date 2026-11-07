import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/app/(app)/collection/actions", () => ({ addHoldingAction: async () => ({ ok: true }), saveCardAction: async () => ({ ok: true }), updateCardAction: async () => ({ ok: true }) }));
vi.mock("@/components/app-provider", () => ({ useApp: () => ({ data: { products: [] } }) }));
vi.mock("@/lib/client-image", () => ({
  shrinkToJpeg: async (f: File) => f,
  sha256Hex: async () => "hash",
}));

import { CardFormDialog } from "@/components/card-form";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root | null = null;
let host: HTMLDivElement;
const fetchMock = vi.fn(async (..._a: unknown[]) => ({ json: async () => ({ ok: true, extraction: { name: "AIが読んだ名前", cardNumber: "999/999", setCode: "ZZ", rarity: "SAR", cardType: "", productName: "", issues: [] }, runId: "r1" }) }) as unknown as Response);
beforeEach(() => {
  fetchMock.mockClear();
  vi.stubGlobal("fetch", fetchMock);
  host = document.createElement("div");
  document.body.appendChild(host);
});
afterEach(() => {
  act(() => root?.unmount());
  root = null;
  host.remove();
  document.body.innerHTML = "";
  vi.unstubAllGlobals();
});
const flush = () => act(async () => { for (let i = 0; i < 5; i++) await Promise.resolve(); });
const card = { id: "c1", name: "既存のカード", cardNumber: "001/100", setCode: "SV1", rarity: "RR", cardType: "ポケモン", productName: "既存パック", thumbPath: null, quantity: 1 } as never;
const pickFile = async () => {
  const input = document.body.querySelector('[data-testid="card-file"]') as HTMLInputElement;
  const file = new File([new Uint8Array([1, 2, 3])], "x.jpg", { type: "image/jpeg" });
  Object.defineProperty(input, "files", { value: [file], configurable: true });
  await act(async () => void input.dispatchEvent(new Event("change", { bubbles: true })));
  await flush();
};
const val = (label: string) => (document.body.querySelector(`[aria-label="${label}"]`) as HTMLInputElement).value;

describe("Stage 6P: 画像の変更とAI読み取りの分離", () => {
  it("登録済みカードの画像を変えても、AI（/api/card-extract）は呼ばず、カード情報は変わらない", async () => {
    root = createRoot(host);
    await act(async () => root!.render(createElement(CardFormDialog, { open: true, onOpenChange: () => undefined, mode: { kind: "edit", card }, cards: [], actor: "p", onSaved: () => undefined })));
    await pickFile();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(document.body.querySelector('[data-testid="card-ai-running"]')).toBeNull();
    expect(val("カード名")).toBe("既存のカード");
    expect(val("カード番号")).toBe("001/100");
    expect(val("レアリティ")).toBe("RR");
    expect(val("収録パック")).toBe("既存パック");
    expect(document.body.querySelector('[data-testid="card-ai-toggle"]')).toBeNull(); // 編集ではAIの切替自体を出さない
    expect(document.body.querySelector('[data-testid="card-preview"] img')).not.toBeNull(); // 画像は差し替わる
  });
  it("新規登録では従来どおり、画像を選ぶとAIが読み取る", async () => {
    root = createRoot(host);
    await act(async () => root!.render(createElement(CardFormDialog, { open: true, onOpenChange: () => undefined, mode: { kind: "new" }, cards: [], actor: "p", onSaved: () => undefined })));
    await pickFile();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0][0])).toBe("/api/card-extract");
    expect(val("カード名")).toBe("AIが読んだ名前");
  });
});
