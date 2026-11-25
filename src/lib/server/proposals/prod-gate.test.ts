// @vitest-environment node
/** 将来の本番限定プレビューの許可判定（設計）。既定OFF・全条件が揃うときだけ許可・誤起動（ローカル/プレビュー環境）・即時OFF。どこにも接続されていないことの静的確認。 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { proposalPreviewEnabled } from "./flag";
import { productionPreviewPermission, type ProdPreviewInput } from "./prod-gate";

const KEY = "sk-ant-dedicated-proposal-key-0001";
const ok = (): ProdPreviewInput => ({
  env: { VERCEL_ENV: "production", PROPOSAL_PROD_PREVIEW: "on", PROPOSAL_PROD_APPROVED: "yes", PROPOSAL_PROD_HOUSEHOLDS: "h1,h2", PROPOSAL_DAILY_BUDGET_JPY: "30", PROPOSAL_ANTHROPIC_API_KEY: KEY },
  householdId: "h1",
  settings: { enabled: true, kill: false },
  usage: { todayJpy: 5 },
  otherKeys: ["sk-ant-other-feature-key-9999"],
});

describe("本番限定プレビューの許可判定（設計・未接続）", () => {
  it("既定（何も設定していない）は拒否。全条件が揃ったときだけ許可し、自動登録・通知は常に false", () => {
    const d0 = productionPreviewPermission({ env: {}, householdId: "h1", settings: null, usage: { todayJpy: 0 } });
    expect(d0.allowed).toBe(false);
    expect(d0.allowed === false && d0.reasons.length).toBeGreaterThanOrEqual(7);
    expect(productionPreviewPermission(ok())).toEqual({ allowed: true, autoRegister: false, notify: false, budgetJpy: 30 });
  });
  it("どの条件が欠けても拒否（理由つき）", () => {
    const cases: [string, (i: ProdPreviewInput) => void, string][] = [
      ["スイッチ1", (i) => delete i.env.PROPOSAL_PROD_PREVIEW, "switch1_off"],
      ["スイッチ2（承認）", (i) => (i.env.PROPOSAL_PROD_APPROVED = "no"), "switch2_not_approved"],
      ["DB設定なし", (i) => (i.settings = null), "no_db_settings"],
      ["DB設定が無効", (i) => (i.settings = { enabled: false, kill: false }), "db_disabled"],
      ["世帯が許可リスト外", (i) => (i.householdId = "h9"), "household_not_allowed"],
      ["専用予算なし", (i) => delete i.env.PROPOSAL_DAILY_BUDGET_JPY, "no_dedicated_budget"],
      ["予算を使い切った", (i) => (i.usage.todayJpy = 30), "budget_exhausted"],
      ["専用キーなし", (i) => delete i.env.PROPOSAL_ANTHROPIC_API_KEY, "no_dedicated_key"],
      ["キーを他の機能と共用", (i) => (i.otherKeys = [KEY]), "key_shared_with_other_feature"],
    ];
    for (const [name, mut, reason] of cases) {
      const i = ok();
      mut(i);
      const d = productionPreviewPermission(i);
      expect(d.allowed, name).toBe(false);
      expect(d.allowed === false && d.reasons, name).toContain(reason);
    }
  });
  it("即時OFF: 環境変数の緊急停止・DB側の停止のどちらか一方で拒否（DB側は再デプロイ不要）", () => {
    const a = ok();
    a.env.PROPOSAL_KILL = "1";
    expect(productionPreviewPermission(a)).toEqual({ allowed: false, reasons: ["killed_by_env"] });
    const b = ok();
    b.settings = { enabled: true, kill: true };
    expect(productionPreviewPermission(b)).toEqual({ allowed: false, reasons: ["killed_by_db"] });
  });
  it("誤起動の防止: ローカル・プレビュー環境では、本番用のスイッチが全部立っていても拒否。逆に、ローカル用の許可（flag.ts）は本番・ホスト型DBでは常に拒否", () => {
    for (const vercelEnv of [undefined, "preview", "development"]) {
      const i = ok();
      if (vercelEnv) i.env.VERCEL_ENV = vercelEnv;
      else delete i.env.VERCEL_ENV;
      const d = productionPreviewPermission(i);
      expect(d.allowed).toBe(false);
      expect(d.allowed === false && d.reasons).toEqual(["not_production_environment"]);
    }
    expect(proposalPreviewEnabled({ ...ok().env, TOREMANE_ENV: "local", PROPOSAL_PREVIEW: "on", NEXT_PUBLIC_SUPABASE_URL: "https://abcdefghij.supabase.co" })).toBe(false);
    expect(proposalPreviewEnabled({ ...ok().env, TOREMANE_ENV: "local", PROPOSAL_PREVIEW: "on", NEXT_PUBLIC_SUPABASE_URL: "http://127.0.0.1:55321" })).toBe(false); // VERCEL_ENV があれば無効
  });
});

describe("静的確認: この判定はどこにも接続されていない（設計のみ）", () => {
  const walk = (d: string): string[] => readdirSync(d).flatMap((n) => { const p = `${d}/${n}`; return statSync(p).isDirectory() ? walk(p) : /\.(ts|tsx)$/.test(n) ? [p] : []; });
  it("prod-gate を import する非テストのファイルは無い", () => {
    const users = walk("src").filter((f) => !/\.test\.tsx?$/.test(f) && !f.endsWith("prod-gate.ts") && !f.endsWith("shadow/proposal-job.ts") && /proposals\/prod-gate|\.\/prod-gate/.test(readFileSync(f, "utf8")));
    expect(users).toEqual([]);
  });
});
