// @vitest-environment node
/**
 * Stage 9U: 自律探索の新旧比較（**実API・実Web（費用が発生）**。承認された範囲＝今回の検証全体で300円以内）。
 *  - DB（本番・開発とも）に接続しない。登録・更新はしない。結果は backups/eval-9u/（Git管理外）。費用は台帳 ledger.json に累計（検索料金を含む）
 *  - 世界: 実Webの取得・検索 ＋ 本番の読み取り専用エクスポート（2026-11-17の候補プール）を「既存」として照合（正解はAIに渡さない。評価の段階で照合）
 *  - 方式A（従来）: 変更前の指示文・名称照合なし。方式B（新）: 名称照合ツール・再調査時間・次の調査対象の提案。同じミッション・同じ予算・同じ世界
 *  - 方式F: Bが提案した次の調査対象・保留の手がかりを、実際に調べる（従来方式には無い工程）
 * 実行: E9U=1 E9U_CAP_JPY=300 E9U_CONFIRM=yes E9U_ARM=A|B|F E9U_MISSIONS=0,1,2 npx vitest run tests/eval9u.real.test.ts
 * ミッションの選択（既定）: 探索エンジンの buildMissions が作る（商品・最近の抽選・抽選のない系列）。店舗名・検索語は指定しない。
 * オフラインの比較（無料）: ミッション選択の連続12回の比較（従来は同じ対象を繰り返す／新は履歴で広がる）は E9U_SIM=1（実AIなし）。
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { runDiscovery, DISCOVERY_SYSTEM } from "@/lib/agent/discovery/engine";
import { allocateMission } from "@/lib/agent/discovery/controls";
import { buildMissions, emptyStrategy, updateStrategy, type StrategyMemory } from "@/lib/agent/discovery/session";
import type { DiscoveryMission, DiscoveryWorld, ExistingLottery } from "@/lib/agent/discovery/types";
import { chainsRelated, sameStore } from "@/lib/agent/discovery/verify";
import { sameChainName } from "@/lib/chain-normalize";
import { resolveName } from "@/lib/master-identity/resolve";
import { createCaseWorld } from "@/lib/server/agent/case-world";
import { realDiscoveryDeps } from "@/lib/server/agent/discovery-real";

try {
  process.loadEnvFile(".env.local");
} catch {
  /* 環境変数が既に設定されている場合 */
}
const ON = process.env.E9U === "1";
const SIM = process.env.E9U_SIM === "1";
const OUT = "backups/eval-9u";
const POOL = "backups/eval-9h3f/pool-production-2026-11-17T14-51-51-832Z.json";
const CAP = Number(process.env.E9U_CAP_JPY ?? 0);
const PER = Number(process.env.E9U_PER_MISSION_JPY ?? 12);
const ARM = (process.env.E9U_ARM ?? "B") as "A" | "B" | "B2" | "F";
const NOW = new Date(process.env.E9U_NOW ?? "2026-11-19T03:00:00Z");
const picks = (process.env.E9U_MISSIONS ?? "").split(",").filter(Boolean).map(Number);

interface PoolCand { id: string; status: string; url?: string; title: string; input?: { chain: string; store: string; products: string[]; applyStart: string | null; applyDeadline: string | null } }
const day = (s: string | null | undefined) => (s ? s.slice(0, 10) : null);
const HAS_POOL = existsSync(POOL);

function load() {
  const pool = JSON.parse(readFileSync(POOL, "utf8")) as { candidates: PoolCand[]; officialHostsByChain?: Record<string, string[]>; collectionSettings?: { prefectures?: string[] } };
  const target = pool.collectionSettings?.prefectures ?? [];
  const rows = pool.candidates.filter((c) => c.input?.chain && c.input.store && c.input.products?.[0] && !/^(通販|オンライン)/.test(c.input.store));
  const existing: ExistingLottery[] = rows.map((c) => ({ lotteryId: c.id, chain: c.input!.chain, store: c.input!.store, products: c.input!.products, sourceUrls: c.url ? [c.url] : [], origin: "legacy_collection" as const, humanConfirmed: false, applyStart: day(c.input!.applyStart), applyDeadline: day(c.input!.applyDeadline) }));
  const storesByChain = new Map<string, Set<string>>();
  for (const e of existing) (storesByChain.get(e.chain) ?? storesByChain.set(e.chain, new Set()).get(e.chain)!).add(e.store);
  const today = NOW.toISOString().slice(0, 10);
  const open = rows.filter((c) => c.status !== "excluded" && day(c.input!.applyStart) && (day(c.input!.applyDeadline) ?? "9999") >= today && c.url);
  const seen = new Set<string>();
  const recentLotteries = open.flatMap((c) => {
    const k = `${c.input!.chain}|${c.input!.products[0]}`;
    if (seen.has(k)) return [];
    seen.add(k);
    return [{ chain: c.input!.chain, store: c.input!.store, product: c.input!.products[0], sourceUrl: c.url }];
  });
  const idleChains = [...storesByChain.entries()].filter(([, s]) => s.size >= 3).map(([name, s]) => ({ name, storeCount: s.size }));
  const sources = { today, targetPrefectures: target, releases: [{ name: "ハドウシーカー", releaseDate: "2026-11-27" }, { name: "スペシャルデッキセットMEGA", releaseDate: "2026-11-21" }], recentLotteries, idleChains };
  return { pool, target, existing, storesByChain, sources, rows };
}

describe.skipIf(!SIM || !HAS_POOL)("9U ミッション選択の比較（オフライン・無料）", () => {
  it("連続12回の選択: 従来は同じ対象を繰り返し、新方式は履歴で他の対象へ広がる", () => {
    const { sources } = load();
    const run = (useMemory: boolean) => {
      let mem: StrategyMemory = emptyStrategy();
      const chosen: string[] = [];
      for (let i = 0; i < 12; i++) {
        const t = NOW.getTime() + i * 3 * 3_600_000; // 3時間ごとの実行
        const m = buildMissions({ ...sources, memory: useMemory ? mem : emptyStrategy(), nowMs: t, maxMissions: 1 })[0];
        if (!m) { chosen.push("(なし)"); continue; }
        chosen.push(m.id);
        // 悲観的な前提: どの調査も、新しい抽選は見つからず保留もない
        const rec = { missionId: m.id, trigger: m.trigger, leads: [], sources: [], counts: { adopt: 0, hold: 0, exclude: 0, aiNew: 0, alreadyKnown: 0 }, usage: { costJpy: 10 }, revisitHours: null, nextMissions: [] };
        mem = updateStrategy(mem, rec as never, new Date(t).toISOString());
      }
      return chosen;
    };
    const a = run(false);
    const b = run(true);
    mkdirSync(OUT, { recursive: true });
    const distinct = (x: string[]) => new Set(x.filter((s) => s !== "(なし)")).size;
    writeFileSync(`${OUT}/selection-sim.json`, JSON.stringify({ at: NOW.toISOString(), runs: 12, legacy: { sequence: a, distinct: distinct(a) }, new: { sequence: b, distinct: distinct(b) } }, null, 1));
    console.log(`9U選択: 従来 ${distinct(a)}種類/12回, 新 ${distinct(b)}種類/12回`);
    expect(distinct(b)).toBeGreaterThan(distinct(a));
  });
});

describe.skipIf(!ON || !HAS_POOL)("9U 自律探索の新旧比較（実AI・実Web・承認制）", () => {
  it("同じミッションを、方式A（従来）または方式B（新）／F（次の調査対象）で調べる", { timeout: 3_600_000 }, async () => {
    if (!(CAP > 0) || CAP > 300) throw new Error("承認された費用の上限（E9U_CAP_JPY。300円以下）が必要です");
    if (process.env.E9U_CONFIRM !== "yes") throw new Error("実行前の確認（E9U_CONFIRM=yes）が必要です");
    const env = { ...process.env, COLLECT_AUTONOMOUS_CAP_JPY: String(CAP), COLLECT_AUTONOMOUS_CONFIRM: "yes", COLLECT_AUTONOMOUS_PER_MISSION_JPY: String(PER), AGENT_MODEL: "claude-haiku-5-5" } as Record<string, string | undefined>;
    const real = realDiscoveryDeps({ env, ledgerDir: OUT });
    if (!real.ok) throw new Error(real.reason);
    const { pool, existing, storesByChain, sources } = load();
    mkdirSync(`${OUT}/runs`, { recursive: true });

    let missions: DiscoveryMission[];
    if (ARM === "F") {
      // 方式B の結果（保存済み）から、次の調査対象を待ち行列にして選ぶ
      let mem: StrategyMemory = emptyStrategy();
      for (const f of readdirSync(`${OUT}/runs`)) {
        for (const g of readdirSync(`${OUT}/runs/${f}`).filter((x) => x.startsWith("B-mission-"))) {
          const j = JSON.parse(readFileSync(`${OUT}/runs/${f}/${g}`, "utf8")) as { record: never | null };
          if (j.record) mem = updateStrategy(mem, j.record, NOW.toISOString());
        }
      }
      writeFileSync(`${OUT}/frontier.json`, JSON.stringify(mem.frontier ?? [], null, 1));
      missions = buildMissions({ ...sources, releases: [], recentLotteries: [], idleChains: [], memory: mem, nowMs: NOW.getTime() + 1000, maxMissions: 12 });
    } else missions = buildMissions({ ...sources, maxMissions: 12, nowMs: NOW.getTime() });
    writeFileSync(`${OUT}/missions-${ARM}.json`, JSON.stringify(missions.map((m) => ({ id: m.id, trigger: m.trigger })), null, 1));
    const chosen = picks.map((i) => missions[i] ?? (() => { throw new Error(`ミッションがありません: ${i}`); })());
    expect(chosen.length).toBeGreaterThan(0);

    const cw = createCaseWorld({ search: real.search, guard: real.guard });
    const masters = [...storesByChain.keys()].map((name, i) => ({ id: `c${i}`, name, aliases: [] as { text: string; status: "confirmed"; source: string }[] }));
    const world: DiscoveryWorld = {
      fetchPage: cw.world.fetchPage.bind(cw.world),
      search: cw.world.search!.bind(cw.world),
      lastSearchCostJpy: () => cw.world.lastSearchCostJpy?.() ?? 0,
      existing: async (q) => existing.filter((l) => (!!q.url && l.sourceUrls.includes(q.url)) || ((!q.chain || chainsRelated(l.chain, q.chain)) && (!q.store || sameStore(l.store, l.chain, q.store, q.chain)) && (!q.product || l.products.some((p) => p.includes(q.product!) || q.product!.includes(p))))).slice(0, 20),
      knownStores: async (chain) => [...(([...storesByChain.entries()].find(([c]) => sameChainName(c, chain)) ?? ["", new Set<string>()])[1])].map((name) => ({ name })),
      chainOfficialUrl: async (chain) => {
        const h = Object.entries(pool.officialHostsByChain ?? {}).find(([c]) => sameChainName(c, chain))?.[1]?.[0];
        return h ? `https://${h}/` : null;
      },
      // 新方式のみ: 名称照合ツール（従来方式には無い）
      ...(ARM === "A" ? {} : {
        resolveName: async (kind: "chain" | "product", name: string) => {
          const r = resolveName(kind, name, kind === "chain" ? masters : []);
          return r.status === "matched" ? { status: "matched" as const, masterName: r.match.masterName, note: "既存のマスターと同じ" } : r.status === "candidate" ? { status: "candidate" as const, masterName: r.candidates[0]?.masterName, note: r.candidates[0]?.reason ?? "近い名称あり" } : { status: "none" as const, note: "既存に該当なし（未知の可能性）" };
        },
      }),
    };
    const legacySystem = DISCOVERY_SYSTEM.split("\n").filter((l) => !/resolve_name|revisit_hours|費用に見合うかを自分で考える/.test(l)).join("\n");

    const runId = new Date().toISOString().replace(/[:.]/g, "-");
    mkdirSync(`${OUT}/runs/${runId}`, { recursive: true });
    const summary: Record<string, unknown>[] = [];
    let stopped: string | null = null;
    for (const [n, m] of chosen.entries()) {
      const idx = picks[n];
      if (readdirSync(`${OUT}/runs`).some((r) => existsSync(`${OUT}/runs/${r}/${ARM}-mission-${idx}.json`))) {
        summary.push({ mission: idx, outcome: "skipped_done" });
        continue;
      }
      if (real.guard.spentJpy + PER > CAP) {
        stopped = `累計 ${real.guard.spentJpy.toFixed(2)}円＋1件の上限${PER}円が承認上限${CAP}円を超える見込みのため停止`;
        summary.push({ mission: idx, outcome: "not_run_cost" });
        continue;
      }
      real.guard.startCase(`${ARM}:${m.id}`);
      const b0 = allocateMission(m, { real: true });
      const before = real.guard.spentJpy;
      const t0 = Date.now();
      let error: string | null = null;
      let record: Awaited<ReturnType<typeof runDiscovery>> | null = null;
      try {
        record = await runDiscovery({ mission: m, world, llm: real.llmFor(), budget: { ...b0, limits: { ...b0.limits, maxCostJpy: Math.min(b0.limits.maxCostJpy, PER, Math.max(0, CAP - real.guard.spentJpy)) } }, real: true, ...(ARM === "A" ? { system: legacySystem } : {}) });
      } catch (e) {
        error = (e as Error).message;
      }
      const cost = Number((real.guard.spentJpy - before).toFixed(4));
      writeFileSync(`${OUT}/runs/${runId}/${ARM}-mission-${idx}.json`, JSON.stringify({ arm: ARM, mission: idx, m, startedAt: new Date(t0).toISOString(), ms: Date.now() - t0, costJpy: cost, error, record }, null, 1));
      summary.push({ arm: ARM, mission: idx, id: m.id, costJpy: cost, error, stop: record?.stop?.reason, counts: record?.counts, revisitHours: record?.revisitHours, next: record?.nextMissions?.length, usage: record?.usage, ms: Date.now() - t0 });
      if (error || (record?.usage.injectionFlags ?? 0) > 0 || cost > PER * 1.5 || real.guard.stopped) {
        stopped = `異常のため停止: ${error ?? (record?.usage.injectionFlags ? "本文に命令らしき文面" : real.guard.stopped ? "費用の関門が停止" : `1件の費用が上限を超過（${cost}円）`)}`;
        break;
      }
    }
    writeFileSync(`${OUT}/runs/${runId}/summary-${ARM}.json`, JSON.stringify({ runId, arm: ARM, model: "claude-haiku-5-5", capJpy: CAP, perMissionJpy: PER, spentJpy: Number(real.guard.spentJpy.toFixed(4)), stopped, missions: summary }, null, 1));
    console.log(`9U ${ARM} ${runId}: 累計 ${real.guard.spentJpy.toFixed(2)}円/${CAP}円${stopped ? `・停止: ${stopped}` : ""}`);
    expect(real.guard.spentJpy).toBeLessThanOrEqual(CAP);
  });
});
