// @vitest-environment node
// 9H-3M: 過剰適合の確認。新しい判断ロジックは 9H-3K の12件を見て設計した。そのため、設計に使っていない過去の人間評価（9F-2〜9H-3I）で、
// 店舗選択式の「判定漏れ」と「誤判定（選択不要なのに選択式）」を別々に数える。費用0（保存済みの評価だけを使う。AI・ネットワークに触れない）。
// BUILD_9H3M=1 のときだけ実行。結果は backups/review-ledger/overfit-9h3m.json
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { judgeForm } from "@/lib/lottery-form";
import { inferWithStructure } from "./apply-structure";
import { buildHumanKnowledge } from "./human-knowledge";
import { tendencyFor } from "./form-inference";
import { ingestAnswers, type AnswerFile, type AnswerRow } from "./review-ingest";

const RUN = process.env.BUILD_9H3M === "1";
type Ex = Record<string, string | null | undefined> & { products?: string[] };

describe.skipIf(!RUN)("過去の人間評価での店舗選択式の判定漏れ・誤判定（設計に使っていない評価）", () => {
  it("集計する", () => {
    const dir = "backups/review-answers";
    const files = readdirSync(dir).filter((n) => n.endsWith(".json")).map((n) => ({ n, a: JSON.parse(readFileSync(`${dir}/${n}`, "utf8")) as AnswerFile & { results: AnswerRow[] } }));
    const perSet: Record<string, Record<string, number>> = {};
    const detail: Record<string, unknown>[] = [];
    for (const { a } of files) {
      const setId = a.setId ?? "?";
      const heldOut = !setId.startsWith("rs-9h3k"); // 9H-3K は設計に使ったので別集計
      const cases = ingestAnswers(a);
      const others = files.filter((f) => f.a !== a).map((f) => f.a);
      a.results.forEach((r, i) => {
        const c = cases[i];
        if (c.use !== "gold") return;
        const ex = (r.aiOriginal?.extracted ?? {}) as Ex;
        const humanSelect = c.humanStoreSelect || (c.class === "correct" && ex.lotteryForm === "store_select");
        const texts = [r.source?.title ?? "", String(ex.conditions ?? "")];
        // 本人の評価を含めない実績（本人以外の評価ファイル全部＋同じファイルの他の事例）
        const kn = buildHumanKnowledge([...others, { results: a.results.filter((_, j) => j !== i) }] as never);
        const storeKnown = !!ex.store && !/店舗選択式/.test(String(ex.store));
        const t = tendencyFor({ human: kn, chain: String(ex.chain ?? "") });
        const after = inferWithStructure({ judgement: judgeForm({ storeMode: "fixed", texts }), storeKnown, tendency: t, texts, receiveMethod: ex.receiveMethod ?? null, chainKnown: !!ex.chain });
        const predictedSelect = after.form === "store_select" && (after.state === "estimated" || after.state === "confirmed");
        // 旧方式: AIの抽出した抽選形態が店舗選択式
        const beforeSelect = ex.lotteryForm === "store_select";
        const key = `${setId}${heldOut ? "" : "（設計に使用）"}`;
        const s = (perSet[key] ??= { gold: 0, humanSelect: 0, humanNotSelect: 0, afterMiss: 0, afterFalsePositive: 0, beforeMiss: 0, beforeFalsePositive: 0, structureOnlyEstimated: 0 });
        s.gold++;
        if (humanSelect) {
          s.humanSelect++;
          if (!predictedSelect) s.afterMiss++;
          if (!beforeSelect) s.beforeMiss++;
        } else {
          s.humanNotSelect++;
          if (predictedSelect) {
            s.afterFalsePositive++;
            detail.push({ setId, caseId: c.caseId, chain: ex.chain, store: ex.store, receive: ex.receiveMethod, after: `${after.form}:${after.state}`, signals: after.structure.signals.filter((x) => x.weight > 0).map((x) => x.code), basis: after.basis[0]?.slice(0, 120) });
          }
          if (beforeSelect) s.beforeFalsePositive++;
        }
        if (predictedSelect && after.priorUsed === false) s.structureOnlyEstimated++;
        // 登録の形に反映される（action=apply）判断だけの正誤。誤って反映すると、店舗別の抽選が1件の店舗選択式になる
        if (predictedSelect && after.action === "apply") {
          if (humanSelect) s.applyTrue = (s.applyTrue ?? 0) + 1;
          else s.applyFalse = (s.applyFalse ?? 0) + 1;
        }
        if (predictedSelect && !after.verification.noticeEvidence && !humanSelect) s.priorOnlyFalse = (s.priorOnlyFalse ?? 0) + 1;
      });
    }
    mkdirSync("backups/review-ledger", { recursive: true });
    writeFileSync("backups/review-ledger/overfit-9h3m.json", JSON.stringify({ perSet, falsePositives: detail }, null, 1));
    expect(Object.keys(perSet).length).toBeGreaterThan(0);
  });
});
