// @vitest-environment node
/**
 * Stage 9H-3R: 自律探索の実AI・実Web検証（**実API・実Webの検索と取得（費用が発生）**。承認された範囲＝今回の検証全体で100円以内）。
 * 実行: node scripts/eval-9h3r.mjs run --missions=<番号,番号> --approved-max-jpy=<円> [--per-mission-jpy=<円>]（E9H3R=1 のときだけ動く）
 *  - DB（本番・開発とも）に接続しない。登録・更新はしない。結果は backups/eval-9h3r/（Git管理外）
 *  - 世界: 実Webの取得・検索（既存の安全な取得・費用の台帳つき）＋ 既存の収集結果（本番の読み取り専用エクスポート。2026-11-17）を「既存」として照合
 *  - ミッションは、探索エンジンのミッション作成（buildMissions）が、商品の発売日・最近の抽選・抽選のない系列から作る。店舗名・検索語は指定しない
 *  - 費用: backups/eval-9h3r/ledger.json に累計（検索料金を含む）。呼び出しの前に最大費用を確認し、累計・1件の上限を超える見込みなら呼ばない
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { runDiscovery } from "@/lib/agent/discovery/engine";
import { allocateMission } from "@/lib/agent/discovery/controls";
import { buildMissions, emptyStrategy } from "@/lib/agent/discovery/session";
import type { DiscoveryWorld, ExistingLottery } from "@/lib/agent/discovery/types";
import { chainsRelated, sameStore } from "@/lib/agent/discovery/verify";
import { sameChainName } from "@/lib/chain-normalize";
import { candidatesFromRecord } from "@/lib/collector/engine-contract";
import { createCaseWorld } from "@/lib/server/agent/case-world";
import { realDiscoveryDeps } from "@/lib/server/agent/discovery-real";

const ON = process.env.E9H3R === "1";
const OUT = "backups/eval-9h3r";
const POOL = "backups/eval-9h3f/pool-production-2026-11-17T14-51-51-832Z.json";
const CAP = Number(process.env.E9H3R_CAP_JPY ?? 0);
const PER = Number(process.env.E9H3R_PER_MISSION_JPY ?? 10);
const picks = (process.env.E9H3R_MISSIONS ?? "").split(",").filter(Boolean).map(Number);
const NOW = new Date(process.env.E9H3R_NOW ?? new Date().toISOString());

interface PoolCand { id: string; status: string; url?: string; title: string; input?: { chain: string; store: string; products: string[]; applyStart: string | null; applyDeadline: string | null } }
const day = (s: string | null | undefined) => (s ? s.slice(0, 10) : null);

describe.skipIf(!ON)("Stage 9H-3R 自律探索の実AI・実Web検証（承認制）", () => {
  it("ミッションを、AIが自律的に調べる。全過程を保存する", { timeout: 3_600_000 }, async () => {
    if (!(CAP > 0) || CAP > 100) throw new Error("承認された費用の上限（E9H3R_CAP_JPY。100円以下）が必要です");
    if (process.env.E9H3R_CONFIRM !== "yes") throw new Error("実行前の確認（E9H3R_CONFIRM=yes）が必要です");
    const env = { ...process.env, COLLECT_AUTONOMOUS_CAP_JPY: String(CAP), COLLECT_AUTONOMOUS_CONFIRM: "yes", COLLECT_AUTONOMOUS_PER_MISSION_JPY: String(PER), AGENT_MODEL: "claude-haiku-5-5" } as Record<string, string | undefined>;
    const real = realDiscoveryDeps({ env, ledgerDir: OUT });
    if (!real.ok) throw new Error(real.reason);

    // ---- 既存の収集結果（比較の基準）
    const pool = JSON.parse(readFileSync(POOL, "utf8")) as { candidates: PoolCand[]; officialHostsByChain?: Record<string, string[]>; collectionSettings?: { prefectures?: string[] } };
    const target = pool.collectionSettings?.prefectures ?? [];
    const rows = pool.candidates.filter((c) => c.input?.chain && c.input.store && c.input.products?.[0] && !/^(通販|オンライン)/.test(c.input.store));
    const existing: ExistingLottery[] = rows.map((c) => ({ lotteryId: c.id, chain: c.input!.chain, store: c.input!.store, products: c.input!.products, sourceUrls: c.url ? [c.url] : [], origin: "legacy_collection" as const, humanConfirmed: false, applyStart: day(c.input!.applyStart), applyDeadline: day(c.input!.applyDeadline) }));
    const storesByChain = new Map<string, Set<string>>();
    for (const e of existing) (storesByChain.get(e.chain) ?? storesByChain.set(e.chain, new Set()).get(e.chain)!).add(e.store);

    // ---- ミッション（探索エンジンが作る。店舗名・検索語は指定しない）
    const open = rows.filter((c) => c.status !== "excluded" && day(c.input!.applyStart) && (day(c.input!.applyDeadline) ?? "9999") >= NOW.toISOString().slice(0, 10) && c.url);
    const seen = new Set<string>();
    const recentLotteries = open.flatMap((c) => {
      const k = `${c.input!.chain}|${c.input!.products[0]}`;
      if (seen.has(k) || !c.input!.chain) return [];
      seen.add(k);
      return [{ chain: c.input!.chain, store: c.input!.store, product: c.input!.products[0], sourceUrl: c.url }];
    });
    const chainsAll = [...storesByChain.entries()].filter(([, s]) => s.size >= 3).map(([name, s]) => ({ name, storeCount: s.size }));
    const missions = buildMissions({ today: NOW.toISOString().slice(0, 10), targetPrefectures: target, releases: [{ name: process.env.E9H3R_PRODUCT ?? "ハドウシーカー", releaseDate: process.env.E9H3R_RELEASE ?? "2026-11-27" }], recentLotteries, idleChains: chainsAll, memory: emptyStrategy(), maxMissions: 12 });
    mkdirSync(`${OUT}/runs`, { recursive: true });
    writeFileSync(`${OUT}/missions.json`, JSON.stringify({ at: NOW.toISOString(), target, poolExportedAt: "2026-11-17T14:51:51Z", poolRows: rows.length, missions }, null, 1));
    const chosen = picks.map((i) => missions[i] ?? (() => { throw new Error(`ミッションがありません: ${i}`); })());
    expect(chosen.length).toBeGreaterThan(0);

    const cw = createCaseWorld({ search: real.search, guard: real.guard });
    const world: DiscoveryWorld = {
      fetchPage: cw.world.fetchPage.bind(cw.world),
      search: cw.world.search!.bind(cw.world),
      lastSearchCostJpy: () => cw.world.lastSearchCostJpy?.() ?? 0,
      existing: async (q) => existing.filter((l) => (!!q.url && l.sourceUrls.includes(q.url)) || ((!q.chain || chainsRelated(l.chain, q.chain)) && (!q.store || sameStore(l.store, l.chain, q.store, q.chain)) && (!q.product || l.products.some((p) => p.includes(q.product ?? "") || (q.product ?? "").includes(p))))).slice(0, 20),
      knownStores: async (chain) => [...(([...storesByChain.entries()].find(([c]) => sameChainName(c, chain)) ?? ["", new Set<string>()])[1])].map((name) => ({ name })),
      chainOfficialUrl: async (chain) => {
        const h = Object.entries(pool.officialHostsByChain ?? {}).find(([c]) => sameChainName(c, chain))?.[1]?.[0];
        return h ? `https://${h}/` : null;
      },
    };

    const runId = new Date().toISOString().replace(/[:.]/g, "-");
    mkdirSync(`${OUT}/runs/${runId}`, { recursive: true });
    const summary: Record<string, unknown>[] = [];
    let stopped: string | null = null;
    for (const [n, m] of chosen.entries()) {
      const idx = picks[n];
      if (readdirSync(`${OUT}/runs`).some((r) => existsSync(`${OUT}/runs/${r}/mission-${idx}.json`))) {
        summary.push({ mission: idx, outcome: "skipped_done" });
        continue;
      }
      if (real.guard.spentJpy + PER > CAP) {
        stopped = `累計 ${real.guard.spentJpy.toFixed(2)}円＋1件の上限${PER}円が承認上限${CAP}円を超える見込みのため停止`;
        summary.push({ mission: idx, outcome: "not_run_cost" });
        continue;
      }
      real.guard.startCase(m.id);
      const b0 = allocateMission(m, { real: true });
      const before = real.guard.spentJpy;
      const logStart = cw.log.length;
      const t0 = Date.now();
      let error: string | null = null;
      let record: Awaited<ReturnType<typeof runDiscovery>> | null = null;
      try {
        record = await runDiscovery({ mission: m, world, llm: real.llmFor(), budget: { ...b0, limits: { ...b0.limits, maxMs: Number(process.env.E9H3R_TIME_MS ?? b0.limits.maxMs), maxCostJpy: Math.min(b0.limits.maxCostJpy, PER, Math.max(0, CAP - real.guard.spentJpy)) } }, real: true });
      } catch (e) {
        error = (e as Error).message;
      }
      const cost = Number((real.guard.spentJpy - before).toFixed(4));
      writeFileSync(`${OUT}/runs/${runId}/mission-${idx}.json`, JSON.stringify({ mission: idx, m, startedAt: new Date(t0).toISOString(), ms: Date.now() - t0, costJpy: cost, error, record, candidates: record ? candidatesFromRecord(record) : [], worldLog: cw.log.slice(logStart) }, null, 1));
      summary.push({ mission: idx, id: m.id, costJpy: cost, error, stop: record?.stop, usage: record?.usage, counts: record?.counts, ms: Date.now() - t0 });
      if (error || (record?.usage.injectionFlags ?? 0) > 0 || cost > PER * 1.5 || real.guard.stopped) {
        stopped = `異常のため停止: ${error ?? (record?.usage.injectionFlags ? "本文に命令らしき文面" : real.guard.stopped ? "費用の関門が停止" : `1件の費用が上限を超過（${cost}円）`)}`;
        break;
      }
    }
    writeFileSync(`${OUT}/runs/${runId}/summary.json`, JSON.stringify({ runId, model: "claude-haiku-5-5", capJpy: CAP, perMissionJpy: PER, spentJpy: Number(real.guard.spentJpy.toFixed(4)), stopped, missions: summary }, null, 1));
    console.log(`9H-3R 実行 ${runId}: 累計 ${real.guard.spentJpy.toFixed(2)}円/${CAP}円${stopped ? `・停止: ${stopped}` : ""}`);
    expect(real.guard.spentJpy).toBeLessThanOrEqual(CAP);
  });
});
