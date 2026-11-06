import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("next-themes", () => ({ useTheme: () => ({ resolvedTheme: "light" }) }));

import { ThemeColorMeta } from "@/components/theme-color-meta";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const meta = (content: string, media?: string) => {
  const m = document.createElement("meta");
  m.name = "theme-color";
  if (media) m.media = media;
  m.content = content;
  document.head.appendChild(m);
  return m;
};

describe("ステータスバーの色（theme-color）", () => {
  afterEach(() => {
    document.head.querySelectorAll('meta[name="theme-color"]').forEach((m) => m.remove());
  });

  it("アプリのテーマ（ライト=白）に合わせ、画面遷移で Next が書き直しても合わせ直す", async () => {
    const dark = meta("#161619", "(prefers-color-scheme: dark)");
    const host = document.createElement("div");
    document.body.appendChild(host);
    const root = createRoot(host);
    await act(async () => {
      root.render(createElement(ThemeColorMeta));
    });
    expect(dark.content).toBe("#ffffff");
    // 画面遷移: Next が端末の外観の色へ書き直す／新しい meta を足す
    dark.content = "#161619";
    const added = meta("#161619");
    await act(async () => {
      await new Promise((r) => setTimeout(r, 20)); // MutationObserver の通知を待つ
    });
    expect(dark.content).toBe("#ffffff");
    expect(added.content).toBe("#ffffff");
    await act(async () => root.unmount());
    host.remove();
  });
});
