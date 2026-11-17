// @vitest-environment node
// 9H-3O 準備（費用0・AI・ネットワークに触れない）。BUILD_9H3O=1 のときだけ実行。結果: backups/eval-9h3o/sweep-plan.json
//  本番から書き出した候補プール（2026-11-17）の履歴から、今日の時点で応募期間が開いている／これから始まる開催機会を選び、
//  系列横断の調査対象（planSweep）を作る。対象は実行前に凍結する（結果を見て差し替えない）。
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { clusterOpportunities, discoverTendencies, planSweep, type HistoryLottery } from "./chain-sweep";

const POOL = "backups/eval-9h3f/pool-production-2026-11-17T14-51-51-832Z.json";
const ON = process.env.BUILD_9H3O === "1" && existsSync(POOL);
const NOW = new Date(process.env.NOW_9H3O ?? "2026-11-18T12:00:00+09:00");

type PoolCand = { id: string; status: string; url?: string; title: string; input: { chain: string; store: string; products: string[]; applyStart: string | null; applyDeadline: string | null } };

describe.skipIf(!ON)("9H-3O 系列横断の実調査の対象（凍結）", () => {
  it("開いている開催機会から調査対象を作る", { timeout: 120_000 }, () => {
    const pool = JSON.parse(readFileSync(POOL, "utf8")) as { candidates: PoolCand[] };
    const day = (s: string | null) => (s ? s.slice(0, 10) : null);
    const urlOf = new Map<string, string>();
    const seen = new Set<string>();
    const history: HistoryLottery[] = [];
    for (const c of pool.candidates) {
      const i = c.input;
      if (!i?.chain || !i.store || !i.products?.[0] || !day(i.applyStart) || /^(通販|オンライン)/.test(i.store)) continue;
      const k = `${i.chain}|${i.store}|${i.products[0]}|${day(i.applyStart)}`;
      if (seen.has(k)) continue;
      seen.add(k);
      history.push({ chain: i.chain, store: i.store, product: i.products[0], applyStart: day(i.applyStart), applyDeadline: day(i.applyDeadline), text: c.title });
      if (c.url) urlOf.set(k, c.url);
    }
    const tend = discoverTendencies(history);
    const opps = clusterOpportunities(history);
    const today = NOW.toISOString().slice(0, 10);
    const open = opps.filter((o) => {
      const dl = o.members.map((m) => m.applyDeadline).filter(Boolean).sort().at(-1) ?? null;
      const st = o.members.map((m) => m.applyStart).filter(Boolean).sort()[0] ?? null;
      return st && st >= "2026-11-01" && (dl === null || dl >= today);
    });
    const rows: unknown[] = [];
    for (const o of open) {
      const seed = [...o.members].sort((a, b) => (a.applyStart ?? "").localeCompare(b.applyStart ?? ""))[0];
      const dl = o.members.map((m) => m.applyDeadline).filter(Boolean).sort().at(-1) ?? null;
      const prof = tend.profiles.find((p) => p.chain === o.chain) ?? null;
      const targets = planSweep({ seed: { ...seed, applyDeadline: dl }, profile: prof, global: tend.global, foundStores: o.stores, ledger: {}, now: NOW });
      rows.push({
        chain: o.chain,
        product: o.product,
        stores: o.stores,
        seedStore: seed.store,
        seedUrl: urlOf.get(`${seed.chain}|${seed.store}|${seed.product}|${seed.applyStart}`) ?? null,
        applyStart: seed.applyStart,
        applyDeadline: dl,
        profile: prof ? { confidence: prof.confidence, multiStoreOpportunities: prof.multiStoreOpportunities, simultaneity: Number(prof.simultaneity.toFixed(2)) } : null,
        targets,
      });
    }
    // 対照（調査しないと判断された店舗）: 開いている開催機会に参加しておらず、その系列の複数店舗の開催機会に過去1件も参加していない店舗
    const controls: unknown[] = [];
    for (const o of open) {
      const chainOpps = opps.filter((x) => x.chain === o.chain && x.stores.length >= 2);
      if (chainOpps.length < 3) continue;
      const all = new Set(history.filter((h) => h.chain === o.chain).map((h) => h.store));
      for (const s of all) {
        if (o.stores.includes(s)) continue;
        const n = chainOpps.filter((x) => x.stores.includes(s)).length;
        if (n === 0) controls.push({ chain: o.chain, store: s, product: o.product, applyDeadline: o.members.map((m) => m.applyDeadline).filter(Boolean).sort().at(-1) ?? null, chainMultiStoreOpportunities: chainOpps.length, participated: n });
      }
    }
    mkdirSync("backups/eval-9h3o", { recursive: true });
    writeFileSync("backups/eval-9h3o/controls.json", JSON.stringify(controls, null, 1));
    writeFileSync("backups/eval-9h3o/sweep-plan.json", JSON.stringify({ at: NOW.toISOString(), poolExportedAt: "2026-11-17T14:51:51Z", historyLotteries: history.length, openOpportunities: open.length, seeds: rows }, null, 1));
    expect(rows.length).toBeGreaterThanOrEqual(0);
  });
});
