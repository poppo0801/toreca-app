// @vitest-environment node
/**
 * Stage 9H-3S-3: 自律型AIによる一括再調査・名寄せ・抽選統合の検証。
 *  - オフライン（既定・無料）: 本番の読み取り専用の書き出し（backups/masters-9h3s/）に、新しい計画・名寄せを当てた分析を保存する
 *  - 実AI・実Web（有料。承認された範囲＝今回の検証全体で100円以内）: E9H3S3=live E9H3S3_CAP_JPY=90 E9H3S3_CONFIRM=yes E9H3S3_PHASES=names,form,dates,region,groups
 *  - DB（本番・開発とも）に接続しない。登録・更新はしない。結果は backups/eval-9h3s3/（Git管理外）。費用は台帳 ledger.json に累計（検索料金を含む）
 *  - 実際に情報源を取得できなかった対象は、検証成功として数えない。AIの判定処理に正解は渡さない（応募構造は情報源の記載から判断させる）
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { judgeNames, nameSearchQueries, type NameQuery, type VerifiedNameJudgment } from "@/lib/agent/name-judge";
import { candidatePairs, type RelFacts } from "@/lib/agent/relation-judge";
import { decideAliasLearning } from "@/lib/master-identity/learning";
import { planReevaluation, type PlanItem } from "@/lib/master-identity/reeval-plan";
import { resolveName } from "@/lib/master-identity/resolve";
import { chainMasters, productMasters, type Snapshot } from "@/lib/master-identity/snapshot";
import type { ExistingLottery } from "@/lib/agent/reeval-ai/assess";
import { judgeFormGroup, reinvestigateLottery, realReevalDeps, researchRegion } from "@/lib/server/agent/reeval-ai-service";

try {
  process.loadEnvFile(".env.local");
} catch {
  /* 環境変数が既に設定されている場合 */
}
const OUT = "backups/eval-9h3s3";
const SNAP_DIR = "backups/masters-9h3s";
const NOW = new Date();
type Row = Record<string, unknown>;
const s = (v: unknown) => (typeof v === "string" ? v : "");
const day = (d: unknown, at: unknown) => (s(d) ? s(d).slice(0, 10) : s(at) ? new Date(Date.parse(s(at)) + 9 * 3600_000).toISOString().slice(0, 10) : null);
const LIVE = process.env.E9H3S3 === "live";
const CAP = Number(process.env.E9H3S3_CAP_JPY ?? 0);
const PHASES = (process.env.E9H3S3_PHASES ?? "").split(",").filter(Boolean);

function load() {
  const file = readdirSync(SNAP_DIR).filter((f) => f.startsWith("snapshot-prod")).sort().at(-1) as string;
  const snap = JSON.parse(readFileSync(`${SNAP_DIR}/${file}`, "utf8")) as Snapshot;
  const cs = snap.collection_settings[0] as { prefectures?: string[]; include_online?: boolean };
  const prefs = cs.prefectures ?? [];
  const plan = planReevaluation(snap, { now: NOW, prefectures: prefs, includeOnline: cs.include_online ?? true });
  const chainName = new Map(snap.chains.map((c) => [s(c.id), s(c.name)]));
  const storeOf = new Map(snap.stores.map((x) => [s(x.id), x]));
  const prodName = new Map(snap.products.map((p) => [s(p.id), s(p.official_name)]));
  const itemsOf = (id: string) => snap.lottery_items.filter((i) => s(i.lottery_id) === id).map((i) => prodName.get(s(i.product_id)) ?? "");
  const lotOf = new Map(snap.lotteries.map((l) => [s(l.id), l]));
  const existing = (l: Row): ExistingLottery => ({
    id: s(l.id),
    chain: chainName.get(s(l.chain_id)) ?? "",
    store: storeOf.get(s(l.store_id))?.name ? s(storeOf.get(s(l.store_id))?.name) : null,
    storeMode: s(l.store_mode) === "select_on_apply" ? "select_on_apply" : "fixed",
    products: itemsOf(s(l.id)),
    applyStart: day(l.apply_start_date, l.apply_start_at),
    applyDeadline: day(l.apply_deadline_date, l.apply_deadline_at),
    resultDate: day(l.result_date, l.result_at),
    sourceUrls: ((l.source_urls as string[] | null) ?? []).filter((u) => { try { return !/(^|\.)(t\.co)$/.test(new URL(u).host); } catch { return false; } }).slice(0, 4),
    humanFields: [],
  });
  return { file, snap, prefs, plan, chainName, storeOf, itemsOf, lotOf, existing };
}

describe("Stage 9H-3S-3 オフライン分析（無料）: 本番の書き出しに、新しい計画・名寄せを当てる", () => {
  it("分析を保存する（ジラフル/GIRAFULL・ふるいち/古本市場・店舗別カードの統合候補・日付不足・地域外）", () => {
    if (!existsSync(SNAP_DIR)) return;
    const { file, snap, plan, chainName, storeOf, itemsOf, lotOf, existing } = load();
    mkdirSync(OUT, { recursive: true });
    const chains = chainMasters(snap);
    const probe = (name: string) => {
      const r = resolveName("chain", name, chains);
      return { name, status: r.status, to: r.status === "matched" ? r.match.masterName : r.status === "candidate" ? r.candidates.map((c) => `${c.masterName}（${c.reason}）`) : null };
    };
    const names = ["ジラフル", "GIRAFULL", "ふるいち", "フルイチ", "古本市場", "古本市場（ふるいち）", "古本市場・ふるいち"].map(probe);
    const hit = snap.chains.filter((c) => /ジラフル|girafull|ふるいち|古本市場|フルイチ/i.test(s(c.name))).map((c) => ({ id: s(c.id).slice(0, 8), name: s(c.name), provisional: !!c.is_provisional, archived: !!c.archived_at, aliases: snap.chain_aliases.filter((a) => a.chain_id === c.id).map((a) => `${s(a.alias)}(${s(a.status) || "confirmed"})`) }));
    const groups = plan.items.filter((i) => i.action === "consolidate_lotteries").map((i) => {
      const ev = (i.proposal.evidence ?? {}) as { memberIds?: string[]; stores?: string[]; url?: string; protectedIds?: string[] };
      const keep = lotOf.get(i.targetId) as Row;
      return { keep: i.targetId.slice(0, 8), chain: chainName.get(s(keep.chain_id)), products: itemsOf(i.targetId).map((p) => p.slice(0, 24)), stores: ev.stores, members: ev.memberIds?.length, protectedMembers: ev.protectedIds?.length ?? 0, url: ev.url };
    });
    const hadouGroups = groups.filter((g) => g.products.some((p) => /ハドウシーカー/.test(p)));
    const byKind = (sub: string) => plan.items.filter((i) => i.proposal.subKind === sub);
    const analysis = {
      at: NOW.toISOString(),
      snapshot: file,
      lotteries: plan.summary.lotteries,
      byAction: plan.summary.byAction,
      names,
      masterHits: hit,
      masterCandidates: byKind("master_candidate").map((i: PlanItem) => ({ kind: i.targetType, reason: i.proposal.reason })),
      nameCandidates: byKind("name_candidate").map((i: PlanItem) => i.proposal.reason),
      consolidationGroups: { total: groups.length, hadouShiika: hadouGroups, sample: groups.slice(0, 12) },
      missingDates: byKind("missing_dates").length,
      region: byKind("region").filter((i) => i.targetType === "lottery").map((i) => ({ id: i.targetId.slice(0, 8), store: s(storeOf.get(s((lotOf.get(i.targetId) as Row).store_id))?.name), reason: i.proposal.reason })).slice(0, 20),
      // 従来方式（固定ロジックだけ。9H-3S）との差: 新しい名寄せで、確認待ち候補の系列名がどれだけ解決できるか
      nameResolution: plan.summary.nameResolution,
      existingSample: groups.slice(0, 1).map(() => existing(lotOf.get(plan.items.find((i) => i.action === "consolidate_lotteries")?.targetId ?? "") as Row)),
    };
    writeFileSync(`${OUT}/offline-analysis.json`, JSON.stringify(analysis, null, 1));
    expect(existsSync(`${OUT}/offline-analysis.json`)).toBe(true);
  });
});

describe.skipIf(!LIVE)("Stage 9H-3S-3 実AI・実Web（有料・承認制）", () => {
  it("段階ごとに実行し、全過程を保存する", { timeout: 3_000_000 }, async () => {
    if (!(CAP > 0) || CAP > 100) throw new Error("承認された費用の上限（E9H3S3_CAP_JPY。100円以下）が必要です");
    if (process.env.E9H3S3_CONFIRM !== "yes") throw new Error("実行前の確認（E9H3S3_CONFIRM=yes）が必要です");
    const real = realReevalDeps({ env: { ...process.env, AGENT_MODEL: "claude-haiku-5-5" }, capJpy: CAP, perCaseJpy: 12, ledgerDir: OUT });
    if (!real.ok) throw new Error(real.reason);
    const deps = real.deps;
    const { snap, prefs, plan, chainName, storeOf, lotOf, existing } = load();
    const report: Record<string, unknown[]> = existsSync(`${OUT}/live.json`) ? (JSON.parse(readFileSync(`${OUT}/live.json`, "utf8")) as Record<string, unknown[]>) : {};
    const save = () => writeFileSync(`${OUT}/live.json`, JSON.stringify(report, null, 1));
    const push = (k: string, v: unknown) => ((report[k] ??= []).push(v), save());
    const left = () => CAP - deps.spentJpy();
    const chains = chainMasters(snap);
    const prods = productMasters(snap);

    // ---- 名称（系列名の表記揺れ）: AIがWebで調べ、根拠を検証して、別名の学習の判断（オフラインでの判断。DBは更新しない）まで通す
    if (PHASES.includes("names")) {
      const pairs: { observed: string; candidate: string; kind: "chain" | "product" }[] = (process.env.E9H3S3_NAMES ?? "GIRAFULL>ジラフル,古本市場>ふるいち").split(",").map((x) => ({ observed: x.split(">")[0], candidate: x.split(">")[1], kind: "chain" as const }));
      for (const p of pairs) {
        if (left() < 6) break;
        const cand = chains.find((m) => m.name === p.candidate) ?? chains.find((m) => (m.aliases ?? []).some((a) => a.text === p.candidate));
        if (!cand) {
          push("names", { ...p, skipped: "候補のマスターが書き出しに無い" });
          continue;
        }
        const q: NameQuery = { kind: p.kind, observed: p.observed, candidateId: cand.id, candidateName: cand.name, candidateAliases: (cand.aliases ?? []).map((a) => a.text) };
        const before = deps.spentJpy();
        const hits: { url: string; title: string; snippet: string }[] = [];
        for (const query of nameSearchQueries(q)) for (const h of await deps.webSearch!(query)) if (!hits.some((x) => x.url === h.url)) hits.push(h);
        const out = await deps.judgeNames!([{ query: q, hits }]);
        const j = out.judgments[0] as VerifiedNameJudgment | undefined;
        const resolution = resolveName(q.kind, q.observed, (q.kind === "chain" ? chains : prods).filter((m) => m.id !== undefined));
        const learn = j ? decideAliasLearning({ kind: q.kind, observedName: q.observed, resolution: resolution.status === "matched" ? { status: "candidate", candidates: [{ masterId: cand.id, masterName: cand.name, reason: "AIが調べた候補" }], note: "" } : resolution.status === "none" ? { status: "candidate", candidates: [{ masterId: cand.id, masterName: cand.name, reason: "AIが調べた候補" }], note: "" } : resolution, evidence: j.evidence, origin: "ai", masters: chains }) : null;
        push("names", { ...p, searched: hits.length, hits: hits.slice(0, 6).map((h) => ({ url: h.url, title: h.title })), judgment: j ? { relation: j.relation, rationale: j.rationale, adjusted: j.adjusted, verifiedCites: j.verifiedCites, independentDomains: j.independentDomains } : null, learn: learn ? { action: learn.action, reason: learn.reason } : null, costJpy: Math.round((deps.spentJpy() - before) * 100) / 100 });
      }
    }

    // ---- 応募構造: 同じ情報源・同じ商品の店舗別カード。AIが情報源から判断する（正解は渡さない）。ハドウシーカーのふるいちを優先
    if (PHASES.includes("form")) {
      const groups = plan.items.filter((i) => i.action === "consolidate_lotteries");
      const prodOf = (id: string) => existing(lotOf.get(id) as Row).products.join(" ");
      const ordered = [...groups.filter((g) => /ハドウシーカー/.test(prodOf(g.targetId))), ...groups.filter((g) => !/ハドウシーカー/.test(prodOf(g.targetId)))];
      const only = (process.env.E9H3S3_ONLY ?? "").split(",").filter(Boolean);
      const maxN = Number(process.env.E9H3S3_FORM_N ?? 3);
      let n = 0;
      for (const g of ordered) {
        if (only.length && !only.includes(g.targetId.slice(0, 8))) continue;
        if (n >= maxN || left() < 10 || deps.stopped()) break;
        const ev = (g.proposal.evidence ?? {}) as { memberIds?: string[]; stores?: string[] };
        const keep = existing(lotOf.get(g.targetId) as Row);
        const urls = [...new Set([...keep.sourceUrls, ...(ev.memberIds ?? []).flatMap((m) => existing(lotOf.get(m) as Row).sourceUrls)])].slice(0, 5);
        const t0 = Date.now();
        const out = await judgeFormGroup(deps, { ...keep, store: null, storeMode: "fixed", sourceUrls: urls }, NOW);
        n++;
        push("form", { keep: g.targetId.slice(0, 8), chain: keep.chain, products: keep.products, stores: ev.stores, members: ev.memberIds?.length, urls, aiState: out.aiState, verdict: out.verdict, form: out.form, fetched: out.assessment?.fetched, failed: out.assessment?.failed, costJpy: Math.round(out.costJpy * 100) / 100, ms: Date.now() - t0, queries: out.result?.queries ?? [], stop: out.result?.stopReason ?? null, aiFinish: out.result?.aiFinish ?? null, steps: out.result?.steps.map((x) => `${x.tool}|${x.ok ? "ok" : "ng"}|${x.target.slice(0, 70)}|${x.resultSummary.slice(0, 90)}`).slice(0, 14) ?? [], notMerged: out.result?.notMerged ?? [], sources: out.result?.sources.map((x) => ({ url: x.url, kind: x.kind, status: x.status, failKind: x.failKind ?? null })) ?? [] });
      }
    }

    // ---- 日付の補完・同一抽選の確認（日付不足の抽選）
    if (PHASES.includes("dates")) {
      const targets = plan.items.filter((i) => i.proposal.subKind === "missing_dates" && (existing(lotOf.get(i.targetId) as Row).sourceUrls.length > 0));
      const only = (process.env.E9H3S3_ONLY ?? "").split(",").filter(Boolean);
      const maxN = Number(process.env.E9H3S3_DATES_N ?? 4);
      let n = 0;
      for (const t of targets) {
        if (only.length && !only.includes(t.targetId.slice(0, 8))) continue;
        if (n >= maxN || left() < 8 || deps.stopped()) break;
        const e = existing(lotOf.get(t.targetId) as Row);
        const t0 = Date.now();
        const out = await reinvestigateLottery(deps, e, NOW);
        n++;
        push("dates", { id: t.targetId.slice(0, 8), chain: e.chain, store: e.store, products: e.products, before: { applyStart: e.applyStart, applyDeadline: e.applyDeadline, resultDate: e.resultDate }, aiState: out.aiState, verdict: out.verdict, fills: out.assessment?.fills ?? [], differs: out.assessment?.differs ?? [], unknown: out.assessment?.unknown ?? [], fetched: out.assessment?.fetched, failed: out.assessment?.failed, costJpy: Math.round(out.costJpy * 100) / 100, ms: Date.now() - t0 });
      }
    }

    // ---- 店舗の実所在地と対象地域
    if (PHASES.includes("region")) {
      const targets = plan.items.filter((i) => i.action === "archive_region");
      const seen = new Set<string>();
      const maxN = Number(process.env.E9H3S3_REGION_N ?? 3);
      for (const t of targets) {
        const l = lotOf.get(t.targetId) as Row;
        const st = storeOf.get(s(l.store_id)) as Row | undefined;
        if (!st || seen.has(s(st.id))) continue;
        if (seen.size >= maxN || left() < 8 || deps.stopped()) break;
        seen.add(s(st.id));
        const e = existing(l);
        const siblings = snap.stores.filter((x) => x.chain_id === st.chain_id && x.id !== st.id).map((x) => s(x.name)).slice(0, 12);
        const aliases = snap.chain_aliases.filter((a) => a.chain_id === st.chain_id).map((a) => s(a.alias));
        const t0 = Date.now();
        const out = await researchRegion(deps, { chain: e.chain, name: s(st.name), prefecture: s(st.prefecture), knownDomains: [], siblingNames: siblings, chainAliases: aliases }, null, prefs);
        push("region", { chain: e.chain, store: s(st.name), registeredPrefecture: s(st.prefecture), aiState: out.aiState, verdict: out.verdict, region: out.region, summary: out.summary, costJpy: Math.round(out.costJpy * 100) / 100, ms: Date.now() - t0 });
      }
    }
    // ---- 同一抽選と別抽選の区別（A重複／B同系列別店舗／C独立）。登録済みの事実だけでの判断（情報源の調査は別）
    if (PHASES.includes("relations")) {
      const rf = (l: Row): RelFacts => {
        const e = existing(l);
        return { id: s(l.id), chain: e.chain, store: e.store, storeMode: e.storeMode, products: e.products, applyStart: e.applyStart, applyDeadline: e.applyDeadline, resultDate: e.resultDate, urls: e.sourceUrls, humanConfirmed: false };
      };
      const act = snap.lotteries.filter((l) => !l.archived_at);
      const hadou = act.filter((l) => /ふるいち/.test(chainName.get(s(l.chain_id)) ?? "") && existing(l).products.some((p) => /ハドウシーカー/.test(p))).map(rf);
      const th30 = act.filter((l) => /ふるいち/.test(chainName.get(s(l.chain_id)) ?? "") && existing(l).products.some((p) => /^30th CELEBRATION$/.test(p))).slice(0, 6).map(rf);
      const lots = [...hadou, ...th30];
      const pairs = [...candidatePairs(hadou, 6), ...candidatePairs(th30, 6)];
      const before = deps.spentJpy();
      const j = pairs.length ? await deps.judge(lots, pairs) : null;
      push("relations", { lots: lots.map((x) => ({ id: x.id.slice(0, 8), store: x.store, product: x.products[0]?.slice(0, 20), deadline: x.applyDeadline })), pairs: pairs.length, rawCount: j?.raw.length ?? 0, usage: j?.usage ?? null, judgments: j?.judgments.map((x) => ({ a: x.a.slice(0, 8), b: x.b.slice(0, 8), relation: x.relation, adjusted: x.adjusted, rationale: x.rationale.slice(0, 160) })) ?? [], costJpy: Math.round((deps.spentJpy() - before) * 100) / 100 });
    }
    void chainName;
    report.summary = [{ spentJpy: Math.round(deps.spentJpy() * 100) / 100, capJpy: CAP, phases: PHASES }];
    save();
    expect(deps.spentJpy()).toBeLessThanOrEqual(CAP);
  });
});
