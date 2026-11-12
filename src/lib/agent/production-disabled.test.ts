// @vitest-environment node
import { readdirSync, readFileSync, statSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { canApplyToStoreMaster, isStoreResearchEnabled } from "@/lib/agent/dev-flag";
import { checkRealApi } from "@/lib/agent/real-gate";

/**
 * Stage 8E-1: 住所調査AI（Stage 8D）が本番で有効にならないことの確認。
 * 本番（Vercel）= NODE_ENV=production・TOREMANE_ENV 未設定。開発用の設定（AGENT_*）や本番のAPIキーが混入していても、調査・承認・実APIはすべて拒否される。
 */
const PROD_ENVS: Record<string, string | undefined>[] = [
  { NODE_ENV: "production" },
  { NODE_ENV: "production", ANTHROPIC_API_KEY: "sk-prod-xxxxxxxx" },
  { NODE_ENV: "production", AGENT_REAL_API: "allow", AGENT_ANTHROPIC_API_KEY: "sk-dev-yyyy", AGENT_MAX_COST_JPY_PER_RUN: "15", AGENT_MAX_RUNS_PER_DAY: "60" }, // 開発用の設定が混入した場合
  { NODE_ENV: "production", TOREMANE_ENV: "production", AGENT_REAL_API: "allow", AGENT_ANTHROPIC_API_KEY: "k", AGENT_MAX_COST_JPY_PER_RUN: "15", AGENT_MAX_RUNS_PER_DAY: "60" },
  {}, // 何も設定されていない
];

describe("住所調査AIは本番で有効にならない", () => {
  it("調査画面・調査アクション・承認（店舗マスターへの反映）・実APIは、本番の環境では常に拒否される（開発用のキーや設定が混入していても）", () => {
    for (const env of PROD_ENVS) {
      expect(isStoreResearchEnabled(env), JSON.stringify(Object.keys(env))).toBe(false);
      expect(canApplyToStoreMaster(env)).toBe(false);
      const gate = checkRealApi({ env, confirm: true, runsToday: 0 });
      expect(gate.ok).toBe(false);
    }
  });
  it("開発環境（TOREMANE_ENV=local）でも、既定（AGENT_* なし）では実APIに接続しない。調査画面は開発のみ。承認は local だけ（next dev だけでは不可）", () => {
    expect(checkRealApi({ env: { TOREMANE_ENV: "local" }, confirm: true, runsToday: 0 }).ok).toBe(false);
    expect(isStoreResearchEnabled({ NODE_ENV: "development" })).toBe(true);
    expect(canApplyToStoreMaster({ NODE_ENV: "development" })).toBe(false);
    expect(canApplyToStoreMaster({ TOREMANE_ENV: "local" })).toBe(true);
  });
  it("開発専用キーが本番のキーと同じ値なら拒否する（本番キーの流用を防ぐ）", () => {
    const env = { TOREMANE_ENV: "local", AGENT_REAL_API: "allow", AGENT_ANTHROPIC_API_KEY: "same", ANTHROPIC_API_KEY: "same", AGENT_MAX_COST_JPY_PER_RUN: "15", AGENT_MAX_RUNS_PER_DAY: "60" };
    expect(checkRealApi({ env, confirm: true, runsToday: 0 }).ok).toBe(false);
  });

  const walk = (dir: string): string[] => readdirSync(dir).flatMap((f) => (statSync(`${dir}/${f}`).isDirectory() ? walk(`${dir}/${f}`) : [`${dir}/${f}`]));
  const src = walk("src").filter((f) => /\.(ts|tsx)$/.test(f) && !/\.test\./.test(f));
  it("住所調査AIの部品（lib/agent・lib/server/agent）を読み込むのは、開発専用の画面・アクションだけ。通常の画面・API・自動収集（cron）は読み込まない", () => {
    const users = src.filter((f) => !f.startsWith("src/lib/agent/") && !f.startsWith("src/lib/server/agent/") && /from "@\/lib\/(server\/)?agent\//.test(readFileSync(f, "utf8")));
    expect(users.map((f) => f.replaceAll("\\", "/")).sort()).toEqual([
      "src/app/(app)/settings/store-research/actions.ts",
      "src/app/(app)/settings/store-research/page.tsx",
      "src/app/(app)/settings/store-research/proposal-actions.ts",
      "src/components/store-proposals-view.tsx",
      "src/components/store-research-view.tsx",
    ]);
    for (const f of src.filter((x) => /src\/app\/api\//.test(x.replaceAll("\\", "/")) || /collector/.test(x))) expect(readFileSync(f, "utf8"), f).not.toMatch(/store-location|lib\/agent\/|lib\/server\/agent\//);
  });
  it("開発専用のサーバーアクションは、すべて冒頭で開発環境の判定をする。調査画面は本番で404", () => {
    for (const f of ["src/app/(app)/settings/store-research/actions.ts", "src/app/(app)/settings/store-research/proposal-actions.ts"]) {
      const text = readFileSync(f, "utf8");
      const exported = (text.match(/export async function \w+/g) ?? []).length;
      // 直接判定する形、または共通の guarded()（冒頭で判定してから DB に触れる）経由の形
      const direct = (text.match(/isStoreResearchEnabled\(\)|canApplyToStoreMaster\(\)/g) ?? []).length;
      const viaGuard = /async function guarded<[\s\S]*?canApplyToStoreMaster\(\)/.test(text) ? (text.match(/return guarded\(|await guarded\(/g) ?? []).length : 0;
      expect(exported, f).toBeGreaterThan(0);
      expect(direct + viaGuard, f).toBeGreaterThanOrEqual(exported);
    }
    expect(readFileSync("src/app/(app)/settings/store-research/page.tsx", "utf8")).toMatch(/isStoreResearchEnabled\(\)[\s\S]*notFound\(\)/);
  });
  it("実APIの設定（AGENT_*）を参照するのは、調査の関門・開発用の画面と評価基盤だけ（通常機能は参照しない）", () => {
    const refs = src.filter((f) => /AGENT_(REAL_API|ANTHROPIC_API_KEY)/.test(readFileSync(f, "utf8"))).map((f) => f.replaceAll("\\", "/"));
    for (const f of refs) expect(f.startsWith("src/lib/agent/") || f.includes("store-research") || f.startsWith("src/lib/server/agent/"), f).toBe(true);
  });
});
