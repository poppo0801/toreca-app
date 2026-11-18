/**
 * Stage 9E: 評価の入力にする実在の公開ページの取得（無料・robots.txt尊重・1.5秒間隔・少数）。通常のテストには含めない。
 *   CAPTURE_9E=1 npx vitest run src/lib/agent/collection-planner/capture-9e.live.test.ts
 * 取得した本文は eval/investigation-9e/pages-live.json に保存する（再現性のため。以後の評価は保存分を使う）。正解はここでは作らない。
 */
import { readFileSync, writeFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { extractPageText } from "@/lib/ai/page-text";
import { fetchRespectingRobots } from "@/lib/server/safe-fetch";

describe.skipIf(process.env.CAPTURE_9E !== "1")("9E capture", () => {
  it("実在のページを取得して保存する", async () => {
    const urls = (JSON.parse(readFileSync(process.env.CAPTURE_LIST ?? "eval/investigation-9e/capture-urls.json", "utf8")) as { urls: string[] }).urls;
    const pages: Record<string, unknown>[] = [];
    const failed: { url: string; reason: string }[] = [];
    for (const url of urls) {
      await new Promise((r) => setTimeout(r, 1500));
      const r = await fetchRespectingRobots(url, { timeoutMs: 10_000, maxBytes: 1_000_000, accept: ["text/html", "application/xhtml+xml"] });
      if (!r.ok) {
        failed.push({ url, reason: r.code });
        continue;
      }
      const p = extractPageText(r.body, r.finalUrl, 20_000, 200);
      pages.push({ url, finalUrl: r.finalUrl, title: p.title, text: p.text, links: p.links.map((l) => ({ url: l.href, text: l.text })), fetchedAt: new Date().toISOString() });
    }
    writeFileSync(process.env.CAPTURE_OUT ?? "eval/investigation-9e/pages-live.json", JSON.stringify({ version: 1, capturedAt: new Date().toISOString(), pages, failed }, null, 1));
    console.log(JSON.stringify({ ok: pages.length, failed }, null, 1));
    expect(pages.length).toBeGreaterThan(0);
  }, 120_000);
});
