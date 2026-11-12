// @vitest-environment node
import { readdirSync, readFileSync, statSync } from "node:fs";
import { describe, expect, it } from "vitest";

/** E2E のサーバーに、実API評価用の設定（AGENT_*）を渡さない（キーの有無でテスト結果が変わらない。Stage 8D-5） */
const walk = (d: string): string[] => readdirSync(d).flatMap((f) => { const p = `${d}/${f}`; return statSync(p).isDirectory() ? walk(p) : /\.(ts|tsx)$/.test(p) && !/\.test\./.test(p) ? [p] : []; });
describe("E2Eの環境分離", () => {
  it("アプリが読む AGENT_* の環境変数は、すべて E2E では空文字に上書きされる（runner と playwright.config）", () => {
    const names = new Set(walk("src").flatMap((p) => readFileSync(p, "utf8").match(/AGENT_[A-Z_]+/g) ?? []));
    expect(names.size).toBeGreaterThan(0);
    const cfg = readFileSync("playwright.config.ts", "utf8");
    const isolated = readFileSync("scripts/lib/e2e-env.mjs", "utf8");
    for (const n of names) {
      expect(isolated, `scripts/lib/e2e-env.mjs に ${n} が無い`).toContain(`${n}: ""`);
      expect(cfg, `playwright.config に ${n} が無い`).toContain(`${n}: ""`);
    }
    for (const f of ["scripts/run-e2e-supabase.mjs", "scripts/run-e2e-mock.mjs"]) expect(readFileSync(f, "utf8")).toContain("ISOLATED_AGENT_ENV");
  });
});
