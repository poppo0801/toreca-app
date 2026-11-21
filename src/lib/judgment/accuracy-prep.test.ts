/**
 * Stage 10E 精度改善（J01・J13の判断ミス）の回帰テスト。**台本のモデル（test double）による検査であり、実AIの精度の証明ではない**。
 * 未見ケース K01〜K12 の正解は、モデル入力・採点器の変更より先に固定（コミット済み）。旧19件だけに合わせた改善でないことを、
 * 類似・逆パターン・境界のケースで確認する。検証層は**機会・関係を自動で補正せず**、理由を返して再判断を求め、直らなければ保留する。
 */
import { describe, expect, it } from "vitest";
import { BudgetPools } from "./budget";
import type { JudgmentOutput } from "./contract";
import { judgeCase } from "./engine";
import { mockAnswer } from "./eval/mock-answers";
import { mockUnseen } from "./eval/mock-answers-unseen";
import { inputFor, loadCases, loadGold, scoreCase } from "./eval/replay";
import { ScriptedModel } from "./model";
import { JUDGMENT_SYSTEM } from "./prompt";
import { verifyJudgment } from "./verify";

const NOW = "2099-01-20T00:00:00.000Z";
const unseen = loadCases("unseen");
const ugold = loadGold("unseen");
const main = loadCases("main");
const clone = <T,>(x: T): T => JSON.parse(JSON.stringify(x));
const pools = () => new BudgetPools({ judgment: 100, investigation: 100, discovery: 100 });
const uin = async (id: string) => inputFor(unseen.cases.find((c) => c.id === id)!, NOW);
const codes = (vs: { code: string }[]) => vs.map((v) => v.code);

describe("未見ケース K01〜K12（正解は先に固定・入力と分離）", () => {
  it("12件の入力と正解が別ファイルにあり、入力に正解の項目が含まれない", async () => {
    expect(unseen.cases.length).toBe(12);
    expect(Object.keys(ugold).length).toBe(12);
    for (const c of unseen.cases) {
      const s = JSON.stringify(await inputFor(c, NOW));
      for (const k of ["opportunityCount", "structureHold", "mustNotChange", "\"gold\"", "verifiable", "relations\":{\"L-"]) expect(s, `${c.id}:${k}`).not.toContain(k);
    }
  });
  it("類似・逆パターン・境界を含む（店舗選択×既存カード／店舗別独立／選択肢外の店舗／2商品独立／1つを選ぶ／セット／商品別／独立性不明／開催回／混在／別開催回／取得不能）", () => {
    const issues = Object.values(ugold).map((g) => g.issue).join("|");
    for (const w of ["店舗選択式", "店舗別独立", "選択肢に含まれない", "1送信で複数", "1つを選ぶ", "セットで1つ", "商品別独立", "保留", "2開催回", "別の開催回", "取得不能"]) expect(issues, w).toContain(w);
  });
  it("理想の答え（台本）は検証を通り、採点が正解と一致する。誤統合・誤分割・根拠なしの断定・保護違反が0（経路の検査）", async () => {
    let fm = 0, fs = 0, uf = 0, mnc = 0;
    for (const c of unseen.cases) {
      const input = await inputFor(c, NOW);
      const model = new ScriptedModel((i) => ({ raw: mockUnseen(c.id), costJpy: 0.1 }));
      const r = await judgeCase({ model, budget: pools() }, input);
      expect(r.status, `${c.id}: ${JSON.stringify(r.violations)}`).toBe("accepted");
      const s = scoreCase(c.id, ugold[c.id], r.output);
      if (s.verifiable) {
        expect(s.structureOk, c.id).not.toBe(false);
        expect(s.countOk, c.id).not.toBe(false);
        expect(Object.values(s.fieldsOk).every(Boolean), c.id).toBe(true);
        expect(s.relCorrect, c.id).toBe(s.relScored);
      }
      fm += s.falseMerge; fs += s.falseSplit; uf += s.unsupportedFacts; mnc += s.mustNotChangeViolations;
    }
    expect([fm, fs, uf, mnc]).toEqual([0, 0, 0, 0]);
  });
});

describe("J01型: 店舗選択式の選択肢にある店舗の既存カードを『別の機会』とする矛盾", () => {
  it("J01・K01・K10 の誤った出力は不合格になり、理由（選択肢に含まれる・別の根拠を示すか同一に見直す）が返る。出力は自動では直されない", async () => {
    for (const id of ["K01", "K10"]) {
      const input = await uin(id);
      const bad = mockUnseen(id, true) as JudgmentOutput;
      const before = JSON.stringify(bad);
      const vs = verifyJudgment(input, bad);
      expect(codes(vs), id).toContain("relation_contradicts_structure");
      expect(vs.find((v) => v.code === "relation_contradicts_structure")!.message).toContain("選択肢に含まれて");
      expect(JSON.stringify(bad), "検証は出力を書き換えない").toBe(before);
    }
  });
  it("正しい関係（選択肢内=same・選択肢外=same_campaign_other・別開催回・別店舗）は不合格にならない（過剰に止めない）", async () => {
    for (const id of ["K01", "K03", "K10", "K11", "K02", "K09"]) expect(codes(verifyJudgment(await uin(id), mockUnseen(id) as JudgmentOutput)), id).toEqual([]);
  });
  it("旧J01の入力でも同様。判断が直らない（再判断でも同じ誤り）なら、その関係は採用されず、既存の抽選に変更は及ばない", async () => {
    const c = main.cases.find((x) => x.id === "J01")!;
    const input = await inputFor(c, NOW);
    const good = mockAnswer("J01", input) as JudgmentOutput;
    const wrong = clone(good);
    wrong.relations.forEach((r) => (r.relation = "same_campaign_other"));
    expect(codes(verifyJudgment(input, wrong))).toContain("relation_contradicts_structure");
    const model = new ScriptedModel(() => ({ raw: wrong, costJpy: 0.1 }));
    const r = await judgeCase({ model, budget: pools() }, input);
    expect(model.calls).toBe(3);
    expect(r.status).toBe("partial");
    expect(r.output!.relations).toEqual([]); // 誤った関係は採用しない（別の関係を作らない）
    expect(r.output!.plannedChanges.filter((p) => p.lotteryId === "L-J01-B").every((p) => p.op === "link_case")).toBe(true); // 保護された既存抽選には関連づけのみ
  });
  it("再判断で直れば採用される（検証の理由が次の入力に渡る）", async () => {
    const c = main.cases.find((x) => x.id === "J01")!;
    const input = await inputFor(c, NOW);
    const good = mockAnswer("J01", input) as JudgmentOutput;
    const wrong = clone(good);
    wrong.relations.forEach((r) => (r.relation = "same_campaign_other"));
    const seen: (string[] | undefined)[] = [];
    const model = new ScriptedModel((i, n) => { seen.push(i.feedback); return { raw: n === 0 ? wrong : good, costJpy: 0.1 }; });
    const r = await judgeCase({ model, budget: pools() }, input);
    expect(r.status).toBe("accepted");
    expect(seen[1]?.join(" ")).toContain("選択肢に含まれて");
  });
  it("根拠のない same は不合格（同じ系列・商品というだけで同一と断定しない）", async () => {
    const input = await uin("K01");
    const out = clone(mockUnseen("K01") as JudgmentOutput);
    out.relations[0].citations = [];
    out.relations[0].basis = "inference";
    expect(codes(verifyJudgment(input, out))).toContain("relation_same_without_evidence");
  });
});

describe("J13型: 複数の独立した権利を示す構造なのに、機会を1つにまとめる不整合", () => {
  it("K04（1送信で2商品）・旧J13 の誤った出力は不合格になり、理由が返る。自動で分割・補正されない", async () => {
    const bad = mockUnseen("K04", true) as JudgmentOutput;
    const input = await uin("K04");
    const before = JSON.stringify(bad);
    const vs = verifyJudgment(input, bad);
    expect(codes(vs)).toContain("structure_incomplete");
    expect(vs.find((v) => v.code === "structure_incomplete")!.message).toContain("分けて");
    expect(JSON.stringify(bad)).toBe(before);
    const c13 = main.cases.find((x) => x.id === "J13")!;
    const i13 = await inputFor(c13, NOW);
    const g13 = mockAnswer("J13", i13) as JudgmentOutput;
    const w13 = clone(g13);
    w13.opportunities = [{ ...w13.opportunities[0], products: { value: ["商品デルタ", "商品イプシロン", "商品ゼータ"], basis: "fact", citations: g13.opportunities[0].products!.citations } }];
    expect(codes(verifyJudgment(i13, w13))).toContain("structure_incomplete");
  });
  it("商品別独立（K07）で、機会が商品数より少ない出力も不合格。正しい出力は通る", async () => {
    const input = await uin("K07");
    const ok = mockUnseen("K07") as JudgmentOutput;
    expect(codes(verifyJudgment(input, ok))).toEqual([]);
    const bad = clone(ok);
    bad.opportunities = [{ ...bad.opportunities[0], label: "3商品まとめ", products: { value: ["ダミー拡張A", "ダミー拡張B", "ダミー拡張C"], basis: "fact", citations: bad.opportunities[0].products!.citations } }]; // 商品を1つの機会にまとめて並べた
    expect(codes(verifyJudgment(input, bad))).toContain("structure_incomplete");
  });
  it("逆パターン（K05 1つを選ぶ・K06 セットで1つ・J14）は、商品が複数でも機会1つで合格する（商品数から機会を増やさない）", async () => {
    for (const id of ["K05", "K06"]) expect(codes(verifyJudgment(await uin(id), mockUnseen(id) as JudgmentOutput)), id).toEqual([]);
    const c = main.cases.find((x) => x.id === "J14")!;
    const i = await inputFor(c, NOW);
    expect(codes(verifyJudgment(i, mockAnswer("J14", i) as JudgmentOutput))).toEqual([]);
  });
  it("独立性が不明（K08）は保留（unknown・機会1）で合格し、機会を増やさない。増やした出力は既存の検査で不合格", async () => {
    const input = await uin("K08");
    expect(codes(verifyJudgment(input, mockUnseen("K08") as JudgmentOutput))).toEqual([]);
    const multi = clone(mockUnseen("K08") as JudgmentOutput);
    multi.opportunities = [multi.opportunities[0], { ...multi.opportunities[0], key: "O2" }];
    expect(codes(verifyJudgment(input, multi))).toContain("structure_multiplies");
  });
  it("誤った出力が再判断でも直らなければ、構造は unknown（保留）・機会は1件にまとめて未確定として扱う（誤った権利の分割を作らない・履歴は変えない）", async () => {
    const input = await uin("K04");
    const bad = mockUnseen("K04", true);
    const model = new ScriptedModel(() => ({ raw: bad, costJpy: 0.1 }));
    const r = await judgeCase({ model, budget: pools() }, input);
    expect(model.calls).toBe(3);
    expect(r.status).toBe("partial");
    expect(r.output!.structure.kind).toBe("unknown");
    expect(r.output!.opportunities.length).toBe(1);
    expect(r.dropped).toContain("structure");
  });
  it("再判断で直れば（機会を分ければ）採用される", async () => {
    const input = await uin("K04");
    const model = new ScriptedModel((i, n) => ({ raw: mockUnseen("K04", n === 0), costJpy: 0.1 }));
    const r = await judgeCase({ model, budget: pools() }, input);
    expect(r.status).toBe("accepted");
    expect(r.output!.opportunities.length).toBe(2);
  });
});

describe("プロンプト: 応募機会・関係の定義が汎用的に明文化され、事例固有の文言を含まない", () => {
  it("権利の単位・same と same_campaign_other の意味・same の根拠要件・出力の整合が書かれている", () => {
    for (const w of ["独立して、応募・当落・購入の可否を別々に追跡できる権利の単位", "same = ", "same_campaign_other = ", "同じ1つの応募権", "引用", "opportunities の数と各機会の内容"]) expect(JUDGMENT_SYSTEM, w).toContain(w);
  });
  it("評価事例のID・店舗名・商品名・ケース固有の語をハードコードしていない", () => {
    const names = [...main.cases, ...unseen.cases].flatMap((c) => [c.id, ...c.related.map((r) => r.lotteryId)]);
    for (const n of names) expect(JUDGMENT_SYSTEM, n).not.toContain(n);
    for (const w of ["サンプル電機", "サンプルゲーム", "渋谷店", "テストの夜明け", "ダミー", "デルタ", "L-J", "L-K"]) expect(JUDGMENT_SYSTEM, w).not.toContain(w);
  });
});

describe("回帰: 保護・費用・既存の評価", () => {
  it("J21（per_round・機会1）は不合格にならない（曖昧さのある正解は事後変更しない。注記を維持）", async () => {
    const gold = JSON.parse((await import("node:fs")).readFileSync("eval/judgment-10e/gold/gold.json", "utf8")).gold;
    expect(gold.J21.structure).toBe("one_form_one"); // 正解は変更していない（AIの per_round は妥当な解釈。注記は報告書）
    const c = main.cases.find((x) => x.id === "J21")!;
    const i = await inputFor(c, NOW);
    const per = clone(mockAnswer("J21", i) as JudgmentOutput);
    per.structure.kind = "per_round";
    expect(codes(verifyJudgment(i, per))).toEqual([]);
  });
  it("旧19件の台本の答えはすべて、新しい検証層でも不合格にならない（過剰な不合格・回帰なし）", async () => {
    const gold = loadGold("main");
    for (const c of main.cases.filter((x) => gold[x.id] && !["J04", "J05"].includes(x.id))) {
      const i = await inputFor(c, NOW);
      expect(codes(verifyJudgment(i, mockAnswer(c.id, i) as JudgmentOutput)), c.id).toEqual([]);
    }
  });
});
