import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SourceLinkList } from "./source-link-list";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe("SourceLinkList（9H-3L）", () => {
  let host: HTMLDivElement;
  let root: Root;
  beforeEach(() => {
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
  });
  afterEach(() => {
    act(() => root.unmount());
    host.remove();
  });

  it("種類｜ドメインの外部リンク（別タブ・noopener・青文字の下線）として描画する", () => {
    act(() => root.render(createElement(SourceLinkList, { lottery: { sourceUrls: ["https://livepocket.jp/e/abc"], announcementUrl: "https://x.example.test/r" } })));
    const links = [...host.querySelectorAll<HTMLAnchorElement>('[data-testid="primary-link"]')];
    expect(links.map((a) => a.textContent)).toEqual(["当落発表｜x.example.test", "LivePocket｜livepocket.jp"]);
    for (const a of links) {
      expect(a.target).toBe("_blank");
      expect(a.rel).toContain("noopener");
      expect(a.className).toContain("underline");
      expect(a.className).toContain("text-info");
    }
  });
  it("URLが無い・不正なときは何も描画しない（表示が崩れない）", () => {
    act(() => root.render(createElement(SourceLinkList, { lottery: { sourceUrls: [], announcementUrl: "" } })));
    expect(host.firstChild).toBeNull();
    act(() => root.render(createElement(SourceLinkList, { lottery: { sourceUrls: ["", "foo"] } })));
    expect(host.firstChild).toBeNull();
  });
});
