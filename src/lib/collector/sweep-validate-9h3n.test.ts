// @vitest-environment node
// 9H-3N: 保存済みデータでの検証（費用0・AI・ネットワークに触れない）。BUILD_9H3N=1 のときだけ実行。結果: backups/review-ledger/sweep-validate-9h3n.json
//  対象: 本番から書き出した候補プール（2026-11-17・1,380候補）の、解析済みの抽選（系列・店舗・商品・応募開始日）。
//  1. 過去データから系列の開催傾向を発見できるか（系列ごとの傾向と信頼度）
//  2. 1店舗を起点に、関連店舗の調査候補を適切に抽出できるか（複数店舗の開催機会ごとに、起点以外の店舗を、その開催機会を除いた履歴だけから予測 → 適合率・再現率）
//  3. 異なる開催機会を誤って統合していないか（同じ系列・商品で、種類が違う・離れた時期の抽選が別になっているか）
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { clusterOpportunities, discoverTendencies, planSweep, profileChain, sameOpportunity, type HistoryLottery } from "./chain-sweep";

const POOL = "backups/eval-9h3f/pool-production-2026-11-17T14-51-51-832Z.json";
const ON = process.env.BUILD_9H3N === "1" && existsSync(POOL);

describe.skipIf(!ON)("系列横断の調査: 保存済みデータでの検証", () => {
  it("集計する", { timeout: 120_000 }, () => {
    const pool = JSON.parse(readFileSync(POOL, "utf8")) as { candidates: { id: string; status: string; title: string; input: { chain: string; store: string; products: string[]; applyStart: string | null; applyDeadline: string | null } }[] };
    const day = (s: string | null) => (s ? s.slice(0, 10) : null);
    // 履歴: 店舗が分かり、応募開始日が分かる抽選（地域除外・重複を含めて、観測した開催を使う。同じ店舗・商品・開始日は1件）
    const seen = new Set<string>();
    const history: HistoryLottery[] = [];
    for (const c of pool.candidates) {
      const i = c.input;
      if (!i.chain || !i.store || !i.products?.[0] || !day(i.applyStart) || /^(通販|オンライン)/.test(i.store)) continue;
      const k = `${i.chain}|${i.store}|${i.products[0]}|${day(i.applyStart)}`;
      if (seen.has(k)) continue;
      seen.add(k);
      history.push({ chain: i.chain, store: i.store, product: i.products[0], applyStart: day(i.applyStart), applyDeadline: day(i.applyDeadline), text: c.title });
    }
    const tend = discoverTendencies(history);
    const strong = tend.profiles.filter((p) => p.multiStoreOpportunities >= 2).sort((a, b) => b.multiStoreOpportunities - a.multiStoreOpportunities);
    // ---- 2. 関連店舗の予測（leave-one-opportunity-out）。平滑化の強さ・最低の可能性を変えて比べる（過信を抑える調整の検討）
    const opps = clusterOpportunities(history).filter((o) => o.stores.length >= 3);
    const variants: Record<string, { predicted: number; tp: number; precision: number | null; recall: number | null }> = {};
    for (const [smoothing, minProbability] of [[2, 0.4], [4, 0.4], [6, 0.4], [4, 0.5], [6, 0.5]] as const) {
      let vp = 0;
      let vt = 0;
      let va = 0;
      for (const o of opps) {
        const rest = history.filter((h) => !o.members.includes(h));
        const t2 = discoverTendencies(rest);
        const seed = [...o.members].sort((a, b) => (a.applyStart ?? "").localeCompare(b.applyStart ?? ""))[0];
        const targets = planSweep({ seed: { ...seed, applyDeadline: o.members.map((m) => m.applyDeadline).filter(Boolean).sort().at(-1) ?? null }, profile: t2.profiles.find((p) => p.chain === o.chain) ?? null, global: t2.global, foundStores: [], ledger: {}, now: new Date(`${seed.applyStart}T12:00:00Z`), limits: { smoothing, minProbability } });
        const actual = new Set(o.stores.filter((s) => s !== seed.store));
        vp += targets.length;
        vt += targets.filter((t) => actual.has(t.store)).length;
        va += actual.size;
      }
      variants[`smoothing=${smoothing},min=${minProbability}`] = { predicted: vp, tp: vt, precision: vp ? Number((vt / vp).toFixed(2)) : null, recall: va ? Number((vt / va).toFixed(2)) : null };
    }
    let tp = 0;
    let predicted = 0;
    let actualOthers = 0;
    let recalled = 0;
    const perChain: Record<string, { opps: number; tp: number; predicted: number; actual: number }> = {};
    for (const o of opps) {
      const rest = history.filter((h) => !o.members.includes(h));
      const t2 = discoverTendencies(rest);
      const prof = t2.profiles.find((p) => p.chain === o.chain) ?? null;
      const seed = [...o.members].sort((a, b) => (a.applyStart ?? "").localeCompare(b.applyStart ?? ""))[0];
      const now = new Date(`${seed.applyStart}T12:00:00Z`);
      const targets = planSweep({ seed: { ...seed, applyDeadline: o.members.map((m) => m.applyDeadline).filter(Boolean).sort().at(-1) ?? null }, profile: prof, global: t2.global, foundStores: [], ledger: {}, now });
      const actual = new Set(o.stores.filter((s) => s !== seed.store));
      const hit = targets.filter((t) => actual.has(t.store)).length;
      tp += hit;
      predicted += targets.length;
      actualOthers += actual.size;
      recalled += hit;
      const pc = (perChain[o.chain] ??= { opps: 0, tp: 0, predicted: 0, actual: 0 });
      pc.opps++;
      pc.tp += hit;
      pc.predicted += targets.length;
      pc.actual += actual.size;
    }
    // ---- 3. 開催機会の区別: 同じ系列・商品で、2つ以上の開催機会に分かれたか／そのうち種類が違う・離れた時期の組を、誤って同じにしていないか
    const allOpps = clusterOpportunities(history);
    const byCP = new Map<string, typeof allOpps>();
    for (const o of allOpps) byCP.set(`${o.chain}|${o.product}`, [...(byCP.get(`${o.chain}|${o.product}`) ?? []), o]);
    let separatedGroups = 0;
    let wronglyMerged = 0;
    for (const list of byCP.values()) {
      if (list.length >= 2) separatedGroups++;
      for (const o of list) for (let a = 0; a < o.members.length; a++) for (let b = a + 1; b < o.members.length; b++) if (!sameOpportunity(o.members[a], o.members[b]).same) wronglyMerged++;
    }
    const out = {
      historyLotteries: history.length,
      chains: tend.profiles.length,
      chainsWithTendency: strong.length,
      global: tend.global,
      topChains: strong.slice(0, 12).map((p) => ({ chain: p.chain, multiStoreOpps: p.multiStoreOpportunities, coverage: Number(p.coverage.toFixed(2)), simultaneity: Number(p.simultaneity.toFixed(2)), medianSpreadDays: p.medianSpreadDays, confidence: p.confidence, stores: p.storesKnown.length })),
      prediction: { opportunities: opps.length, predicted, truePositive: tp, actualOtherStores: actualOthers, precision: predicted ? Number((tp / predicted).toFixed(2)) : null, recall: actualOthers ? Number((recalled / actualOthers).toFixed(2)) : null },
      variants,
      prefixPerChain: perChain,
      opportunitySeparation: { chainProductsWithMultipleOpportunities: separatedGroups, wronglyMergedPairs: wronglyMerged },
    };
    mkdirSync("backups/review-ledger", { recursive: true });
    writeFileSync("backups/review-ledger/sweep-validate-9h3n.json", JSON.stringify(out, null, 1));
    expect(profileChain("none", history).confidence).toBe("none");
    expect(wronglyMerged).toBe(0);
  });
});
