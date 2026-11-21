/**
 * 統合AI判断の、判断履歴（case_judgments）との接続（Stage 10E・サーバー側）。読み取りと追記のみ。
 *  - 過去の判断を、案件・抽選・原文のハッシュで検索して、次の判断の入力へ戻す（保存だけで終わらせない）。
 *  - 追記は10Dの `recordJudgment`（伏せ字・切り詰め・追記のみ）。
 * どちらも通常収集・画面からはまだ呼ばれない（10F）。
 */
import { searchJudgments, recordJudgment } from "@/lib/server/case-foundation";
import type { Db } from "@/lib/server/lottery-service";
import type { HistorySource } from "@/lib/judgment/build-input";
import type { PriorJudgment } from "@/lib/judgment/contract";
import type { JudgmentSink } from "@/lib/judgment/engine";

type Row = Record<string, unknown>;
const toPrior = (r: Row): PriorJudgment => ({
  id: String(r.id),
  kind: String(r.kind),
  subject: String(r.subject ?? ""),
  claimBasis: (r.claim_basis as PriorJudgment["claimBasis"]) ?? "unknown",
  value: String(r.value ?? ""),
  judgeKind: (r.judge_kind as PriorJudgment["judgeKind"]) ?? "fixed",
  correctionOf: (r.correction_of as string | null) ?? null,
  at: String(r.created_at ?? ""),
});

export function historyFromDb(db: Db, householdId: string): HistorySource {
  return {
    async search(q) {
      const per = Math.max(5, Math.ceil(q.limit / 3));
      const batches: Row[][] = [];
      if (q.caseId) batches.push(await searchJudgments(db, { householdId, caseId: q.caseId, limit: per }));
      for (const id of q.lotteryIds.slice(0, 8)) batches.push(await searchJudgments(db, { householdId, lotteryId: id, limit: per }));
      for (const h of q.evidenceHashes.slice(0, 8)) batches.push(await searchJudgments(db, { householdId, evidenceHash: h, limit: per }));
      const seen = new Map<string, Row>();
      for (const r of batches.flat()) seen.set(String(r.id), r);
      return [...seen.values()].map(toPrior);
    },
  };
}

export const sinkToDb = (db: Db): JudgmentSink => (r) => recordJudgment(db, r);
