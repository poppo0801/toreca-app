import { describe, expect, it } from "vitest";
import { isStoreResearchEnabled } from "@/lib/agent/dev-flag";
import { SafePageFetcher } from "@/lib/server/agent/real-providers";

describe("ページ取得の安全性（実ネットワークには出ない。検査で拒否される）", () => {
  it.each([
    "http://127.0.0.1:55321/rest/v1/stores",
    "http://localhost:3000/api/health",
    "http://169.254.169.254/latest/meta-data/",
    "http://10.0.0.5/admin",
    "http://192.168.1.1/",
    "http://[::1]/",
    "file:///etc/passwd",
    "ftp://example.test/x",
    "javascript:alert(1)",
    "https://user:pass@example.test/",
  ])("%s は取得を拒否する", async (url) => {
    const r = await new SafePageFetcher().fetchPage(url);
    expect(r.ok).toBe(false);
  });
});

describe("調査画面・調査アクションは開発環境だけ（本番では無効）", () => {
  it("next dev または TOREMANE_ENV=local のときだけ有効。本番（Vercel）の環境では無効", () => {
    expect(isStoreResearchEnabled({ NODE_ENV: "development" })).toBe(true);
    expect(isStoreResearchEnabled({ NODE_ENV: "production", TOREMANE_ENV: "local" })).toBe(true);
    expect(isStoreResearchEnabled({ NODE_ENV: "production" })).toBe(false);
    expect(isStoreResearchEnabled({ NODE_ENV: "production", VERCEL: "1" })).toBe(false);
    expect(isStoreResearchEnabled({})).toBe(false);
  });
});
