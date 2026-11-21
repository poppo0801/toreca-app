/**
 * Stage 10E 追加修正（A-3）: 費用・ループ・履歴保護の回帰テスト。破壊的操作に関わるものを優先する。
 * 台本のモデル（test double）による。実AIの挙動の証明ではない。
 */
import { describe, expect, it } from "vitest";
import { BudgetPools, BudgetStop } from "./budget";
import { judgeCase } from "./engine";
import { mockAnswer } from "./eval/mock-answers";
import { inputFor, loadCases } from "./eval/replay";
import { ScriptedModel } from "./model";
import { verifyJudgment } from "./verify";
import type { JudgmentOutput, PlannedOp } from "./contract";
import { decideAutonomousOp } from "@/lib/case-model/history-guard";

const NOW = "2099-01-20T00:00:00.000Z";
const { cases } = loadCases();
const byId = (id: string) => cases.find((c) => c.id === id)!;
const clone = <T,>(x: T): T => JSON.parse(JSON.stringify(x));
const pools = (j = 100, i = 100, d = 100) => new BudgetPools({ judgment: j, investigation: i, discovery: d });

describe("予算: 二重計上・不明費用・並列・不正な費用", () => {
  it("同じ予約を2度精算・返却しても二重に計上・返金されない", () => {
    const b = pools(10);
    const t = b.reserve("judgment", 3);
    b.settle(t, 1);
    b.settle(t, 1);
    b.release(t, true);
    expect(b.state("judgment").spentJpy).toBeCloseTo(1, 5);
    const t2 = b.reserve("judgment", 2);
    b.release(t2, true);
    b.release(t2, true);
    b.settle(t2, 0);
    expect(b.state("judgment").spentJpy).toBeCloseTo(1, 5);
  });
  it("費用が不明（null）・NaN・負の値は、予約額を使ったものとして残す（返金で過少計上しない）", () => {
    for (const bad of [null, Number.NaN, -5, Number.POSITIVE_INFINITY]) {
      const b = pools(10);
      b.settle(b.reserve("judgment", 4), bad as number | null);
      expect(b.state("judgment").spentJpy, String(bad)).toBe(4);
      expect(b.state("judgment").unknownCostCalls).toBe(1);
    }
  });
  it("実費が予約額を超えた場合も、超過分を計上し、その後の予約は上限で止まる", () => {
    const b = pools(5);
    b.settle(b.reserve("judgment", 1), 4.5);
    expect(b.state("judgment").spentJpy).toBeCloseTo(4.5, 5);
    expect(() => b.reserve("judgment", 1)).toThrow(BudgetStop);
  });
  it("並列実行: 同時に複数の判断を始めても、上限を超える見込みの呼び出しは行わない", async () => {
    const b = pools(2.5); // 最大費用1円×2回まで
    const input = await inputFor(byId("J07"), NOW);
    const model = new ScriptedModel((i) => ({ raw: mockAnswer("J07", i), costJpy: 1 }), undefined, 1);
    const rs = await Promise.all(Array.from({ length: 5 }, () => judgeCase({ model, budget: b }, input)));
    expect(model.calls).toBe(2);
    expect(rs.filter((r) => r.status === "accepted").length).toBe(2);
    expect(rs.filter((r) => r.status === "budget_stopped").length).toBe(3);
    expect(b.state("judgment").spentJpy).toBeLessThanOrEqual(2.5);
  });
  it("費用不明の呼び出しが続いても、予約額で積み上がり、上限で止まる（0円扱いで無制限に続かない）", async () => {
    const b = pools(3);
    const input = await inputFor(byId("J07"), NOW);
    const model = new ScriptedModel((i) => ({ raw: mockAnswer("J07", i), costJpy: null }), undefined, 1);
    for (let k = 0; k < 6; k++) await judgeCase({ model, budget: b }, input);
    expect(model.calls).toBe(3);
  });
});

describe("再判断・失敗の上限", () => {
  it("検証に通らない出力が続いても、呼び出しは最大3回（初回＋再判断2回）で止まり、部分採用か未確定になる", async () => {
    const input = await inputFor(byId("J07"), NOW);
    const bad = (i: typeof input) => {
      const o = clone(mockAnswer("J07", i)) as JudgmentOutput;
      o.caseType = { value: "lottery_announcement", basis: "fact", citations: [] }; // 引用なしのfact
      return o;
    };
    const model = new ScriptedModel((i) => ({ raw: bad(i), costJpy: 0.1 }));
    const r = await judgeCase({ model, budget: pools() }, input);
    expect(model.calls).toBe(3);
    expect(["partial", "unresolved"]).toContain(r.status);
    expect(r.output?.caseType.basis ?? "unknown").not.toBe("fact"); // 根拠のないfactは採用しない
  });
  it("モデルが例外を投げ続けても無限に再試行しない。失敗の費用は返却されない", async () => {
    const b = pools(10);
    const input = await inputFor(byId("J07"), NOW);
    const model = new ScriptedModel(() => {
      throw new Error("timeout");
    }, undefined, 1);
    const r = await judgeCase({ model, budget: b }, input);
    expect(r.status).toBe("model_error");
    expect(model.calls).toBe(2);
    expect(b.state("judgment").spentJpy).toBe(2);
  });
});

describe("履歴保護: 破壊的操作は、記録上の保護があるとき（または保護の確認ができないとき）常に拒否される", () => {
  const BLOCKERS = ["confirmed", "human_registered", "manual_form", "managed", "applications", "notifications", "skip", "rules", "memo_feedback", "user_exclusion", "x_bookmark"];
  const DESTRUCTIVE: PlannedOp[] = ["change", "merge", "delete", "move_history"];
  const withProtection = async (codes: string[], unknown = false) => {
    const input = await inputFor(byId("J10"), NOW);
    input.related[0].protectedCodes = codes;
    if (unknown) input.related[0].protectionUnknown = true;
    return input;
  };
  const planned = async (op: PlannedOp, codes: string[], unknown = false) => {
    const input = await withProtection(codes, unknown);
    const out = clone(mockAnswer("J10", input)) as JudgmentOutput;
    out.plannedChanges = [{ lotteryId: input.related[0].lotteryId, op, reason: "テスト" }];
    return verifyJudgment(input, out).filter((v) => v.code === "protected_change");
  };
  it("応募・当落・通知・スルー・ルール・手動確定など、どの保護理由でも 変更/統合/削除/履歴の付け替え は拒否", async () => {
    for (const code of BLOCKERS) for (const op of DESTRUCTIVE) expect((await planned(op, [code])).length, `${code}/${op}`).toBe(1);
  });
  it("保護の確認ができなかった抽選（保護の判定不能）は、保護なしとみなさず拒否する", async () => {
    for (const op of DESTRUCTIVE) expect((await planned(op, [], true)).length, op).toBe(1);
  });
  it("未知の保護理由コードは拒否（DBが新しい理由を返しても素通りしない）", async () => {
    for (const op of DESTRUCTIVE) expect((await planned(op, ["some_future_reason"])).length, op).toBe(1);
  });
  it("非破壊の関連づけ（link_case）は、保護された抽選でも許可される。保護が無ければ変更も許可される（過剰に止めない）", async () => {
    expect((await planned("link_case", ["applications"])).length).toBe(0);
    expect((await planned("change", [])).length).toBe(0);
  });
  it("空欄補完（fill_empty）は、人が確定した・手動登録の抽選では拒否され、その他の保護理由では許可される（既存の方針）", () => {
    for (const c of ["confirmed", "manual_form", "human_registered"]) expect(decideAutonomousOp("fill_empty", [c]).allowed, c).toBe(false);
    expect(decideAutonomousOp("fill_empty", ["applications"]).allowed).toBe(true);
    expect(decideAutonomousOp("fill_empty", ["unknown_code"]).allowed).toBe(false);
  });
  it("人が確定した項目値は、AIが別の値で上書きする提案をしても不合格", async () => {
    const input = await inputFor(byId("J10"), NOW);
    const rel = input.related[0];
    rel.protectedCodes = [];
    rel.humanConfirmed = { applyDeadline: "2099-03-10" };
    const out = clone(mockAnswer("J10", input)) as JudgmentOutput;
    out.plannedChanges = [{ lotteryId: rel.lotteryId, op: "fill_empty", field: "applyDeadline", value: "2099-03-14", reason: "延長" }];
    expect(verifyJudgment(input, out).map((v) => v.code)).toContain("human_value_overwrite");
  });
});

describe("契約の版 10e.2（per_round の加算）と、過去（10e.1）との互換", () => {
  it("10e.1 と表示された出力も受け付け、10e.2 として扱う。未知の版は拒否。per_round は 10e.2 で有効", async () => {
    const { parseJudgmentOutput, CONTRACT_VERSION } = await import("./contract");
    const input = await inputFor(byId("J07"), NOW);
    const out = clone(mockAnswer("J07", input)) as Record<string, unknown>;
    expect(CONTRACT_VERSION).toBe("10e.2");
    for (const v of ["10e.1", "10e.2"]) {
      const r = parseJudgmentOutput({ ...out, version: v });
      expect(r.ok, v).toBe(true);
      if (r.ok) expect(r.output.version).toBe("10e.2");
    }
    expect(parseJudgmentOutput({ ...out, version: "9.9" }).ok).toBe(false);
    const pr = clone(out) as { structure: { kind: string } };
    pr.structure.kind = "per_round";
    expect(parseJudgmentOutput(pr).ok).toBe(true);
  });
  it("過去の判断履歴（10e.1 のプロンプト版・per_round を含まない構造の文字列）は、再解釈・書き換えなしにそのまま入力へ戻る", async () => {
    const { arrangePriorJudgments } = await import("./build-input");
    const rows = [
      { id: "a", kind: "structure", subject: "structure", claimBasis: "fact" as const, value: "store_select: 応募時に店舗を選ぶ", judgeKind: "ai" as const, correctionOf: null, at: "2099-01-01T00:00:00Z" },
      { id: "b", kind: "structure", subject: "structure", claimBasis: "fact" as const, value: "per_round: 開催回別", judgeKind: "ai" as const, correctionOf: null, at: "2099-01-02T00:00:00Z" },
    ];
    expect(arrangePriorJudgments(rows).map((r) => r.value)).toEqual(["per_round: 開催回別", "store_select: 応募時に店舗を選ぶ"]);
  });
});
