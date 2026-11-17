// @vitest-environment node
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { judgeForm } from "@/lib/lottery-form";
import { inferWithStructure } from "./apply-structure";
import { buildHumanKnowledge } from "./human-knowledge";
import { tendencyFor } from "./form-inference";
import { classifyAnswer, ingestAnswers, latestGold, mergeLedger, type AnswerFile, type AnswerRow, type Ledger } from "./review-ingest";

const row = (o: Partial<AnswerRow> & { verdict: string | null; gold: boolean }): AnswerRow => ({
  evaluationId: `ev-${o.caseId ?? "x"}`,
  caseId: o.caseId ?? "x",
  aiOriginal: { extracted: { chain: "A" } },
  human: { verdict: o.verdict, usableAsGold: o.gold, corrections: o.human?.corrections ?? [], comment: o.human?.comment ?? "", evaluatedAt: "2026-11-17T00:00:00Z" },
});

describe("人間評価の取り込み（正解・参考・除外の区別）", () => {
  it("正しい・一部修正は正解、判断できないは正解にしない、未評価は正解にしない（修正は参考として保持）", () => {
    expect(classifyAnswer(row({ verdict: "correct", gold: true }))).toEqual({ class: "correct", use: "gold" });
    expect(classifyAnswer(row({ verdict: "partial", gold: true, human: { corrections: [{ field: "lotteryForm", correctValue: "店舗選択式" }] } }))).toEqual({ class: "partial", use: "gold" });
    expect(classifyAnswer(row({ verdict: "unknown", gold: false, human: { comment: "判断不可" } }))).toEqual({ class: "unknown", use: "reference" });
    expect(classifyAnswer(row({ verdict: null, gold: false, human: { corrections: [{ field: "chain", correctValue: "B" }] } }))).toEqual({ class: "unevaluated", use: "reference" });
    expect(classifyAnswer(row({ verdict: "unknown", gold: false }))).toEqual({ class: "unknown", use: "excluded" });
  });
  it("usableAsGold=false は、判定が正しい等でも正解にしない", () => {
    expect(classifyAnswer(row({ verdict: "correct", gold: false, human: { comment: "x" } })).use).not.toBe("gold");
  });
  it("履歴: 冪等に追加し、内容が変わった評価は版として残す（元のAIの出力は書き換えない）", () => {
    const f: AnswerFile = { setId: "rs-1", results: [row({ caseId: "a", verdict: "partial", gold: true, human: { corrections: [{ field: "lotteryForm", correctValue: "店舗選択式" }] } })] };
    const c1 = ingestAnswers(f);
    expect(c1[0].humanStoreSelect).toBe(true);
    const m1 = mergeLedger(null, "rs-1", c1);
    expect(m1.added).toBe(1);
    const m2 = mergeLedger(m1.ledger, "rs-1", ingestAnswers(f));
    expect(m2.unchanged).toBe(1);
    expect(m2.ledger.entries[0].versions).toHaveLength(1);
    const f2: AnswerFile = { setId: "rs-1", results: [row({ caseId: "a", verdict: "correct", gold: true })] };
    const m3 = mergeLedger(m2.ledger, "rs-1", ingestAnswers(f2));
    expect(m3.revised).toBe(1);
    expect(m3.ledger.entries[0].versions).toHaveLength(2);
    expect(latestGold(m3.ledger)[0].class).toBe("correct");
  });
});

// ---- 9H-3K の評価12件での回帰検証（BUILD_9H3M=1 のときだけ。評価ファイルは backups/ にあり、Gitに含めない）
const RUN = process.env.BUILD_9H3M === "1";
describe.skipIf(!RUN)("9H-3K 人間評価12件の取り込みと回帰検証（修正前後）", () => {
  it("ledger を保存し、店舗選択式の修正前後を比べる", () => {
    const dir = "backups/review-answers";
    const file = readdirSync(dir).filter((n) => n.startsWith("review-answers-rs-9h3k-")).sort().at(-1)!;
    const a = JSON.parse(readFileSync(`${dir}/${file}`, "utf8")) as AnswerFile & { results: AnswerRow[] };
    const cases = ingestAnswers(a);
    const ledgerPath = "backups/review-ledger/ledger.json";
    mkdirSync("backups/review-ledger", { recursive: true });
    const prev: Ledger | null = existsSync(ledgerPath) ? JSON.parse(readFileSync(ledgerPath, "utf8")) : null;
    // 評価ファイルが増えても同じ手順で反映できる: フォルダの全評価ファイルを、評価IDで冪等に履歴へ追加する（内容が変わった評価は版として残す）
    let acc: Ledger | null = prev;
    for (const n of readdirSync(dir).filter((x) => x.endsWith(".json")).sort()) {
      const af = JSON.parse(readFileSync(`${dir}/${n}`, "utf8")) as AnswerFile;
      acc = mergeLedger(acc, af.setId ?? "", ingestAnswers(af)).ledger;
    }
    const m = mergeLedger(acc, a.setId ?? "", cases);
    writeFileSync(ledgerPath, JSON.stringify(m.ledger, null, 1));

    const counts = { gold: 0, reference: 0, excluded: 0 } as Record<string, number>;
    for (const c of cases) counts[c.use]++;
    const rows = a.results.map((r, i) => {
      const c = cases[i];
      const ex = (r.aiOriginal?.extracted ?? {}) as Record<string, string | null>;
      const storeKnown = !!ex.store && !/店舗選択式/.test(ex.store);
      const texts = [r.source?.title ?? "", String(ex.conditions ?? "")];
      const others: AnswerFile = { results: a.results.filter((_, j) => j !== i) };
      // 評価した本人の事例を除いた評価だけから実績を作る（その事例の答えを使わない）
      const tendency = tendencyFor({ human: buildHumanKnowledge([others] as never), chain: String(ex.chain ?? "") });
      const after = inferWithStructure({ judgement: judgeForm({ storeMode: "fixed", texts }), storeKnown, tendency, texts, receiveMethod: ex.receiveMethod ?? null, chainKnown: !!ex.chain, aiUnit: undefined });
      // 反映の確認: 本人の評価を含めて学習した後の判定（検証ではなく、学習が働くことの確認）
      const learnedT = tendencyFor({ human: buildHumanKnowledge([a] as never), chain: String(ex.chain ?? "") });
      const learned = inferWithStructure({ judgement: judgeForm({ storeMode: "fixed", texts }), storeKnown, tendency: learnedT, texts, receiveMethod: ex.receiveMethod ?? null, chainKnown: !!ex.chain });
      const fj = r.aiOriginal?.formJudgment as { state?: string; form?: string } | null | undefined;
      const before = fj && fj.state && fj.state !== "unknown" ? `${fj.form}:${fj.state}` : "不明";
      return { caseId: c.caseId, class: c.class, use: c.use, human: c.use === "gold" ? (c.humanStoreSelect || (ex.lotteryForm === "store_select" && c.class === "correct") ? "店舗選択式" : "選択不要（訂正なし）") : c.humanStoreSelect ? "店舗選択式（参考）" : "-", before, after: `${after.form}:${after.state}`, learned: `${learned.form}:${learned.state}`, need: after.structure.storeSelectNeed, structure: after.structure.structure };
    });
    writeFileSync("backups/review-ledger/regression-9h3k.json", JSON.stringify({ counts, ledger: { added: m.added, revised: m.revised, unchanged: m.unchanged }, rows }, null, 1));
    console.log(JSON.stringify({ counts, ledger: { added: m.added, revised: m.revised, unchanged: m.unchanged } }));
    console.table(rows);
    expect(cases).toHaveLength(12);
  });
});
