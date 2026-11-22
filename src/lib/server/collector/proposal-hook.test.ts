// @vitest-environment node
/** 収集の接続口（proposal-hook）: 待ち時間の超過で協調的な中止を要求し、失敗は分類コードだけを記録して収集を止めない。実AIは渡さない。 */
import { afterEach, describe, expect, it, vi } from "vitest";

const captured: { deps?: { mode: string; shouldStop?: () => boolean } } = {};
let behavior: "slow" | "fail" | "ok" = "ok";
vi.mock("@/lib/server/proposals/generate", async (orig) => {
  const real = await orig<typeof import("@/lib/server/proposals/generate")>();
  return {
    ...real,
    generateProposalsForCandidate: vi.fn(async (a: { deps: { mode: string; shouldStop?: () => boolean } }) => {
      captured.deps = a.deps;
      if (behavior === "slow") {
        await new Promise((r) => setTimeout(r, 200));
        return { ok: true, records: [], save: { inserted: 0, unchanged: 0, superseded: 0, failed: 0 }, stopped: !!a.deps.shouldStop?.(), costJpy: 0 };
      }
      if (behavior === "fail") return { ok: false, reason: "run_failed" };
      return { ok: true, records: [], save: { inserted: 0, unchanged: 0, superseded: 0, failed: 0 }, stopped: false, costJpy: 0 };
    }),
  };
});
import { proposalAfterCandidate } from "./proposal-hook";

const ENV = { TOREMANE_ENV: "local", PROPOSAL_PREVIEW: "on", PROPOSAL_AUTO: "on", NEXT_PUBLIC_SUPABASE_URL: "http://127.0.0.1:55321" };
const db = { from: () => ({ select: () => ({ eq: () => ({ eq: () => ({ maybeSingle: async () => ({ data: { id: "c1", last_good: {} }, error: null }) }) }) }) }) } as never;

afterEach(() => {
  vi.restoreAllMocks();
  captured.deps = undefined;
});

describe("収集の接続口（協調的な中止・失敗の分類）", () => {
  it("実AIは渡さない（mode=mock 固定）。待ち時間を超えたら中止を要求し、収集へ戻る（残った処理は次の項目の前で止まる）", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    behavior = "slow";
    const t0 = Date.now();
    await proposalAfterCandidate({ db, householdId: "h", candidateId: "c1", env: ENV, timeoutMs: 40 });
    expect(Date.now() - t0).toBeLessThan(150); // 待ち時間の上限で戻る
    expect(captured.deps?.mode).toBe("mock");
    expect(captured.deps?.shouldStop?.()).toBe(true); // 中止が要求された
    expect(warn).toHaveBeenCalledWith("[proposal-hook] timeout_stop_requested");
    await new Promise((r) => setTimeout(r, 250)); // 残った処理が完走しても例外にならない
  });
  it("失敗は無言で握りつぶさず、分類コードだけを記録する（原文・IDを含めない）。収集は止めない", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    behavior = "fail";
    await expect(proposalAfterCandidate({ db, householdId: "h", candidateId: "c1", env: ENV })).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledWith("[proposal-hook] generate_run_failed");
    expect(JSON.stringify(warn.mock.calls)).not.toMatch(/c1/);
    const boom = { from: () => { throw new TypeError("db down"); } } as never;
    await expect(proposalAfterCandidate({ db: boom, householdId: "h", candidateId: "c1", env: ENV })).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledWith("[proposal-hook] error:TypeError");
  });
  it("無効（フラグ無し・本番DB・自動生成OFF）のときは何も呼ばず、記録もしない", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    behavior = "ok";
    for (const env of [{}, { ...ENV, PROPOSAL_AUTO: "" }, { ...ENV, NEXT_PUBLIC_SUPABASE_URL: "https://abcdefghij.supabase.co" }, { ...ENV, VERCEL: "1" }]) await proposalAfterCandidate({ db, householdId: "h", candidateId: "c1", env });
    expect(captured.deps).toBeUndefined();
    expect(warn).not.toHaveBeenCalled();
  });
});
