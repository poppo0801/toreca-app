// @vitest-environment node
/** Phase 3: 本番シャドーの閲覧許可・許可証・画面の接続の静的確認（無課金・DBなし）。 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { proposalPreviewEnabled, proposalShadowViewEnabled, proposalSurfaceEnabled } from "./flag";
import { isRealRunTicket, issueProductionShadowTicket } from "./real-gate";

const PROD = { VERCEL_ENV: "production", PROPOSAL_PROD_PREVIEW: "on", PROPOSAL_PROD_APPROVED: "yes" };

describe("本番シャドーの閲覧許可（読み取りとレビューの記録だけ。生成は含まない）", () => {
  it("既定はOFF。本番環境・2つのスイッチ・停止なしが揃うときだけON。ローカル開発の許可とは独立", () => {
    expect(proposalShadowViewEnabled({})).toBe(false);
    expect(proposalShadowViewEnabled(PROD)).toBe(true);
    expect(proposalShadowViewEnabled({ ...PROD, PROPOSAL_PROD_APPROVED: "no" })).toBe(false);
    expect(proposalShadowViewEnabled({ ...PROD, PROPOSAL_PROD_PREVIEW: "off" })).toBe(false);
    expect(proposalShadowViewEnabled({ ...PROD, PROPOSAL_KILL: "1" })).toBe(false);
    expect(proposalShadowViewEnabled({ ...PROD, VERCEL_ENV: "preview" })).toBe(false);
    expect(proposalPreviewEnabled(PROD)).toBe(false); // ローカル用の許可は、本番では立たない
    expect(proposalSurfaceEnabled(PROD)).toBe(true);
    expect(proposalSurfaceEnabled({})).toBe(false);
  });
  it("画面の生成の操作（generateProposalsAction）は、閲覧許可では動かない（ローカル開発の許可だけ）", () => {
    const s = readFileSync("src/app/(app)/lotteries/candidates/proposal-actions.ts", "utf8");
    const gen = s.slice(s.indexOf("export async function generateProposalsAction"), s.indexOf("export async function reviewProposalAction"));
    expect(gen).toContain("proposalPreviewEnabled()");
    expect(gen).not.toContain("proposalSurfaceEnabled");
  });
});

describe("本番シャドーの許可証", () => {
  const a = { model: "claude-haiku-5-5", totalCapJpy: 3, perCaseCapJpy: 3 };
  it("本番ゲートが allowed のときだけ発行。上限は1件25円・総額1000円で頭打ち。不正なモデル名・予算なしは発行しない", () => {
    expect(issueProductionShadowTicket({ allowed: false }, a)).toMatchObject({ ok: false, reason: "prod_gate_denied" });
    const t = issueProductionShadowTicket({ allowed: true }, { model: "claude-haiku-5-5", totalCapJpy: 99999, perCaseCapJpy: 99 });
    expect(t.ok && isRealRunTicket(t.ticket) && t.ticket.perCaseCapJpy === 25 && t.ticket.totalCapJpy === 1000 && t.ticket.origin === "prod_shadow").toBe(true);
    expect(issueProductionShadowTicket({ allowed: true }, { ...a, totalCapJpy: 0 })).toMatchObject({ ok: false, reason: "no_budget" });
    expect(issueProductionShadowTicket({ allowed: true }, { ...a, model: "gpt-4; rm" })).toMatchObject({ ok: false, reason: "bad_model" });
  });
  it("許可証の偽造はできない（plain object は許可証ではない）", () => {
    expect(isRealRunTicket({ model: "x", totalCapJpy: 1, perCaseCapJpy: 1, issuedAt: "", origin: "prod_shadow" })).toBe(false);
  });
});

describe("静的確認: 本番シャドーの登録案ジョブは読み取り専用の範囲に収まる", () => {
  const s = readFileSync("src/lib/server/shadow/proposal-job.ts", "utf8");
  it("抽選・応募・購入・通知・履歴の表に書かない／検索は印つきだけ／実取得・画像解析は本番の許可を通した印つきの入口だけ／キーは専用キー（または明示スイッチの既存キー）だけ", () => {
    expect(s).not.toMatch(/\.from\(["'](lotteries|applications|purchases|notification_deliveries|application_results|audit_logs)/);
    expect(s).toContain("markShadowTool(makeSearchTool("); // 検索は評価入口と同じ makeSearchTool を通し、本番の印をつけたものだけ（印の無い検索は generate が拒否する）
    expect(s).not.toMatch(/tools\.search\s*=(?!\s*markShadowTool)/);
    expect(s).toContain("makeShadowLivePublicFetch"); // 実取得は本番許可（SHADOW_LIVE_FETCH）を通した入口
    expect(s).toContain("markShadowTool"); // 画像解析は印つき
    expect(s).not.toMatch(/makeLivePublicFetch\(/); // 開発用の取得入口は使わない
    expect(s).toContain("SHADOW_ANTHROPIC_API_KEY");
    expect(s).not.toMatch(/process\.env\.(AGENT_ANTHROPIC|JUDGMENT_)/);
  });
  it("cron の入口は既定でジョブを渡さない（PROPOSAL_PROD_PREVIEW が on のときだけ）", () => {
    const r = readFileSync("src/app/api/cron/shadow/route.ts", "utf8");
    expect(r).toMatch(/proposalMode = \["on", "1", "yes"\]\.includes\(process\.env\.PROPOSAL_PROD_PREVIEW/);
    expect(r).toContain("proposalMode ?");
  });
});

describe("シャドーのAPIキー（専用キー優先・既存キーの再利用は明示スイッチのみ）", () => {
  it("専用キー → 明示スイッチつきの既存キー → null。スイッチが無ければ既存キーがあっても使わない", async () => {
    const { shadowApiKey } = await import("@/lib/server/shadow/allow");
    const ded = "d".repeat(30);
    const ex = "e".repeat(30);
    expect(shadowApiKey({ SHADOW_ANTHROPIC_API_KEY: ded, ANTHROPIC_API_KEY: ex })).toMatchObject({ key: ded, source: "dedicated" });
    expect(shadowApiKey({ ANTHROPIC_API_KEY: ex })).toBeNull();
    expect(shadowApiKey({ ANTHROPIC_API_KEY: ex, SHADOW_REUSE_EXISTING_KEY: "yes" })).toBeNull();
    expect(shadowApiKey({ ANTHROPIC_API_KEY: ex, SHADOW_REUSE_EXISTING_KEY: "allow" })).toMatchObject({ key: ex, source: "existing" });
    expect(shadowApiKey({ SHADOW_REUSE_EXISTING_KEY: "allow", ANTHROPIC_API_KEY: "short" })).toBeNull();
  });
});
