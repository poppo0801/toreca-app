// @vitest-environment node
/**
 * Stage 9V: 既存の登録済み抽選・候補を「隠した正解」として、AIが独立に再発見できるかを測る再利用可能な検証（実API・実Web。費用が発生）。
 *  - 入力: 本番の読み取り専用エクスポート（backups/eval-9h3f/pool-*.json）。**対象の系列の既存の抽選・候補は AI に見せない**（existing・knownStores から除く）。
 *    AIに渡すのは「系列名」だけのミッション。正解（隠した既存の抽選）は採点（オフライン）でだけ使う。
 *  - DB（本番・開発とも）に接続しない。登録・更新はしない。結果は backups/eval-9v/（Git管理外）。費用は台帳に累計（検索料金を含む）。
 *  - 採点 E9V_SCORE=1（無料・実AIなし）: 保存済みの実行結果を隠した正解と照合し、発見率・項目別の一致・新規（正解に無いもの）・費用を集計する。
 *    正解に無いものは「誤り」と決めない（未検証の新規として別に数える）。既存データとの比較だけで正誤を確定しない（情報源の再確認が別途必要）。
 * 実行（実AI）: E9V=1 E9V_CAP_JPY=150 E9V_CONFIRM=yes E9V_LABEL=base E9V_CHAINS=カードラボ,BOOKOFF npx vitest run tests/eval9v.real.test.ts
 * 採点:         E9V_SCORE=1 E9V_LABELS=base,new npx vitest run tests/eval9v.real.test.ts
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { runDiscovery } from "@/lib/agent/discovery/engine";
import { allocateMission } from "@/lib/agent/discovery/controls";
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
const ON = process.env.E9V === "1";
const SCORE = process.env.E9V_SCORE === "1";
const OUT = "backups/eval-9v";
const POOL = "backups/eval-9h3f/pool-production-2026-11-17T14-51-51-832Z.json";
const CAP = Number(process.env.E9V_CAP_JPY ?? 0);
const PER = Number(process.env.E9V_PER_MISSION_JPY ?? 12);
const LABEL = process.env.E9V_LABEL ?? "base";
const CHAINS = (process.env.E9V_CHAINS ?? "").split(",").filter(Boolean);
const NOW = new Date(process.env.E9V_NOW ?? "2026-11-19T03:00:00Z");
const HAS_POOL = existsSync(POOL);

interface PoolCand { id: string; status: string; url?: string; title: string; input?: { chain: string; store: string; products: string[]; applyStart: string | null; applyDeadline: string | null } }
const day = (s: string | null | undefined) => (s ? s.slice(0, 10) : null);
const pkey = (s: string) => s.normalize("NFKC").replace(/[\s　「」『』【】・\-ー]/g, "").toLowerCase();

function load() {
  const pool = JSON.parse(readFileSync(POOL, "utf8")) as { candidates: PoolCand[]; officialHostsByChain?: Record<string, string[]>; collectionSettings?: { prefectures?: string[] } };
  const target = pool.collectionSettings?.prefectures ?? [];
  const rows = pool.candidates.filter((c) => c.input?.chain && c.input.store && c.input.products?.[0] && !/^(通販|オンライン)/.test(c.input.store));
  const toExisting = (c: PoolCand): ExistingLottery => ({ lotteryId: c.id, chain: c.input!.chain, store: c.input!.store, products: c.input!.products, sourceUrls: c.url ? [c.url] : [], origin: "legacy_collection", humanConfirmed: false, applyStart: day(c.input!.applyStart), applyDeadline: day(c.input!.applyDeadline) });
  return { pool, target, rows, toExisting };
}
/** 隠した正解: 登録済み・登録候補（除外された候補は含めない） */
const isTruth = (c: PoolCand) => c.status === "auto_registered" || c.status === "pending" || c.status === "duplicate";

describe.skipIf(!SCORE || !HAS_POOL)("9V 採点（オフライン・無料）", () => {
  it("保存済みの実行結果を、隠した正解と照合して集計する", () => {
    const { rows } = load();
    const labels = (process.env.E9V_LABELS ?? LABEL).split(",").filter(Boolean);
    const out: Record<string, unknown> = {};
    for (const label of labels) {
      const dir = `${OUT}/runs`;
      if (!existsSync(dir)) continue;
      const files = readdirSync(dir).flatMap((r) => readdirSync(`${dir}/${r}`).filter((f) => f.startsWith(`${label}-`) && f.endsWith(".json") && !f.startsWith(`${label}-summary`)).map((f) => `${dir}/${r}/${f}`));
      const per: Record<string, unknown>[] = [];
      let truthOpen = 0, foundOpen = 0, truthTotal = 0, found = 0, adopted = 0, adoptedMatched = 0, adoptedNew = 0, held = 0, deadlineOk = 0, deadlineCmp = 0, startOk = 0, startCmp = 0, productOk = 0, productCmp = 0, cost = 0, ms = 0, mismatched = 0;
      for (const f of files) {
        const j = JSON.parse(readFileSync(f, "utf8")) as { chain: string; costJpy: number; ms: number; record: { leads?: { lead: { store?: string; chain?: string; products?: string[]; applyStart?: string; applyDeadline?: string; url: string }; decision: { status: string } }[] } | null };
        const chain = j.chain;
        const truth = rows.filter((c) => isTruth(c) && sameChainName(c.input!.chain, chain));
        const stores = new Map<string, PoolCand[]>();
        for (const t of truth) (stores.get(t.input!.store) ?? stores.set(t.input!.store, []).get(t.input!.store)!).push(t);
        // 評価日（NOW）時点で応募期限が過ぎていない（または期限不明）の店舗だけを「現在も開催中の正解」とする。過去の抽選は、今の公開情報からは見つけにくい
        const today = NOW.toISOString().slice(0, 10);
        const openStores = new Set([...stores.entries()].filter(([, v]) => v.some((c) => !c.input!.applyDeadline || day(c.input!.applyDeadline)! >= today)).map(([k]) => k));
        const leads = j.record?.leads ?? [];
        const matchedStores = new Set<string>();
        let a = 0, am = 0, an = 0, h = 0;
        for (const l of leads) {
          if (l.decision.status === "hold") h++;
          if (l.decision.status !== "adopt") continue;
          a++;
          const st = l.lead.store ?? "";
          const hit = [...stores.entries()].find(([s]) => st && sameStore(s, chain, st, l.lead.chain ?? chain));
          if (!hit) { an++; continue; }
          am++;
          matchedStores.add(hit[0]);
          const prods = (l.lead.products ?? []).map(pkey);
          const t = hit[1].find((c) => c.input!.products.some((p) => prods.some((q) => q && (pkey(p).includes(q) || q.includes(pkey(p)))))) ?? null;
          productCmp++;
          if (t) {
            productOk++;
            if (t.input!.applyDeadline && l.lead.applyDeadline) { deadlineCmp++; if (day(t.input!.applyDeadline) === l.lead.applyDeadline) deadlineOk++; }
            if (t.input!.applyStart && l.lead.applyStart) { startCmp++; if (day(t.input!.applyStart) === l.lead.applyStart) startOk++; }
          } else mismatched++;
        }
        truthOpen += openStores.size; foundOpen += [...matchedStores].filter((x) => openStores.has(x)).length;
        truthTotal += stores.size; found += matchedStores.size; adopted += a; adoptedMatched += am; adoptedNew += an; held += h; cost += j.costJpy; ms += j.ms;
        per.push({ chain, truthStores: stores.size, foundStores: matchedStores.size, adopted: a, matchedKnown: am, newUnverified: an, held: h, costJpy: j.costJpy });
      }
      out[label] = { runs: files.length, truthStores: truthTotal, foundStores: found, recall: truthTotal ? Number((found / truthTotal).toFixed(3)) : null, truthOpenStores: truthOpen, foundOpenStores: foundOpen, adopted, adoptedMatched, adoptedNewUnverified: adoptedNew, held, productAgree: `${productOk}/${productCmp}`, deadlineAgree: `${deadlineOk}/${deadlineCmp}`, startAgree: `${startOk}/${startCmp}`, productMismatchOnKnownStore: mismatched, costJpy: Number(cost.toFixed(2)), avgSec: files.length ? Math.round(ms / files.length / 1000) : null, per };
    }
    mkdirSync(OUT, { recursive: true });
    writeFileSync(`${OUT}/score-${labels.join("-")}.json`, JSON.stringify(out, null, 1));
    console.log(JSON.stringify(out, null, 1));
    expect(Object.keys(out).length).toBeGreaterThanOrEqual(0);
  });
});

describe.skipIf(!ON || !HAS_POOL)("9V 既存抽選の独立再発見（実AI・実Web・承認制）", () => {
  it("系列名だけを渡し、対象系列の既存の抽選・候補を隠したまま、AIが独立に調べる", { timeout: 3_600_000 }, async () => {
    if (!(CAP > 0) || CAP > 300) throw new Error("承認された費用の上限（E9V_CAP_JPY。300円以下）が必要です");
    if (process.env.E9V_CONFIRM !== "yes") throw new Error("実行前の確認（E9V_CONFIRM=yes）が必要です");
    if (CHAINS.length === 0) throw new Error("対象の系列（E9V_CHAINS）が必要です");
    const env = { ...process.env, COLLECT_AUTONOMOUS_CAP_JPY: String(CAP), COLLECT_AUTONOMOUS_CONFIRM: "yes", COLLECT_AUTONOMOUS_PER_MISSION_JPY: String(PER), AGENT_MODEL: "claude-haiku-5-5" } as Record<string, string | undefined>;
    const real = realDiscoveryDeps({ env, ledgerDir: OUT });
    if (!real.ok) throw new Error(real.reason);
    const { pool, target, rows, toExisting } = load();
    mkdirSync(`${OUT}/runs`, { recursive: true });
    const runId = new Date().toISOString().replace(/[:.]/g, "-");
    mkdirSync(`${OUT}/runs/${runId}`, { recursive: true });
    const cw = createCaseWorld({ search: real.search, guard: real.guard });
    const summary: Record<string, unknown>[] = [];
    let stopped: string | null = null;

    for (const chain of CHAINS) {
      if (readdirSync(`${OUT}/runs`).some((r) => existsSync(`${OUT}/runs/${r}/${LABEL}-${chain}.json`))) { summary.push({ chain, outcome: "skipped_done" }); continue; }
      if (real.guard.spentJpy + PER > CAP) { stopped = `累計 ${real.guard.spentJpy.toFixed(2)}円＋1件の上限${PER}円が承認上限${CAP}円を超える見込みのため停止`; summary.push({ chain, outcome: "not_run_cost" }); continue; }
      // 対象系列の既存の抽選・候補は AI に見せない（隠した正解）。ほかの系列は「既存」として見える
      const visible = rows.filter((c) => !sameChainName(c.input!.chain, chain)).map(toExisting);
      const storesByChain = new Map<string, Set<string>>();
      for (const e of visible) (storesByChain.get(e.chain) ?? storesByChain.set(e.chain, new Set()).get(e.chain)!).add(e.store);
      const masters = [...storesByChain.keys(), chain].map((name, i) => ({ id: `c${i}`, name, aliases: [] as { text: string; status: "confirmed"; source: string }[] }));
      const world: DiscoveryWorld = {
        fetchPage: cw.world.fetchPage.bind(cw.world),
        search: cw.world.search!.bind(cw.world),
        lastSearchCostJpy: () => cw.world.lastSearchCostJpy?.() ?? 0,
        existing: async (q) => visible.filter((l) => (!!q.url && l.sourceUrls.includes(q.url)) || ((!q.chain || chainsRelated(l.chain, q.chain)) && (!q.store || sameStore(l.store, l.chain, q.store, q.chain)) && (!q.product || l.products.some((p) => p.includes(q.product!) || q.product!.includes(p))))).slice(0, 20),
        knownStores: async (c) => (sameChainName(c, chain) ? [] : [...(([...storesByChain.entries()].find(([x]) => sameChainName(x, c)) ?? ["", new Set<string>()])[1])].map((name) => ({ name }))),
        chainOfficialUrl: async (c) => {
          const h = Object.entries(pool.officialHostsByChain ?? {}).find(([x]) => sameChainName(x, c))?.[1]?.[0];
          return h ? `https://${h}/` : null;
        },
        resolveName: async (kind: "chain" | "product", name: string) => {
          const r = resolveName(kind, name, kind === "chain" ? masters : []);
          return r.status === "matched" ? { status: "matched" as const, masterName: r.match.masterName, note: "既存のマスターと同じ" } : r.status === "candidate" ? { status: "candidate" as const, masterName: r.candidates[0]?.masterName, note: "候補（要確認）" } : { status: "none" as const, note: "既存のマスターに無い名称" };
        },
      };
      const m: DiscoveryMission = { id: `chain:${chain}`, trigger: { kind: "chain", chain }, targetPrefectures: target, today: NOW.toISOString().slice(0, 10), context: [] };
      real.guard.startCase(`${LABEL}:${m.id}`);
      const b0 = allocateMission(m, { real: true });
      const before = real.guard.spentJpy;
      const t0 = Date.now();
      let error: string | null = null;
      let record: Awaited<ReturnType<typeof runDiscovery>> | null = null;
      try {
        record = await runDiscovery({ mission: m, world, llm: real.llmFor(), budget: { ...b0, limits: { ...b0.limits, maxCostJpy: Math.min(b0.limits.maxCostJpy, PER, Math.max(0, CAP - real.guard.spentJpy)) } }, real: true, selfReview: process.env.E9V_SELFREVIEW === "on" });
      } catch (e) {
        error = (e as Error).message;
      }
      const cost = Number((real.guard.spentJpy - before).toFixed(4));
      writeFileSync(`${OUT}/runs/${runId}/${LABEL}-${chain}.json`, JSON.stringify({ label: LABEL, chain, startedAt: new Date(t0).toISOString(), ms: Date.now() - t0, costJpy: cost, error, record }, null, 1));
      summary.push({ chain, costJpy: cost, error, stop: record?.stop?.reason, counts: record?.counts, ms: Date.now() - t0 });
      if (error || (record?.usage.injectionFlags ?? 0) > 0 || cost > PER * 1.5 || real.guard.stopped) { stopped = `異常のため停止: ${error ?? (record?.usage.injectionFlags ? "本文に命令らしき文面" : real.guard.stopped ? "費用の関門が停止" : `1件の費用が上限を超過（${cost}円）`)}`; break; }
    }
    writeFileSync(`${OUT}/runs/${runId}/${LABEL}-summary.json`, JSON.stringify({ runId, label: LABEL, model: "claude-haiku-5-5", capJpy: CAP, perMissionJpy: PER, spentJpy: Number(real.guard.spentJpy.toFixed(4)), stopped, summary }, null, 1));
    console.log(`9V ${LABEL} ${runId}: 累計 ${real.guard.spentJpy.toFixed(2)}円/${CAP}円${stopped ? `・停止: ${stopped}` : ""}`);
    expect(real.guard.spentJpy).toBeLessThanOrEqual(CAP);
  });
});
