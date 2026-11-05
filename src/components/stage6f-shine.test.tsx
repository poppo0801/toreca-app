import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it } from "vitest";
import { shineTier } from "@/lib/collection";
import { ShineButton } from "@/components/shine";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe("Stage 6F-6: レアリティ別の光沢", () => {
  it("強さはレアリティで決まる", () => {
    expect(shineTier("SAR")).toBe(3);
    expect(shineTier("ur")).toBe(3);
    expect(shineTier("SR")).toBe(2);
    expect(shineTier("AR")).toBe(1);
    expect(shineTier("C")).toBe(0);
    expect(shineTier("")).toBe(0);
  });
  const mount = (rarity: string, enabled: boolean) => {
    const host = document.createElement("div");
    document.body.appendChild(host);
    const root = createRoot(host);
    act(() => root.render(createElement(ShineButton, { rarity, enabled, "aria-label": "t" }, "x")));
    return { el: host.querySelector("button") as HTMLButtonElement, done: () => (act(() => root.unmount()), host.remove()) };
  };
  it("演出ONの高レアだけに光沢クラスと強さが付き、OFF・低レアには付かない", () => {
    const a = mount("SAR", true);
    expect(a.el.classList.contains("card-shine")).toBe(true);
    expect(a.el.getAttribute("data-tier")).toBe("3");
    a.done();
    const b = mount("SAR", false);
    expect(b.el.classList.contains("card-shine")).toBe(false);
    b.done();
    const c = mount("C", true);
    expect(c.el.classList.contains("card-shine")).toBe(false);
    expect(c.el.hasAttribute("data-tier")).toBe(false);
    c.done();
  });
  it("触れた位置に光が追従し、離すと戻る（変形はしない）", async () => {
    const a = mount("SR", true);
    a.el.getBoundingClientRect = () => ({ left: 0, top: 0, width: 100, height: 140, right: 100, bottom: 140, x: 0, y: 0, toJSON: () => ({}) });
    await act(async () => {
      a.el.dispatchEvent(new PointerEvent("pointermove", { clientX: 50, clientY: 70, bubbles: true }));
      await new Promise((r) => requestAnimationFrame(() => r(null)));
    });
    expect(a.el.style.getPropertyValue("--mx")).toBe("50.0%");
    expect(a.el.dataset.touch).toBe("1");
    expect(a.el.style.transform).toBe("");
    await act(async () => void a.el.dispatchEvent(new PointerEvent("pointerup", { bubbles: true })));
    expect(a.el.dataset.touch).toBeUndefined();
    a.done();
  });
});
