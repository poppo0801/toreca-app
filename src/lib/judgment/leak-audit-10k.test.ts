// @vitest-environment node
/**
 * Stage 10K: 漏洩検出の原因分類（実データの監査。AIには何も送らない）。保存原文（ローカル）と、保存リンクの公開ページ（取得は既存の部品・robots尊重・最大15ページ）を、
 * 旧規則（厳格）と新規則で検出し、**検出の種類ごとの件数だけ**を出す（原文・URL・抜粋は出力しない）。実行: JUDGMENT_LEAK_AUDIT=1 npx vitest run src/lib/judgment/leak-audit-10k.test.ts
 */
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { extractPageText } from "@/lib/ai/page-text";
import { redact } from "@/lib/case-model/redact";
import { fetchRespectingRobots } from "@/lib/server/safe-fetch";
import { detectLeaks, detectLeaksStrict } from "./eval/phase2";
import { precheckFetchTarget } from "./fetch-safety";

const by = (xs: string[]): Record<string, number> => xs.reduce<Record<string, number>>((m, k) => ((m[k] = (m[k] ?? 0) + 1), m), {});
const isX = (h: string): boolean => /(^|[.])(t[.]co|x[.]com|twitter[.]com)$/.test(h.toLowerCase());

describe.skipIf(process.env.JUDGMENT_LEAK_AUDIT !== "1")("漏洩検出の監査（件数のみ）", () => {
  it("保存原文と公開ページで、旧規則・新規則の検出を種類別に集計する", async () => {
    const dir = "backups/refresh-10g";
    const f = readdirSync(dir).filter((x) => x.startsWith("evidence-")).sort().at(-1);
    const rows = (JSON.parse(readFileSync(`${dir}/${f}`, "utf8")) as { rows: { text: string; links?: string[] }[] }).rows;
    const stored = rows.map((r) => redact(r.text));
    const sum = (texts: string[]) => ({
      pages: texts.length,
      strictBlocked: texts.filter((t) => detectLeaksStrict(t).length).length,
      newBlocked: texts.filter((t) => detectLeaks(t).length).length,
      strictKinds: by(texts.flatMap((t) => [...new Set(detectLeaksStrict(t).map((x) => x.kind))])),
      newKinds: by(texts.flatMap((t) => [...new Set(detectLeaks(t).map((x) => x.kind))])),
    });
    const urls = [...new Set(rows.flatMap((r) => r.links ?? []))].filter((u) => { const p = precheckFetchTarget(u); return p.ok && p.url.protocol === "https:" && !isX(p.url.hostname); });
    const pages: string[] = [];
    let ok = 0;
    let fail = 0;
    for (const u of urls.slice(0, 15)) {
      const r = await fetchRespectingRobots(u, { timeoutMs: 10_000, maxBytes: 1_000_000, accept: ["text/html", "application/xhtml+xml"] });
      if (!r.ok) { fail++; continue; }
      ok++;
      const p = extractPageText(r.body, r.finalUrl, 6_000, 20);
      pages.push(redact(`${p.title}\n${p.text}`));
    }
    const out = { storedEvidence: sum(stored), linkedPages: { candidates: urls.length, fetched: ok, failed: fail, ...sum(pages) } };
    writeFileSync("eval/real-data/leak-audit-10k.json", JSON.stringify(out, null, 1));
    console.log(JSON.stringify(out));
    expect(out.linkedPages.pages).toBe(ok);
  }, 600_000);
});
