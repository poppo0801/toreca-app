import { describe, expect, it } from "vitest";
import type { ReviewInfo } from "@/lib/agent/core";
import { discoveryReview } from "./review";
import { newState } from "./tools";
import type { DiscoveryMission, RecordedLead } from "./types";

const mission: DiscoveryMission = { id: "chain:テスト", trigger: { kind: "chain", chain: "テスト" }, targetPrefectures: ["大阪府"], today: "2026-11-19", context: [] };
const info = (over: Partial<ReviewInfo["remaining"]> = {}, output: unknown = { reason: "sufficient", note: "x", unconfirmed: ["A店の告知本文"] }): ReviewInfo => ({
  output,
  round: 0,
  trace: [],
  usage: { steps: 7, searches: 2, fetches: 3, costJpy: 7, ms: 30_000, duplicateCalls: 0, rejectedCalls: 0, injectionFlags: 0 } as never,
  remaining: { steps: 20, searches: 6, fetches: 10, costJpy: 15, ms: 80_000, ...over },
});
const lead = (status: "adopt" | "hold" | "exclude", over: Record<string, unknown> = {}): RecordedLead =>
  ({ lead: { url: "https://x.example/a", chain: "テスト", store: "B店", ...over }, decision: { status, reason: "理由", attention: [], credit: "none", ...over }, atStep: 3 }) as never;

describe("discoveryReview（終了前の検証。事実だけを示し、調査の内容は指示しない）", () => {
  it("未確認の項目・根拠不足の手がかり・二次情報だけの採用候補と残りの予算を示す", async () => {
    const st = newState(mission);
    st.leads.push(lead("exclude", { exclusion: "evidence_missing" }), lead("adopt", { attention: ["二次情報（まとめサイト）の記載です"] }));
    const r = await discoveryReview(st, { maxCostJpy: 25 })(info());
    expect(r?.feedback).toContain("A店の告知本文");
    expect(r?.feedback).toContain("根拠が足りず");
    expect(r?.feedback).toContain("二次情報");
    expect(r?.feedback).toContain("残り");
    expect(r?.feedback).toContain("そのまま再提出して終了して構いません"); // 続けるかはAIが決める
    expect(r?.feedback).not.toMatch(/https?:\/\//); // 調査先のURLは指示しない
  });
  it("余力が小さい・示す事実が無いときは何もしない（上限は増えない）", async () => {
    const st = newState(mission);
    expect(await discoveryReview(st, { maxCostJpy: 25 })(info({ costJpy: 3 }))).toBeNull();
    expect(await discoveryReview(st, { maxCostJpy: 25 })(info({ steps: 2 }))).toBeNull();
    expect(await discoveryReview(st, { maxCostJpy: 25 })(info({ searches: 0, fetches: 1 }))).toBeNull();
    expect(await discoveryReview(st, { maxCostJpy: 25 })(info({}, { reason: "sufficient", note: "x", unconfirmed: [] }))).toBeNull();
  });
});
