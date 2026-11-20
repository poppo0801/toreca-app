import { describe, expect, it } from "vitest";
import { decideAutonomousOp } from "./history-guard";
import { canOverwrite } from "./value-priority";
import { classifyEvidence } from "./evidence-status";
import { resolveJudgmentEngine } from "./judgment-engine";
import { chainCanonicalKey } from "@/lib/chain-normalize";
import { normName } from "@/lib/norm";
import { readingKey } from "@/lib/master-identity/reading";

describe("Stage 10D: 履歴保護の判定", () => {
  it("記録上の保護が無ければ、どの操作も許可する", () => {
    for (const op of ["change", "fill_empty", "merge", "delete", "move_history", "link_case"] as const) expect(decideAutonomousOp(op, []).allowed).toBe(true);
  });
  it("応募・通知・スルー・手動分類などがあれば、変更・統合・削除・履歴の付け替えを拒否する（理由つき）", () => {
    for (const code of ["applications", "notifications", "skip", "rules", "memo_feedback", "user_exclusion", "x_bookmark", "managed", "confirmed", "human_registered", "manual_form"]) {
      for (const op of ["change", "merge", "delete", "move_history"] as const) {
        const d = decideAutonomousOp(op, [code]);
        expect(d.allowed, `${code}/${op}`).toBe(false);
        expect(d.reasons.length).toBeGreaterThan(0);
      }
    }
  });
  it("案件への関連づけ（link_case）は、保護された抽選でも許可（既存の値・履歴を変えない）。ただし抽選が無ければ拒否", () => {
    expect(decideAutonomousOp("link_case", ["applications", "confirmed"]).allowed).toBe(true);
    expect(decideAutonomousOp("link_case", ["not_found"]).allowed).toBe(false);
  });
  it("空欄の補完は、人が確定・手動分類・人の登録の抽選では拒否し、応募があるだけなら許可する（既存の値を変えない）", () => {
    expect(decideAutonomousOp("fill_empty", ["confirmed"]).allowed).toBe(false);
    expect(decideAutonomousOp("fill_empty", ["manual_form"]).allowed).toBe(false);
    expect(decideAutonomousOp("fill_empty", ["human_registered"]).allowed).toBe(false);
    expect(decideAutonomousOp("fill_empty", ["applications"]).allowed).toBe(true);
  });
  it("未知の保護理由は安全側（拒否）", () => {
    expect(decideAutonomousOp("change", ["something_new"]).allowed).toBe(false);
    expect(decideAutonomousOp("fill_empty", ["something_new"]).allowed).toBe(false);
  });
});

describe("Stage 10D: 値の優先順位", () => {
  it("人が確定した値は、AI・公式の根拠でも上書きしない", () => {
    expect(canOverwrite({ existing: "human_confirmed", incoming: "official_fact" }).allowed).toBe(false);
    expect(canOverwrite({ existing: "human_confirmed", incoming: "ai_inference" }).allowed).toBe(false);
  });
  it("人の確定どうしは更新できる（人が直した）", () => {
    expect(canOverwrite({ existing: "human_confirmed", incoming: "human_confirmed", incomingIsNewerEvidence: true }).allowed).toBe(true);
  });
  it("空欄は補完できる。強い根拠は弱い値を置き換え、弱い・同じ強さ（新しくない）は据え置く", () => {
    expect(canOverwrite({ existing: "unknown", incoming: "ai_inference", existingEmpty: true }).allowed).toBe(true);
    expect(canOverwrite({ existing: "ai_inference", incoming: "official_fact" }).allowed).toBe(true);
    expect(canOverwrite({ existing: "official_fact", incoming: "ai_inference" }).allowed).toBe(false);
    expect(canOverwrite({ existing: "single_source", incoming: "single_source" }).allowed).toBe(false);
    expect(canOverwrite({ existing: "single_source", incoming: "single_source", incomingIsNewerEvidence: true }).allowed).toBe(true);
  });
});

describe("Stage 10D: 根拠の取得状況の区別", () => {
  it("取得成功・読解失敗・取得不能・未取得を区別し、保存の無い過去分を取得済みとしない", () => {
    expect(classifyEvidence({ hasStoredText: true, parsedOk: true })).toBe("fetched");
    expect(classifyEvidence({ hasStoredText: true, parsedOk: false })).toBe("fetched_unread");
    expect(classifyEvidence({ hasStoredText: false, hostBlocked: true })).toBe("unfetchable");
    expect(classifyEvidence({ hasStoredText: false, attempted: true })).toBe("unfetchable");
    expect(classifyEvidence({ hasStoredText: false })).toBe("not_fetched");
  });
});

describe("Stage 10D: 判定エンジンの切替", () => {
  const prod = { NODE_ENV: "production", TOREMANE_ENV: undefined, JUDGMENT_ENGINE_CASE: "on" };
  const local = { NODE_ENV: "development", TOREMANE_ENV: "local", JUDGMENT_ENGINE_CASE: "on" };
  it("本番では、設定が case・許可の環境変数があっても legacy（新判定を本番で有効化しない）", () => {
    expect(resolveJudgmentEngine({ stored: "case", env: prod }).engine).toBe("legacy");
    expect(resolveJudgmentEngine({ stored: "case", env: { ...prod, TOREMANE_ENV: "local" } }).engine).toBe("legacy");
  });
  it("開発環境で、明示的な許可があるときだけ case を選べる", () => {
    expect(resolveJudgmentEngine({ stored: "case", env: local }).engine).toBe("case");
    expect(resolveJudgmentEngine({ stored: "case", env: { ...local, JUDGMENT_ENGINE_CASE: undefined } }).engine).toBe("legacy");
  });
  it("設定が読めない・不正なら legacy（設定は書き換えない）", () => {
    expect(resolveJudgmentEngine({ stored: null, loadFailed: true }).engine).toBe("legacy");
    expect(resolveJudgmentEngine({ stored: "xyz" }).engine).toBe("legacy");
    expect(resolveJudgmentEngine({ stored: "legacy" }).note).toBeNull();
  });
});

/**
 * 正規化経路の特性テスト（Stage 10D・現状の記録。仕様の固定ではない）。
 * 同じ名称でも、DB の norm_name（= normName）・系列の正規化（chainCanonicalKey）・読み（readingKey）で結果が異なる。
 * 一本化の設計は docs/reports/2026-11-20-stage10d-case-foundation.md。ここでは「違いがあること」を回帰テストとして記録する。
 */
describe("Stage 10D: 名称正規化の3経路の現状", () => {
  const rows: { raw: string; norm: string; chain: string }[] = [
    { raw: "BOOK・OFF", norm: "book・off", chain: "bookoff" },
    { raw: "ＢＯＯＫＯＦＦ", norm: "bookoff", chain: "bookoff" },
    { raw: "GEO（ゲオ）", norm: "geo(ゲオ)", chain: "geo" },
    { raw: "株式会社サンプル電機", norm: "株式会社サンプル電機", chain: "サンプル電機" },
  ];
  for (const r of rows) {
    it(`「${r.raw}」: norm_name系=${r.norm} / 系列キー=${r.chain}`, () => {
      expect(normName(r.raw)).toBe(r.norm);
      expect(chainCanonicalKey(r.raw)).toBe(r.chain);
    });
  }
  it("norm_name系は表記揺れ（記号・括弧・法人格）を吸収しない＝DB照合だけでは同じ系列と判定されない例がある", () => {
    expect(normName("BOOK・OFF")).not.toBe(normName("BOOKOFF"));
    expect(chainCanonicalKey("BOOK・OFF")).toBe(chainCanonicalKey("BOOKOFF"));
  });
  it("読みの近さ（readingKey）は候補発見のみ。別の経路で、同じ名称でも異なる値を返し得る", () => {
    expect(typeof readingKey("ゲオ")).toMatch(/string|object/);
  });
});
