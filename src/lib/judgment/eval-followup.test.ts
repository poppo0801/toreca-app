/**
 * Stage 10E 追加修正（B）: 追加した評価事例 J13〜J21 の再生評価。台本のモデル（test double）による経路・安全の検査であり、実AIの精度の証明ではない。
 *  - 誤統合と誤分割を別集計。検証不能（取得不能・会員限定）は正確性の分母に含めない。
 *  - 旧方式との比較は「構造判定だけ」（同じ原文で比較可能）。旧方式全体の抽出・登録結果は未測定（実AIが必要）。
 */
import { describe, expect, it } from "vitest";
import { BudgetPools } from "./budget";
import { judgeCase } from "./engine";
import { mockAnswer } from "./eval/mock-answers";
import { inputFor, legacyStructure, loadCases, loadGold, scoreCase, type CaseScore } from "./eval/replay";
import { ScriptedModel } from "./model";

const NOW = "2099-01-20T00:00:00.000Z";
const { cases } = loadCases();
const gold = loadGold();
const NEW_IDS = ["J13", "J14", "J15", "J16", "J17", "J18", "J19", "J20", "J21"];
const pools = () => new BudgetPools({ judgment: 100, investigation: 100, discovery: 100 });

async function run(id: string) {
  const c = cases.find((x) => x.id === id)!;
  const input = await inputFor(c, NOW);
  const model = new ScriptedModel((i) => ({ raw: mockAnswer(id, i), costJpy: 0.3 }));
  const r = await judgeCase({ model, budget: pools() }, input);
  return { c, input, r };
}

describe("追加事例 J13〜J21", () => {
  it("12事例は維持され、追加9事例の入力と正解が別ファイルに存在する（合計21）", () => {
    expect(cases.length).toBe(21);
    expect(Object.keys(gold).length).toBe(21);
    for (const id of NEW_IDS) {
      expect(cases.some((c) => c.id === id), id).toBe(true);
      expect(gold[id], id).toBeTruthy();
    }
    for (let n = 1; n <= 12; n++) expect(cases.some((c) => c.id === `J${String(n).padStart(2, "0")}`)).toBe(true);
  });
  it("入力に、正解（gold）の構造名・件数・関係・期待語を示す項目が含まれない", async () => {
    for (const id of NEW_IDS) {
      const { input } = await run(id);
      const s = JSON.stringify(input);
      for (const k of ["opportunityCount", "afterInvestigation", "mustNotChange", "conditionsMention", "storeMustNotBeAsserted", "verifiable", "\"gold\""]) expect(s, `${id}:${k}`).not.toContain(k);
    }
  });
  it("全て検証を通り、誤統合・根拠なしのfact・保護された抽選への破壊的変更が0。構造・件数・締切が正解どおり", async () => {
    const scores: CaseScore[] = [];
    for (const id of NEW_IDS) {
      const { r } = await run(id);
      expect(r.status, `${id}: ${JSON.stringify(r.violations)}`).toBe("accepted");
      scores.push(scoreCase(id, gold[id], r.output));
    }
    expect(scores.reduce((s, x) => s + x.falseMerge, 0)).toBe(0);
    expect(scores.reduce((s, x) => s + x.falseSplit, 0)).toBe(0);
    expect(scores.reduce((s, x) => s + x.unsupportedFacts, 0)).toBe(0);
    expect(scores.reduce((s, x) => s + x.mustNotChangeViolations, 0)).toBe(0);
    for (const s of scores) {
      expect(s.structureOk, s.id).not.toBe(false);
      expect(s.countOk, s.id).not.toBe(false);
      expect(Object.values(s.fieldsOk).every(Boolean), s.id).toBe(true);
    }
  });
  it("地域の限定・除外は、応募条件として事実（引用つき）で記録される。利用者の地域に該当するかの判断・除外は、ここでは行わない（固定の前処理の責務）", async () => {
    for (const id of ["J16", "J17"]) {
      const { r, input } = await run(id);
      expect(scoreCase(id, gold[id], r.output).conditionsOk, id).toBe(true);
      expect(input.regionPrefectures.length).toBe(1); // 地域は入力として渡すだけ
      expect(r.output!.opportunities.length).toBe(1); // 地域外でも機会を消さない（絞り込みは別の層）
    }
  });
  it("店舗が未確定の選択式は、店舗を事実として断定せず、未解決（後日発表）として残す", async () => {
    const { r } = await run("J18");
    expect(scoreCase("J18", gold.J18, r.output).storeAsserted).toBe(0);
    expect(r.output!.unresolved.length).toBeGreaterThan(0);
    expect(r.output!.structure.selectableStores ?? []).toEqual([]);
  });
  it("商品が複数でも応募・当選が1つなら機会は1つ（J14）。1送信で独立な権利が複数なら3つ（J13）。開催回別は2つ（J15）。数や形から決めつけない", async () => {
    expect((await run("J14")).r.output!.opportunities.length).toBe(1);
    expect((await run("J13")).r.output!.opportunities.length).toBe(3);
    expect((await run("J15")).r.output!.opportunities.length).toBe(2);
  });
  it("応募済みの抽選（J19〜J21）は変更されず、中止・継続・再開催は別の応募機会として関連づけのみ（誤統合しない）", async () => {
    for (const id of ["J19", "J20", "J21"]) {
      const { r } = await run(id);
      for (const p of r.output!.plannedChanges) expect(p.op, id).toBe("link_case");
    }
    for (const id of ["J20", "J21"]) {
      const { r } = await run(id);
      expect(r.output!.relations.every((x) => x.relation === "same_campaign_other"), id).toBe(true);
    }
  });
  it("【旧方式との比較（構造判定だけ）】同じ原文で、旧の固定判定は 独立な複数機会・開催回別・応募1つ を区別できない（表現できる値は 店舗選択式/店舗別/不明 のみ）", () => {
    for (const id of ["J13", "J15"]) {
      const c = cases.find((x) => x.id === id)!;
      expect(legacyStructure(c), id).not.toBe(gold[id].structure);
    }
    // 旧方式全体の項目抽出・登録結果との比較は、実AI（既存の自動収集の抽出）が必要なため未測定
  });
  it("失敗した検証・取得不能は、正確性の分母から分離される（verifiable=false は構造・件数の採点対象にならない）", () => {
    const unverifiable = Object.entries(gold).filter(([, g]) => !g.verifiable).map(([id]) => id);
    expect(unverifiable.sort()).toEqual(["J08", "J11"]);
    for (const id of unverifiable) expect(scoreCase(id, gold[id], null).structureOk).toBeNull();
  });
});

describe("採点: 日付の一致・機会の誤統合", () => {
  it("日付のみの正解は、時刻つきの値と一致するが、注釈つきの値・別の日付とは一致しない", async () => {
    const { dateMatches } = await import("./eval/replay");
    expect(dateMatches("2099-02-10", "2099-02-10")).toBe(true);
    expect(dateMatches("2099-02-10 23:59", "2099-02-10")).toBe(true);
    expect(dateMatches("2099-02-10T23:59", "2099-02-10")).toBe(true);
    expect(dateMatches("2099-02-10（延長後）", "2099-02-10")).toBe(false);
    expect(dateMatches("2099-02-100", "2099-02-10")).toBe(false);
    expect(dateMatches("2099-02-11", "2099-02-10")).toBe(false);
  });
  it("独立した応募機会を少ない件数にまとめた出力は、機会の誤統合として数える", async () => {
    const { run } = { run: async (id: string) => { const c = cases.find((x) => x.id === id)!; const input = await inputFor(c, NOW); return mockAnswer(id, input) as never; } };
    const out = JSON.parse(JSON.stringify(await run("J13")));
    out.opportunities = out.opportunities.slice(0, 1);
    expect(scoreCase("J13", gold.J13, out).falseMerge).toBe(2);
  });
});
