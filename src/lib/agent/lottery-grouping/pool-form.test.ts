// @vitest-environment node
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { findSelectFormCleanup } from "@/lib/agent/lottery-grouping/form-cleanup";
import { worldOf, type LotterySpec, type Scenario } from "@/lib/agent/lottery-grouping/eval-world";
import { judgeForm } from "@/lib/lottery-form";

/**
 * 実収集データ127件（eval/lottery-grouping-real/pool.json・Git管理外）の抽選形態を、構造の記載から判別し直す（固定ロジックのみ・費用なし）。
 * 出力: eval/runs/pool-form-8f6.json（Git管理外。集計は docs/stage8f6.md）。ファイルが無い環境では何もしない。
 */
const POOL = "eval/lottery-grouping-real/pool.json";
interface PoolItem extends LotterySpec { chain: string; text?: string }

describe.skipIf(!existsSync(POOL))("実収集データの抽選形態（8F-6・固定ロジックのみ）", () => {
  const pool = (existsSync(POOL) ? (JSON.parse(readFileSync(POOL, "utf8")).pool as PoolItem[]) : []).map((p) => ({ ...p, qty: p.qty ?? 1 }));
  it("各抽選の形態を判別し、店舗選択式の誤登録の疑い・制限だけの記載を数える", () => {
    const byChain = new Map<string, PoolItem[]>();
    for (const p of pool) byChain.set(p.chain, [...(byChain.get(p.chain) ?? []), p]);
    const counts: Record<string, number> = { store_select: 0, store_independent: 0, other: 0, unknown: 0 };
    const rows: { id: string; chain: string; store: string; storeMode: string; form: string; confidence: string; restriction: boolean; basis: string }[] = [];
    const lotteries = [];
    const evidence = new Map<string, string[]>();
    for (const [chain, items] of byChain) {
      const sc: Scenario = { id: chain, title: "", subject: { ...items[0], text: undefined } as LotterySpec, others: items.slice(1).map((x) => ({ ...x, text: undefined }) as LotterySpec), evidence: Object.fromEntries(items.filter((x) => x.text).map((x) => [x.id, x.text as string])) };
      const w = worldOf(sc);
      for (const l of [w.subject, ...w.lotteries]) {
        const texts = [l.conditionsText, ...(w.evidence.get(l.id) ?? [])];
        const j = judgeForm({ storeMode: l.storeMode, requirementTags: l.requirementTags, texts, sourceUrls: l.sourceUrls, storeKey: l.storeId, siblings: [] });
        counts[j.form]++;
        const src = items.find((x) => x.id === l.id)!;
        rows.push({ id: l.id, chain, store: src.store ?? "", storeMode: l.storeMode, form: j.form, confidence: j.confidence, restriction: j.restrictionOnly, basis: j.basis.join("・").slice(0, 100) });
        lotteries.push(l);
        evidence.set(l.id, w.evidence.get(l.id) ?? []);
      }
    }
    const cleanup = findSelectFormCleanup(lotteries, evidence);
    mkdirSync("eval/runs", { recursive: true });
    writeFileSync("eval/runs/pool-form-8f6.json", JSON.stringify({ total: pool.length, counts, restrictionOnly: rows.filter((r) => r.restriction && r.form !== "store_select").map((r) => r.id), selectRegistered: rows.filter((r) => r.storeMode === "select_on_apply").map((r) => r.id), misregistered: rows.filter((r) => r.form === "store_select" && r.storeMode !== "select_on_apply"), cleanup, rows }, null, 1));
    expect(Object.values(counts).reduce((a, b) => a + b, 0)).toBe(pool.length);
  });
});
