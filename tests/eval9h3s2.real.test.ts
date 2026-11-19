// @vitest-environment node
/**
 * Stage 9H-3S-2: 自律型AIによる既存抽選の再調査の実AI・実Web検証（**実API・実Webの検索と取得（費用が発生）**。承認された範囲＝今回の検証全体で100円以内）。
 * 実行: E9H3S2=1 E9H3S2_CAP_JPY=95 E9H3S2_CONFIRM=yes npx vitest run tests/eval9h3s2.real.test.ts
 *  - DB（本番・開発とも）に接続しない。登録・更新はしない。入力は本番の読み取り専用の書き出し（backups/masters-9h3s/。2026-11-18）
 *  - 結果は backups/eval-9h3s2/（Git管理外）。変更前後（既存の登録内容 → AIの再調査）を、対象ごとに比較できる形で保存する
 *  - 費用: backups/eval-9h3s2/ledger.json に累計（検索料金を含む）。呼び出しの前に最大費用を確認し、上限を超える見込みなら呼ばない
 *  - 実際に情報源を取得できなかった対象は、検証成功として数えない
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { candidatePairs, type RelFacts } from "@/lib/agent/relation-judge";
import { decideAliasLearning } from "@/lib/master-identity/learning";
import { nameObservations, type ExistingLottery } from "@/lib/agent/reeval-ai/assess";
import { planReevaluation } from "@/lib/master-identity/reeval-plan";
import { resolveName } from "@/lib/master-identity/resolve";
import { chainMasters, productMasters, type Snapshot } from "@/lib/master-identity/snapshot";
import { reinvestigateLottery, researchRegion, realReevalDeps } from "@/lib/server/agent/reeval-ai-service";

try {
  process.loadEnvFile(".env.local");
} catch {
  /* 環境変数が既に設定されている場合 */
}
const ON = process.env.E9H3S2 === "1";
const OUT = "backups/eval-9h3s2";
const SNAP_DIR = "backups/masters-9h3s";
const CAP = Number(process.env.E9H3S2_CAP_JPY ?? 0);
const NOW = new Date();
const TAG = process.env.E9H3S2_TAG ?? "";
const ONLY = (process.env.E9H3S2_ONLY ?? "").split(",").filter(Boolean);
type Row = Record<string, unknown>;
const s = (v: unknown) => (typeof v === "string" ? v : "");
const day = (d: unknown, at: unknown) => (s(d) ? s(d).slice(0, 10) : s(at) ? new Date(Date.parse(s(at)) + 9 * 3600_000).toISOString().slice(0, 10) : null);

describe.skipIf(!ON)("Stage 9H-3S-2 自律型AIによる既存抽選の再調査（実AI・実Web・承認制）", () => {
  it("既存の抽選を、AIが実Webで調べ直し、固定ロジックの暫定判定を確認する。全過程を保存する", { timeout: 3_000_000 }, async () => {
    if (!(CAP > 0) || CAP > 100) throw new Error("承認された費用の上限（E9H3S2_CAP_JPY。100円以下）が必要です");
    if (process.env.E9H3S2_CONFIRM !== "yes") throw new Error("実行前の確認（E9H3S2_CONFIRM=yes）が必要です");
    const real = realReevalDeps({ env: { ...process.env, AGENT_MODEL: "claude-haiku-5-5" }, capJpy: CAP, perCaseJpy: 12, ledgerDir: OUT });
    if (!real.ok) throw new Error(real.reason);
    const deps = real.deps;
    const file = readdirSync(SNAP_DIR).filter((f) => f.startsWith("snapshot-prod")).sort().at(-1) as string;
    const snap = JSON.parse(readFileSync(`${SNAP_DIR}/${file}`, "utf8")) as Snapshot;
    const cs = snap.collection_settings[0] as { prefectures?: string[]; include_online?: boolean };
    const prefs = cs.prefectures ?? [];
    const plan = planReevaluation(snap, { now: NOW, prefectures: prefs, includeOnline: cs.include_online ?? true });

    const chainName = new Map(snap.chains.map((c) => [s(c.id), s(c.name)]));
    const storeOf = new Map(snap.stores.map((x) => [s(x.id), x]));
    const prodName = new Map(snap.products.map((p) => [s(p.id), s(p.official_name)]));
    const itemsOf = (id: string) => snap.lottery_items.filter((i) => s(i.lottery_id) === id).map((i) => prodName.get(s(i.product_id)) ?? "");
    const lot = (prefix: string) => snap.lotteries.find((l) => s(l.id).startsWith(prefix)) as Row;
    const existing = (l: Row): ExistingLottery => ({
      id: s(l.id),
      chain: chainName.get(s(l.chain_id)) ?? "",
      store: storeOf.get(s(l.store_id))?.name ? s(storeOf.get(s(l.store_id))?.name) : null,
      storeMode: s(l.store_mode) === "select_on_apply" ? "select_on_apply" : "fixed",
      products: itemsOf(s(l.id)),
      applyStart: day(l.apply_start_date, l.apply_start_at),
      applyDeadline: day(l.apply_deadline_date, l.apply_deadline_at),
      resultDate: day(l.result_date, l.result_at),
      sourceUrls: ((l.source_urls as string[] | null) ?? []).filter((u) => !/(^|\.)(t\.co)$/.test(new URL(u).host)).slice(0, 4),
      humanFields: [],
    });
    const fixedPlanOf = (id: string) => plan.items.filter((i) => i.targetId === id).map((i) => ({ action: i.action, reason: i.proposal.reason }));
    mkdirSync(OUT, { recursive: true });
    const report: { at: string; capJpy: number; snapshot: string; investigations: unknown[]; regions: unknown[]; relations: unknown; learning: unknown[]; summary?: unknown } = { at: NOW.toISOString(), capJpy: CAP, snapshot: file, investigations: [], regions: [], relations: null, learning: [] };
    const save = () => writeFileSync(`${OUT}/results${TAG}.json`, JSON.stringify(report, null, 1));
    const left = () => CAP - deps.spentJpy();
    const chainM = chainMasters(snap);
    const prodM = productMasters(snap);

    // ---- 1) 所在地（対象地域外とされた店舗の実所在地）
    const regionTargets = ["496f1021", "be189b1c", "190e5c97"]; // ふるいち竹の塚店・カードラボ津田沼店・キデイランド二子玉川店
    // ---- 2) 再調査（日付の空欄・期限切れ・URLあり）
    const reinvTargets = ["d5a1367f", "29e1a899", "fc63100e", "ca8a94dc", "9c95888f", "22e34ef6", "71556237"];
    const order: ({ kind: "region"; id: string } | { kind: "reinv"; id: string })[] = [
      { kind: "region", id: regionTargets[0] }, { kind: "reinv", id: reinvTargets[0] }, { kind: "reinv", id: reinvTargets[1] }, { kind: "region", id: regionTargets[1] },
      { kind: "reinv", id: reinvTargets[2] }, { kind: "reinv", id: reinvTargets[3] }, { kind: "region", id: regionTargets[2] }, { kind: "reinv", id: reinvTargets[4] }, { kind: "reinv", id: reinvTargets[5] }, { kind: "reinv", id: reinvTargets[6] },
    ];
    const learnOffline = (name: string, kind: "chain" | "product", evidence: ReturnType<typeof nameObservations>[number]["evidence"]) => {
      const masters = kind === "chain" ? chainM : prodM;
      const r = resolveName(kind, name, masters);
      return { kind, name, resolution: r.status, decision: decideAliasLearning({ kind, observedName: name, resolution: r, evidence, origin: "ai", masters }) };
    };
    const extra = ONLY.filter((id) => !order.some((o) => o.id === id)).map((id) => ({ kind: "reinv" as const, id }));
    for (const t of [...order, ...extra].filter((o) => ONLY.length === 0 || ONLY.includes(o.id))) {
      if (left() < 8 || deps.stopped()) {
        report.summary = { stopped: deps.stopped() ?? `費用の上限（${CAP}円）に達する見込みのため、残りは実行しない` };
        break;
      }
      const l = lot(t.id);
      const e = existing(l);
      const t0 = Date.now();
      if (t.kind === "region") {
        const st = storeOf.get(s(l.store_id)) as Row;
        const siblings = snap.stores.filter((x) => x.chain_id === st.chain_id && x.id !== st.id).map((x) => s(x.name)).slice(0, 12);
        const aliases = snap.chain_aliases.filter((a) => a.chain_id === st.chain_id).map((a) => s(a.alias));
        const out = await researchRegion(deps, { chain: e.chain, name: s(st.name), prefecture: s(st.prefecture), knownDomains: [], siblingNames: siblings, chainAliases: aliases }, null, prefs);
        report.regions.push({ lottery: t.id, chain: e.chain, store: s(st.name), registeredPrefecture: s(st.prefecture), fixedPlan: fixedPlanOf(s(l.id)), aiState: out.aiState, verdict: out.verdict, region: out.region, summary: out.summary, costJpy: Math.round(out.costJpy * 100) / 100, ms: Date.now() - t0, queries: out.research?.run.trace.filter((x) => x.t === "tool").length ?? 0 });
      } else {
        const out = await reinvestigateLottery(deps, e, NOW);
        const obs = out.result ? nameObservations(out.result) : [];
        report.investigations.push({
          lottery: t.id, chain: e.chain, store: e.store, products: e.products, before: { applyStart: e.applyStart, applyDeadline: e.applyDeadline, resultDate: e.resultDate }, sourceUrls: e.sourceUrls, fixedPlan: fixedPlanOf(s(l.id)),
          aiState: out.aiState, verdict: out.verdict, assessment: out.assessment ?? null, summary: out.summary, costJpy: Math.round(out.costJpy * 100) / 100, ms: Date.now() - t0,
          sources: out.result?.sources.map((x) => ({ url: x.url, kind: x.kind, tier: x.tier, status: x.status, failKind: x.failKind ?? null })) ?? [], stop: out.result?.stopReason ?? null, queries: out.result?.queries ?? [], steps: out.result?.steps.length ?? 0,
          fields: out.result?.fields.map((f) => ({ field: f.field, state: f.state, adopted: f.adopted, sources: f.sources.length, origins: f.independentOrigins, quote: f.sources[0]?.quote?.slice(0, 60) ?? null })) ?? [],
          names: obs.map((o) => learnOffline(o.name, o.kind, o.evidence)),
        });
        for (const o of obs) report.learning.push({ from: t.id, ...learnOffline(o.name, o.kind, o.evidence) });
      }
      save();
    }

    // ---- 3) 抽選どうしの関係（A重複／B同系列別店舗／C独立）。ふるいち系 + 系列名の表記が異なる組（ジラフル／GIRAFULL）
    if (left() >= 4 && !deps.stopped() && (ONLY.length === 0 || process.env.E9H3S2_RELATIONS === "1")) {
      const finds = new Map<string, string[]>();
      for (const i of report.investigations as { lottery: string; fields?: { field: string; state: string; adopted: string | null; quote: string | null }[] }[]) {
        const full = s(snap.lotteries.find((x) => s(x.id).startsWith(i.lottery))?.id);
        finds.set(full, (i.fields ?? []).filter((f) => f.adopted).map((f) => `${f.field}=${f.adopted}（${f.state}${f.quote ? "・原文: " + f.quote : ""}）`));
      }
      const rf = (l: Row): RelFacts => {
        const e = existing(l);
        return { findings: finds.get(s(l.id)), id: s(l.id), chain: e.chain, store: e.store, storeMode: e.storeMode, products: e.products, applyStart: e.applyStart, applyDeadline: e.applyDeadline, resultDate: e.resultDate, urls: e.sourceUrls, humanConfirmed: false };
      };
      const furuichi = ONLY.length > 0 ? [] : snap.lotteries.filter((l) => !l.archived_at && /ふるいち/.test(chainName.get(s(l.chain_id)) ?? "") && itemsOf(s(l.id)).some((p) => /30th/.test(p))).slice(0, 9).map(rf);
      const giraf = snap.lotteries.filter((l) => !l.archived_at && /^(ジラフル|GIRAFULL)$/.test(chainName.get(s(l.chain_id)) ?? "")).map(rf);
      const lots = [...furuichi, ...giraf];
      const pairs = [...candidatePairs(furuichi, 8), ...(giraf.length >= 2 ? ([[giraf[0].id, giraf[1].id]] as [string, string][]) : [])];
      const t0 = Date.now();
      const before = deps.spentJpy();
      const j = await deps.judge(lots, pairs);
      report.relations = { lots: lots.map((x) => ({ id: x.id.slice(0, 8), chain: x.chain, store: x.store, products: x.products.map((p) => p.slice(0, 20)), deadline: x.applyDeadline })), pairs: pairs.length, judgments: j.judgments.map((x) => ({ a: x.a.slice(0, 8), b: x.b.slice(0, 8), relation: x.relation, adjusted: x.adjusted, autoApplicable: x.autoApplicable, rationale: x.rationale, cites: x.cites })), costJpy: Math.round((deps.spentJpy() - before) * 100) / 100, ms: Date.now() - t0 };
      save();
    }
    const inv = report.investigations as { aiState: string; assessment: { fills: unknown[]; differs: unknown[] } | null }[];
    const reg = report.regions as { aiState: string; verdict: string }[];
    report.summary = {
      ...(report.summary as object | undefined),
      spentJpy: Math.round(deps.spentJpy() * 100) / 100,
      investigations: { total: inv.length, investigated: inv.filter((x) => x.aiState === "investigated").length, insufficient: inv.filter((x) => x.aiState === "insufficient").length, failed: inv.filter((x) => x.aiState === "failed").length, withFills: inv.filter((x) => (x.assessment?.fills.length ?? 0) > 0).length, fills: inv.reduce((n, x) => n + (x.assessment?.fills.length ?? 0), 0), differs: inv.reduce((n, x) => n + (x.assessment?.differs.length ?? 0), 0) },
      regions: { total: reg.length, confirmed: reg.filter((x) => x.aiState === "investigated").length, outOfArea: reg.filter((x) => x.verdict === "confirm").length, inArea: reg.filter((x) => x.verdict === "refute").length, unknown: reg.filter((x) => x.verdict === "inconclusive").length },
    };
    save();
    expect(deps.spentJpy()).toBeLessThanOrEqual(CAP);
    expect(existsSync(`${OUT}/results${TAG}.json`)).toBe(true);
  });
});
