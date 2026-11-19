import { existsSync, readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { findDuplicateCandidates, findDuplicateMasters } from "./duplicates";
import { planReevaluation } from "./reeval-plan";
import { chainMasters, productMasters, type Snapshot } from "./snapshot";

/**
 * 実データ（本番の読み取り専用の書き出し。backups/masters-9h3s/。Git管理外）の分析。無い環境（CI）ではスキップ。
 * 実行: npx vitest run src/lib/master-identity/snapshot-analysis.test.ts（結果は標準出力。不変条件だけを検証する）
 */
const DIR = "backups/masters-9h3s";
const file = existsSync(DIR) ? readdirSync(DIR).filter((f) => f.startsWith("snapshot-prod")).sort().at(-1) : undefined;
it.skipIf(true)("実データの分析は、書き出しが無い環境ではスキップ", () => {});
if (file) {
  describe("実データ（本番の書き出し）: 一括再評価の計画", () => {
    const snap = JSON.parse(readFileSync(`${DIR}/${file}`, "utf8")) as Snapshot;
    it("計画を作り、保護対象を変更対象にしない（不変条件）", () => {
      const cs = snap.collection_settings[0] as { prefectures?: string[]; include_online?: boolean } | undefined;
      const plan = planReevaluation(snap, { now: new Date(), prefectures: cs?.prefectures ?? [], includeOnline: cs?.include_online ?? true });
      console.log("\n== 再評価の計画", JSON.stringify(plan.summary));
      const managed = new Set(snap.lottery_management.filter((m) => m.is_managed).map((m) => m.lottery_id));
      const apps = new Set(snap.applications.map((a) => a.lottery_id));
      for (const it of plan.items.filter((i) => i.targetType === "lottery" && i.action !== "review")) {
        expect(managed.has(it.targetId)).toBe(false);
        expect(apps.has(it.targetId)).toBe(false);
        const l = snap.lotteries.find((x) => x.id === it.targetId);
        expect(l?.source_kind).toBe("auto");
      }
      // 1つの抽選に提案する処理は1つ
      const per = new Map<string, number>();
      for (const it of plan.items.filter((i) => i.targetType === "lottery" && i.action !== "review")) per.set(it.targetId, (per.get(it.targetId) ?? 0) + 1);
      expect([...per.values()].every((n) => n === 1)).toBe(true);
      // 重複の残す側は、非表示にしない
      for (const it of plan.items.filter((i) => i.action === "archive_duplicate")) expect(plan.items.some((j) => j.targetId === it.proposal.relatedId && j.action !== "review")).toBe(false);
      for (const a of ["archive_duplicate", "archive_expired", "archive_region", "dismiss_candidate", "merge_master"] as const) {
        const rows = plan.items.filter((i) => i.action === a).slice(0, 6);
        console.log(`  [${a}] ${plan.summary.byAction[a]}件`, rows.map((r) => r.proposal.reason).slice(0, 3));
      }
    });
  });
  describe("実データ（本番の書き出し）: 重複マスターの検出", () => {
    const snap = JSON.parse(readFileSync(`${DIR}/${file}`, "utf8")) as Snapshot;
    it("系列・商品の重複を検出し、不変条件（統合先は非表示でない・別の型番を組にしない）を満たす", () => {
      for (const kind of ["chain", "product"] as const) {
        const masters = kind === "chain" ? chainMasters(snap) : productMasters(snap);
        const cs = findDuplicateMasters(kind, masters);
        console.log(`\n== ${kind === "chain" ? "系列" : "商品"} ${masters.length}件（非表示を除く ${masters.filter((m) => !m.archived).length}件）→ 重複の組 ${cs.length}`);
        for (const c of cs) {
          console.log(`  [${c.risk}] 統合先: ${c.keep.name}（参照${c.keep.refs}${c.keep.provisional ? "・仮" : ""}）← ${c.others.map((o) => `${o.master.name}（参照${o.master.refs}${o.master.provisional ? "・仮" : ""}／${o.reason}）`).join(" / ")}`);
          expect(c.keep.archived).toBeFalsy();
          const codes = new Set([c.keep, ...c.others.map((o) => o.master)].map((m) => m.code).filter(Boolean));
          expect(codes.size).toBeLessThanOrEqual(1);
        }
        const cand = findDuplicateCandidates(kind, masters, cs);
        console.log(`  重複の候補（根拠が足りない・追加調査の対象）: ${cand.length}`);
        for (const c of cand) console.log(`    ? ${c.a.name}（参照${c.a.refs}${c.a.provisional ? "・仮" : ""}） ≈ ${c.b.name}（参照${c.b.refs}${c.b.provisional ? "・仮" : ""}）／${c.reason}`);
      }
    });
  });
}
