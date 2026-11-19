// @vitest-environment node
import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { isReevalAiEnabled, runReevalAi, UNIT_COST_JPY } from "./reeval-ai-hook";
import { prodReevalDeps } from "@/lib/server/agent/reeval-ai-service";
import type { Db } from "@/lib/server/lottery-service";

/** 一括再評価のAI再調査の関門（Stage 9H-3S-3）: 本番では明示的な許可（REEVAL_AI=on）が無ければ動かず、上限・キーが無ければ開始しない */
describe("AI再調査の関門", () => {
  afterEach(() => vi.unstubAllEnvs());
  it("本番（TOREMANE_ENV 未設定）で REEVAL_AI=on が無ければ無効。開発環境（local）か、REEVAL_AI=on のときだけ有効", () => {
    expect(isReevalAiEnabled({})).toBe(false);
    expect(isReevalAiEnabled({ NODE_ENV: "production", ANTHROPIC_API_KEY: "k" })).toBe(false);
    expect(isReevalAiEnabled({ AUTONOMOUS_COLLECTION: "on" })).toBe(false); // 自律型収集の許可とは別（再評価のAIは別に許可する）
    expect(isReevalAiEnabled({ REEVAL_AI: "on" })).toBe(true);
    expect(isReevalAiEnabled({ TOREMANE_ENV: "local" })).toBe(true);
  });
  it("無効な環境では、DBにも触れずAIの部品も読み込まずに拒否する", async () => {
    vi.stubEnv("TOREMANE_ENV", "");
    vi.stubEnv("REEVAL_AI", "");
    const db = new Proxy({}, { get: () => { throw new Error("DBに触れてはいけない"); } }) as unknown as Db;
    const r = await runReevalAi(db, "h", null, "b", { totalCapJpy: 50, limit: 5 });
    expect(r.ok).toBe(false);
  });
  it("本番の接続: 許可・キー・上限が揃わなければ接続しない。上限は環境の最大（既定100円）を超えて指定できない", () => {
    const base = { REEVAL_AI: "on", ANTHROPIC_API_KEY: "sk-test" };
    expect(prodReevalDeps({ env: {}, capJpy: 50 }).ok).toBe(false);
    expect(prodReevalDeps({ env: { REEVAL_AI: "on" }, capJpy: 50 }).ok).toBe(false); // キーなし
    expect(prodReevalDeps({ env: base, capJpy: 0 }).ok).toBe(false);
    expect(prodReevalDeps({ env: base, capJpy: 101 }).ok).toBe(false);
    expect(prodReevalDeps({ env: { ...base, REEVAL_AI_MAX_JPY: "200" }, capJpy: 150, clientFactory: () => ({ messages: {} }) as never }).ok).toBe(true);
    const ok = prodReevalDeps({ env: base, capJpy: 50, clientFactory: () => ({ messages: {} }) as never });
    expect(ok.ok).toBe(true);
    if (ok.ok) {
      expect(ok.deps.capJpy).toBe(50);
      expect(ok.deps.spentJpy()).toBe(0);
    }
  });
  it("費用の目安は、単位ごとに最小≦最大", () => {
    for (const v of Object.values(UNIT_COST_JPY)) expect(v.min).toBeLessThanOrEqual(v.max);
  });
  it("AIの部品（lib/agent・lib/server/agent）は、関門のあとに動的に読み込む（静的な読み込みは無い）", () => {
    const src = readFileSync("src/lib/server/master-identity/reeval-ai-hook.ts", "utf8");
    expect(src).not.toMatch(/^import .* from "@\/lib\/(server\/)?agent\//m);
    expect(src.indexOf("isReevalAiEnabled()")).toBeLessThan(src.indexOf("await import("));
  });
});
