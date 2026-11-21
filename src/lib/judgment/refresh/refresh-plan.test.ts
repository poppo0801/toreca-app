// @vitest-environment node
/** 全情報／抽選候補の一括再整理テスト計画部品の検査（Stage 10F）。架空データのみ。適用の関数が存在しないこと、保護の扱い、停止条件を確認する。 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import * as plan from "./refresh-plan";
import { PILOT_LIMITS, allowedActions, buildPreview, classifyProtection, estimateRefreshCost, selectTargets, shouldStop, type RefreshFacts } from "./refresh-plan";

const f = (id: string, over: Partial<RefreshFacts> = {}): RefreshFacts => ({
  id, tab: "all_info", archived: false, deadline: "open", managed: false, hasApplicationHistory: false, humanConfirmedFields: [], protectedCodes: [], protectionUnknown: false, sourceKind: "web", hasStoredEvidence: false, ...over,
});

describe("履歴保護の分類（保護ありを保護なしとみなさない）", () => {
  it("応募・当選・購入の記録／保護コード／人の確定／★／確認不能を、強い順に分類する", () => {
    expect(classifyProtection(f("a")).cls).toBe("none");
    expect(classifyProtection(f("a", { managed: true })).cls).toBe("managed");
    expect(classifyProtection(f("a", { humanConfirmedFields: ["applyDeadline"], managed: true })).cls).toBe("human_confirmed");
    expect(classifyProtection(f("a", { hasApplicationHistory: true, humanConfirmedFields: ["x"] })).cls).toBe("history_protected");
    expect(classifyProtection(f("a", { protectedCodes: ["applications"] })).cls).toBe("history_protected");
    expect(classifyProtection(f("a", { protectionUnknown: true, hasApplicationHistory: true })).cls).toBe("unknown");
  });
  it("保護あり・不明は、更新・統合・削除の提案を許さず、関連づけ・残置・保留・人への確認だけ", () => {
    expect(allowedActions("none")).toContain("delete_proposal");
    for (const c of ["unknown", "history_protected", "human_confirmed", "managed"] as const) {
      const a = allowedActions(c);
      expect(a).not.toContain("update_proposal");
      expect(a).not.toContain("merge_proposal");
      expect(a).not.toContain("delete_proposal");
      expect(a).toContain("ask_human");
    }
  });
});

describe("対象の選択: 決定的・除外・優先順位・件数の上限", () => {
  const all = [
    f("e", { archived: true }),
    f("d", { deadline: "closed" }),
    f("c", { sourceKind: "x" }),
    f("b", { hasStoredEvidence: true }),
    f("a", { hasStoredEvidence: true, managed: true }),
    f("z", { hasStoredEvidence: false }),
    f("y", { tab: "lottery_candidates", hasStoredEvidence: true }),
  ];
  it("アーカイブ済み・応募受付終了は除外（理由つき）。保存原文があり保護のないものを先に、保護あり・取得不能な情報元は後に", () => {
    const s = selectTargets(all, { maxTargets: 10 });
    expect(s.excluded).toEqual([{ id: "e", reason: "archived" }, { id: "d", reason: "closed" }]);
    expect(s.targets.map((t) => t.id)).toEqual(["b", "y", "z", "c", "a"]);
    expect(selectTargets(all, { maxTargets: 10 }).targets.map((t) => t.id)).toEqual(s.targets.map((t) => t.id)); // 決定的
  });
  it("件数の上限（既定30・最大100）で切り、残りは deferred として数える", () => {
    const many = Array.from({ length: 150 }, (_, i) => f(`t${String(i).padStart(3, "0")}`));
    expect(selectTargets(many).targets.length).toBe(30);
    expect(selectTargets(many, { maxTargets: 9999 }).targets.length).toBe(100);
    expect(selectTargets(many, { maxTargets: 10 }).deferred).toBe(140);
  });
});

describe("差分プレビュー: 実行可能な操作を含まず、保護されたものへの提案は人の確認に落とす", () => {
  it("executable=false。保護ありの更新・統合・削除の提案は ask_human になり、理由が残る。保護なしの提案はそのまま", () => {
    const p = buildPreview([
      { facts: f("free"), proposal: "delete_proposal", reason: "受付終了・重複" },
      { facts: f("applied", { hasApplicationHistory: true }), proposal: "merge_proposal", reason: "同一の可能性" },
      { facts: f("human", { humanConfirmedFields: ["store"] }), proposal: "update_proposal", reason: "締切の相違" },
      { facts: f("unk", { protectionUnknown: true }), proposal: "delete_proposal", reason: "不要" },
      { facts: f("keep", { managed: true }), proposal: "keep", reason: "確認済み" },
    ]);
    expect(p.executable).toBe(false);
    expect(p.items.map((i) => i.proposed)).toEqual(["delete_proposal", "ask_human", "ask_human", "ask_human", "keep"]);
    expect(p.items[1].reason).toContain("保護");
    expect(p.items.every((i) => i.needsHumanReview)).toBe(true);
    expect(p.counts.byProtection).toMatchObject({ none: 1, history_protected: 1, human_confirmed: 1, unknown: 1, managed: 1 });
    expect(p.counts.byAction.ask_human).toBe(3);
  });
  it("このモジュールには、更新・統合・削除を実行する関数が存在せず、DB・ネットワーク・AIを読み込まない", () => {
    for (const k of Object.keys(plan)) expect(k, k).not.toMatch(/^(apply|execute|delete|merge|update|register|write|save|restore)/i);
    const src = readFileSync("src/lib/judgment/refresh/refresh-plan.ts", "utf8");
    expect(src).not.toMatch(/from "@\/lib\/server|supabase|anthropic|\bfetch\(|node:fs|\.from\(|\.insert\(|\.update\(|\.delete\(/i);
  });
});

describe("上限と停止条件・費用の見積もり", () => {
  const c0 = { targets: 0, apiCalls: 0, webFetches: 0, costJpy: 0, consecutiveFailures: 0, protectionViolations: 0 };
  it("保護違反1件・費用/回数/取得/件数の上限・連続失敗のいずれかで停止する。上限内なら続行", () => {
    expect(shouldStop(c0, PILOT_LIMITS)).toBeNull();
    expect(shouldStop({ ...c0, protectionViolations: 1 }, PILOT_LIMITS)).toContain("保護");
    expect(shouldStop({ ...c0, costJpy: 50 }, PILOT_LIMITS)).toContain("費用");
    expect(shouldStop({ ...c0, apiCalls: 90 }, PILOT_LIMITS)).toContain("AI呼び出し");
    expect(shouldStop({ ...c0, webFetches: 60 }, PILOT_LIMITS)).toContain("取得");
    expect(shouldStop({ ...c0, targets: 30 }, PILOT_LIMITS)).toContain("件数");
    expect(shouldStop({ ...c0, consecutiveFailures: 5 }, PILOT_LIMITS)).toContain("連続");
    expect(PILOT_LIMITS.stopOnProtectionViolation).toBe(true);
  });
  it("費用の見積もり: 保存原文のみなら小さく、Web調査を伴う分は過去実績（約5.6円/件）で見積もる。見積もりと実測は区別する", () => {
    const t = [f("a", { hasStoredEvidence: true }), f("b", { hasStoredEvidence: true }), f("c"), f("d")];
    expect(estimateRefreshCost(t, { withWebInvestigation: false })).toEqual({ typicalJpy: 0.8, worstJpy: 3.3 });
    const w = estimateRefreshCost(t, { withWebInvestigation: true });
    expect(w.typicalJpy).toBe(12);
    expect(w.worstJpy).toBe(23.3);
  });
});
