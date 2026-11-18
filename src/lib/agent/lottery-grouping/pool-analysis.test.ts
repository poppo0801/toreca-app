// @vitest-environment node
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { comparePair, isPlausiblePeer } from "@/lib/agent/lottery-grouping/compare";
import { worldOf, type LotterySpec, type Scenario } from "@/lib/agent/lottery-grouping/eval-world";
import type { AgentProposal } from "@/lib/agent/lottery-grouping/types";
import { mismatchesOf, verifyProposal } from "@/lib/agent/lottery-grouping/verify";

/**
 * 実際に収集された抽選（本番の有効な抽選の読み取り専用の書き出し。eval/lottery-grouping-real/pool.json。Git管理外）を、
 * 新しい定義（8F-5）の検証層（固定ロジック。AIなし・費用なし）で再分析する。ファイルが無い環境（CI など）では何もしない。
 * 出力: eval/runs/pool-analysis-8f5.json（Git管理外。集計は docs/stage8f5.md に記載）。
 * 重要: ここで決めるのは「新定義の判定ロジックが、実データの組をどう分類するか」であり、正解ではない。
 */
const POOL = "eval/lottery-grouping-real/pool.json";

interface PoolItem extends LotterySpec { chain: string; text?: string }

describe.skipIf(!existsSync(POOL))("実収集データの再分析（新定義・固定ロジックのみ）", () => {
  const pool = (existsSync(POOL) ? (JSON.parse(readFileSync(POOL, "utf8")).pool as PoolItem[]) : []).map((p) => ({ ...p, qty: p.qty ?? 1 }));
  const byChain = new Map<string, PoolItem[]>();
  for (const p of pool) byChain.set(p.chain, [...(byChain.get(p.chain) ?? []), p]);

  it("系列ごとに、各抽選の「条件が一致する別店舗の抽選」をまとめる提案を検証層に通し、区分を集計する", () => {
    const tiers = { auto: 0, suggest: 0, hold: 0, single: 0 } as Record<string, number>;
    const noPeer: string[] = [];
    const reasons: Record<string, number> = {};
    const clusters = new Map<string, { tier: string; ids: string[]; chain: string; products: string[]; stores: string[]; period: string; why: string }>();
    const perSubject: { id: string; tier: string; peers: number }[] = [];
    for (const [chain, items] of byChain) {
      if (items.length < 2) { for (const i of items) noPeer.push(i.id); continue; }
      for (const subject of items) {
        const sc: Scenario = { id: subject.id, title: "", subject: { ...subject, text: undefined } as LotterySpec, others: items.filter((x) => x.id !== subject.id).map((x) => ({ ...x, text: undefined }) as LotterySpec), evidence: Object.fromEntries(items.filter((x) => x.text).map((x) => [x.id, x.text as string])) };
        const w = worldOf(sc);
        // 候補の洗い出し（AIの代わりの決定的な手順）: 事前の絞り込みを通り、かつ、判断の核心に「相違」が無い相手
        const peers = w.lotteries.filter((l) => isPlausiblePeer(w.subject, l) && !mismatchesOf(comparePair(w.subject, l), l.id).some((m) => m.severity === "hard"));
        if (peers.length === 0) {
          const any = w.lotteries.filter((l) => isPlausiblePeer(w.subject, l));
          if (any.length === 0) noPeer.push(subject.id);
          else {
            tiers.single++;
            perSubject.push({ id: subject.id, tier: "single", peers: 0 });
            for (const l of any) for (const m of mismatchesOf(comparePair(w.subject, l), l.id).filter((x) => x.severity === "hard")) reasons[m.field] = (reasons[m.field] ?? 0) + 1;
          }
          continue;
        }
        const claim: AgentProposal = { action: "new_group", groupId: null, memberIds: peers.map((p) => p.id), title: "", rationale: "条件がそろった別店舗の抽選", claimedCommon: [], claimedDiffers: [], commonPhrase: null, selfConfidence: null, missing: [] };
        const d = verifyProposal(w, claim, { allowAuto: true });
        tiers[d.tier]++;
        perSubject.push({ id: subject.id, tier: d.tier, peers: peers.length });
        if (d.tier === "auto" || d.tier === "suggest" || d.tier === "hold") {
          const ids = [...new Set([subject.id, ...peers.map((p) => p.id)])].sort();
          const key = `${d.tier}:${ids.join(",")}`;
          if (!clusters.has(key)) clusters.set(key, { tier: d.tier, ids, chain, products: [...new Set(subject.products ?? [])].slice(0, 2), stores: ids.map((id) => items.find((x) => x.id === id)?.store ?? ""), period: `${subject.start ?? "—"}〜${subject.deadline ?? "—"}`, why: d.rationale.split(" / ").at(-1)?.slice(0, 120) ?? "" });
        }
      }
    }
    const list = [...clusters.values()];
    mkdirSync("eval/runs", { recursive: true });
    writeFileSync("eval/runs/pool-analysis-8f5.json", JSON.stringify({ total: pool.length, chains: byChain.size, tiers, noPeer: noPeer.length, hardReasons: reasons, clusters: list, perSubject }, null, 1));
    // 構造の健全性（実データの内容には依存しない不変条件）: すべての抽選が1つの区分に入る／auto の組は、全員が互いに（同一店舗なし・店舗選択式なし・相違なし）
    expect(Object.values(tiers).reduce((a, b) => a + b, 0) + noPeer.length).toBe(pool.length);
    for (const c of list.filter((x) => x.tier === "auto")) {
      const members = c.ids.map((id) => pool.find((p) => p.id === id)!);
      expect(new Set(members.map((m) => m.store)).size, `auto の組に同じ店舗が含まれる: ${c.ids}`).toBe(members.length);
      expect(members.every((m) => m.storeMode !== "select_on_apply")).toBe(true);
    }
  });
});
