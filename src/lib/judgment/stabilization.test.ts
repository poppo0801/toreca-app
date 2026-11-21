/**
 * Stage 10E r3 安定化の回帰テスト（K07 products形式 / K04 構造ラベル / K09 採点）。**台本・架空データのみ。実AIの精度改善の証明ではない**。
 * 形式エラーは自動補正して受理せず、理由（受け取った型と正しい形）を返して再判断させる。
 */
import { describe, expect, it } from "vitest";
import { parseJudgmentOutput, type JudgmentOutput } from "./contract";
import { mockHoldout } from "./eval/mock-answers-holdout";
import { mockUnseen } from "./eval/mock-answers-unseen";
import { loadGold, scoreCase } from "./eval/replay";
import { JUDGMENT_PROMPT_VERSION, JUDGMENT_SYSTEM } from "./prompt";
import { verifyJudgment } from "./verify";
import { inputFor, loadCases } from "./eval/replay";

const clone = <T,>(x: T): T => JSON.parse(JSON.stringify(x));
const ugold = loadGold("unseen");

describe("K07: products の形式エラーを、具体的に差し戻す（自動補正しない）", () => {
  const base = () => clone(mockUnseen("K07")) as Record<string, unknown>;
  const withProducts = (v: unknown) => {
    const o = base() as { opportunities: Record<string, unknown>[] };
    o.opportunities[0].products = v;
    return o;
  };
  it("正しい形（value配列・basis・citations）は通る", () => {
    expect(parseJudgmentOutput(base()).ok).toBe(true);
  });
  it("商品の配列を直接入れた誤出力・文字列・null は拒否され、受け取った型と正しい形の例が返る。補正して受理しない", () => {
    for (const [v, got] of [[["ダミー拡張A"], "配列"], ["ダミー拡張A", "文字列"], [null, "null"]] as const) {
      const r = parseJudgmentOutput(withProducts(v));
      expect(r.ok).toBe(false);
      if (!r.ok) {
        const m = r.errors.join("|");
        expect(m).toContain("opportunities[0].products");
        expect(m).toContain(`受け取った型: ${got}`);
        expect(m).toContain('"value"');
        expect(m).toContain("文字列の配列");
      }
    }
  });
  it("value が配列でない・空配列の書き方・不正な basis の同型エラーも拒否する（空配列＋unknown は受理）", () => {
    expect(parseJudgmentOutput(withProducts({ value: "ダミー拡張A", basis: "fact", citations: [] })).ok).toBe(false);
    expect(parseJudgmentOutput(withProducts({ value: [], basis: "unknown", citations: [] })).ok).toBe(true);
    expect(parseJudgmentOutput(withProducts({ value: ["A"], basis: "確実", citations: [] })).ok).toBe(false);
  });
  it("relations の形式エラーは、不足・不正な項目名を返す", () => {
    const o = base() as { relations: Record<string, unknown>[] };
    o.relations = [{ opportunityKey: "O1", lotteryId: "L-K07-A", relation: "same" }];
    const r = parseJudgmentOutput(o);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      const m = r.errors.join("|");
      expect(m).toContain("basis");
      expect(m).toContain("rationale");
    }
  });
  it("プロンプトに products の具体例があり、版が更新されている（r4）", () => {
    expect(JUDGMENT_PROMPT_VERSION).toBe("10h.2");
    expect(JUDGMENT_SYSTEM).toContain('"value":["商品名A"]');
    expect(JUDGMENT_SYSTEM).toContain("商品名の配列だけ");
  });
});

describe("K04: per_product と multi_independent_per_submit の使い分け（統合しない・互換維持）", () => {
  it("定義は応募の操作（送信）の単位で区別し、どちらも機会は独立権利ごとに分ける。送信単位が不明なら per_product＋inference", () => {
    for (const w of ["応募の操作（送信）の単位", "別々の応募の操作", "1回の送信（1つのフォーム）で複数の商品へ同時に応募", "送信が1回か複数回かが読み取れないときは per_product"]) expect(JUDGMENT_SYSTEM).toContain(w);
  });
  it("両方のラベルが契約に残り（保存済みの判断履歴・契約互換）、どちらも機会2件の出力が検証を通る", async () => {
    const { now, cases } = loadCases("unseen");
    const input = await inputFor(cases.find((c) => c.id === "K04")!, now);
    const a = clone(mockUnseen("K04")) as JudgmentOutput; // multi_independent_per_submit
    expect(a.structure.kind).toBe("multi_independent_per_submit");
    const b = clone(a);
    b.structure.kind = "per_product";
    for (const o of [a, b]) {
      expect(parseJudgmentOutput(o).ok).toBe(true);
      expect(verifyJudgment(input, o).map((v) => v.code)).not.toContain("structure_incomplete");
    }
    // 両ラベルとも、独立した複数の権利を1つの機会にまとめていれば不整合（機会の分け方は同じ。違いは送信の単位だけ）
    for (const kind of ["per_product", "multi_independent_per_submit"] as const) {
      const c = clone(a);
      c.structure.kind = kind;
      const merged = c.opportunities[0];
      merged.products = { ...merged.products!, value: c.opportunities.flatMap((x) => x.products?.value ?? []) };
      c.opportunities = [merged];
      expect(verifyJudgment(input, c).map((v) => v.code), kind).toContain("structure_incomplete");
    }
  });
  it("K04 の採点は、機会数・日付が正解なら構造ラベルの違いを機会の誤りとして数えない（構造ラベルの正誤は構造の指標として別に記録）", () => {
    const b = clone(mockUnseen("K04")) as JudgmentOutput;
    b.structure.kind = "per_product";
    const s = scoreCase("K04", ugold.K04, b);
    expect(s.countOk).toBe(true);
    expect(s.structureOk).toBe(false);
    expect(s.falseMerge + s.falseSplit).toBe(0);
  });
});

describe("K09: 関係は（応募機会 × 既存カード）の組み合わせ単位で採点する", () => {
  const rel = (key: string, relation: string) => ({ opportunityKey: key, lotteryId: "L-K09-A", relation, basis: "inference", citations: [], rationale: "テスト" });
  const withRels = (rels: ReturnType<typeof rel>[]) => {
    const o = clone(mockUnseen("K09")) as JudgmentOutput;
    o.relations = rels as never;
    return o;
  };
  it("第1回=same・第2回=same_campaign_other が同時に成り立つのは、誤分割にも誤統合にもしない（実AI出力の再現）", () => {
    const s = scoreCase("K09", ugold.K09, withRels([rel("O1", "same"), rel("O2", "same_campaign_other")]));
    expect([s.falseSplit, s.falseMerge, s.relCorrect, s.relScored]).toEqual([0, 0, 1, 1]);
  });
  it("逆パターン: 同一の権利を別扱い（sameが無く別扱いのみ）は誤分割として検出され続ける", () => {
    const s = scoreCase("K09", ugold.K09, withRels([rel("O1", "same_campaign_other"), rel("O2", "independent")]));
    expect(s.falseSplit).toBe(2);
    expect(s.relCorrect).toBe(0);
  });
  it("逆パターン: 異なる権利（第1回と第2回）を、同じ1枚のカードに両方 same とした誤統合は検出される", () => {
    const s = scoreCase("K09", ugold.K09, withRels([rel("O1", "same"), rel("O2", "same")]));
    expect(s.falseMerge).toBe(1);
    expect(s.falseSplit).toBe(0);
  });
  it("正解が same 以外のカードに same と判断した機会ごとに誤統合。正解 same_campaign_other に independent は誤分割", () => {
    const g = { verifiable: true, relations: { "L-X": "same_campaign_other" } } as never;
    const o = clone(mockUnseen("K09")) as JudgmentOutput;
    o.relations = [{ ...rel("O1", "same"), lotteryId: "L-X" }, { ...rel("O2", "independent"), lotteryId: "L-X" }] as never;
    const s = scoreCase("X", g, o);
    expect([s.falseMerge, s.falseSplit]).toEqual([1, 1]);
  });
  it("未出力・unknown は誤統合・誤分割に数えない（従来どおり。関係の一致だけが不一致）", () => {
    const s = scoreCase("K09", ugold.K09, withRels([rel("O1", "unknown")]));
    expect([s.falseMerge, s.falseSplit, s.relCorrect]).toEqual([0, 0, 0]);
  });
  it("既存の正解データ（旧19件・新12件）の関係と件数は変えていない（採点規則の変更で gold を触らない）", () => {
    expect(ugold.K09.relations).toEqual({ "L-K09-A": "same" });
    expect(ugold.K09.opportunityCount).toBe(2);
    expect(ugold.K03.relations).toEqual({ "L-K03-A": "same_campaign_other" });
  });
});

describe("新しい独立ホールドアウト H01〜H06（正解は先に固定・入力と分離。実AI評価は未実施）", () => {
  const hc = loadCases("holdout");
  const hg = loadGold("holdout");
  it("6件の入力と正解が別ファイルにあり、入力に正解の項目が含まれず、プロンプトに事例の語が漏れていない", async () => {
    expect(hc.cases.length).toBe(6);
    expect(Object.keys(hg).length).toBe(6);
    for (const c of hc.cases) {
      const s = JSON.stringify(await inputFor(c, hc.now));
      for (const k of ["opportunityCount", "structureHold", "mustNotChange", "\"gold\"", "verifiable"]) expect(s, `${c.id}:${k}`).not.toContain(k);
      for (const w of [c.id, "試作カード", "試作ボックス", "試作パック"]) expect(JUDGMENT_SYSTEM, w).not.toContain(w);
    }
  });
  it("台本の答えは検証を通り、採点が正解と一致し、誤統合・誤分割・保護違反が0（経路の検査。実AI精度ではない）", async () => {
    for (const c of hc.cases) {
      const raw = mockHoldout(c.id);
      const p = parseJudgmentOutput(raw);
      expect(p.ok, c.id).toBe(true);
      if (!p.ok) continue;
      expect(verifyJudgment(await inputFor(c, hc.now), p.output), c.id).toEqual([]);
      const s = scoreCase(c.id, hg[c.id], p.output);
      expect([s.structureOk, s.countOk, s.falseMerge, s.falseSplit, s.mustNotChangeViolations], c.id).toEqual([true, true, 0, 0, 0]);
      expect(s.relCorrect, c.id).toBe(s.relScored);
    }
  });
});
