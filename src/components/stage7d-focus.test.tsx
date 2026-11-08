import { act, createElement, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { Sheet, SheetBody, SheetContent, SheetDescription, SheetTitle } from "@/components/ui/sheet";

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
  document.body.innerHTML = "";
});

const isEditable = (el: Element | null) => !!el && /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName);

function Demo({ kind }: { kind: "dialog" | "sheet" }) {
  const [open, setOpen] = useState(false);
  const body = (
    <>
      <input aria-label="名前" />
      <select aria-label="選択">
        <option>a</option>
      </select>
      <textarea aria-label="メモ" />
      <button type="button">決定</button>
    </>
  );
  return (
    <>
      <button type="button" data-testid="opener" onClick={() => setOpen(true)}>
        開く
      </button>
      {kind === "dialog" ? (
        <Dialog open={open} onOpenChange={setOpen}>
          <DialogContent data-testid="panel">
            <DialogTitle>タイトル</DialogTitle>
            <DialogDescription>説明</DialogDescription>
            {body}
          </DialogContent>
        </Dialog>
      ) : (
        <Sheet open={open} onOpenChange={setOpen}>
          <SheetContent data-testid="panel">
            <SheetTitle>タイトル</SheetTitle>
            <SheetDescription>説明</SheetDescription>
            <SheetBody>{body}</SheetBody>
          </SheetContent>
        </Sheet>
      )}
    </>
  );
}

describe("Stage 7D: ダイアログ・ボトムシートを開いても入力欄・選択欄へ自動フォーカスしない", () => {
  for (const kind of ["dialog", "sheet"] as const) {
    it(`${kind}: 開いた直後はフォーカスが入力欄・セレクト・テキストエリアに無く、パネル自身にある。入力欄は明示的に操作すると使える`, async () => {
      act(() => root.render(createElement(Demo, { kind })));
      const opener = document.querySelector<HTMLElement>('[data-testid="opener"]')!;
      opener.focus();
      await act(async () => opener.click());
      await act(async () => void (await new Promise((r) => setTimeout(r, 30))));
      const panel = document.querySelector<HTMLElement>('[data-testid="panel"]')!;
      expect(panel).not.toBeNull();
      expect(isEditable(document.activeElement)).toBe(false);
      expect(panel.contains(document.activeElement)).toBe(true); // フォーカストラップの内側（パネル自身）
      // 利用者が入力欄をタップ（フォーカス）して初めて入力欄が使える
      const input = panel.querySelector<HTMLInputElement>('input[aria-label="名前"]')!;
      act(() => input.focus());
      expect(document.activeElement).toBe(input);
    });
    it(`${kind}: Escで閉じると、開いた操作のボタンへフォーカスが戻る（キーボード操作・アクセシビリティの維持）`, async () => {
      act(() => root.render(createElement(Demo, { kind })));
      const opener = document.querySelector<HTMLElement>('[data-testid="opener"]')!;
      opener.focus();
      await act(async () => opener.click());
      await act(async () => void (await new Promise((r) => setTimeout(r, 30))));
      await act(async () => void document.activeElement?.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
      await act(async () => void (await new Promise((r) => setTimeout(r, 30))));
      expect(document.querySelector('[data-testid="panel"]')).toBeNull();
      expect(document.activeElement).toBe(opener);
    });
  }
  it("ダイアログはキーボードを除いた表示領域（--kb-inset）の中央・範囲に置かれ、本文がスクロールできる", async () => {
    act(() => root.render(createElement(Demo, { kind: "dialog" })));
    await act(async () => document.querySelector<HTMLElement>('[data-testid="opener"]')!.click());
    const el = document.querySelector<HTMLElement>('[data-testid="panel"]')!;
    expect(el.style.top).toContain("--kb-inset");
    expect(el.style.maxHeight).toContain("--kb-inset");
    expect(el.className).toContain("overflow-y-auto");
    expect(el.className).toContain("overscroll-contain");
  });
});
