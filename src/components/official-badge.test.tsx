import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { OfficialBadge } from "@/components/official-badge";
import { deriveOfficialBadge } from "@/lib/judgment/xsource/badge";

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

const NOW = new Date("2099-11-21T00:00:00Z");
const src = { sourceId: "s", host: "shop.example.com", publisherBasis: [{ code: "reciprocal_link" as const, checkedAt: "2099-11-10T00:00:00Z" }], announcementConfirmed: true, announcementCheckedAt: "2099-11-20T00:00:00Z" };

describe("公式バッジ: 確認できたときだけ表示し、未確認なら何も出さない（否定的なラベルは無い）", () => {
  it("未指定・null・未確認のとき、何も表示しない", () => {
    for (const badge of [undefined, null, deriveOfficialBadge([], NOW), deriveOfficialBadge([{ ...src, publisherBasis: [] }], NOW)]) {
      act(() => root.render(createElement(OfficialBadge, { badge })));
      expect(host.innerHTML).toBe("");
    }
  });
  it("確認済みなら小さな「公式」だけを表示し、タップで根拠と最終確認日時を表示する。意味の限定（正確性を保証しない）を明記", () => {
    act(() => root.render(createElement(OfficialBadge, { badge: deriveOfficialBadge([src], NOW) })));
    expect(host.textContent).toBe("公式");
    act(() => host.querySelector("button")!.dispatchEvent(new MouseEvent("click", { bubbles: true })));
    const t = host.textContent ?? "";
    expect(t).toContain("公式サイトと発信元の相互リンク");
    expect(t).toContain("最終確認 2099-11-20 00:00");
    expect(t).toContain("保証するものではありません");
    expect(t).not.toMatch(/非公式|偽/);
  });
});
