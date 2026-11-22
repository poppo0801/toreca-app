// @vitest-environment node
/**
 * Stage 10P: Stage 10O の同一入力の再評価（公式性を条件から外した新基準・日時の意味と正規化・商品マスター）と、新旧方式の比較（実AIはページの再抽出のみ・書き込みなし・DB不要）。
 *   入力: ローカルの本番書き出し（登録 235件）と、10Oで判断した一覧項目の保存（eval/real-data/xsource-10o-items.json＝再課金しない）。**本番には接続しない**。
 *   新たなAI: 補完の実証の16ページを、日時の役割つきで再抽出（呼び出し16回・取得16回・約¥1.6）。上限（開始前に予約・ハード停止）: 90回・¥50・1件¥3・対象30・取得60。
 *   出力: eval/real-data/xsource-10p.json（集計）・human-review-10p.json（人の確認用。review-10o-local.mjs と同じ形式）。Git管理外。**人の確認は行っていない**。
 * 実行: JUDGMENT_10P_REAL=1 JUDGMENT_REAL_EVAL=allow JUDGMENT_REUSE_EXISTING_KEY=allow JUDGMENT_REAL_CONFIRM=yes JUDGMENT_APPROVED_TOTAL_JPY=50 JUDGMENT_APPROVED_PER_CASE_JPY=3 TOREMANE_ENV=local npx vitest run src/lib/judgment/xsource/xsource-10p-real.test.ts
 */
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { isBlockedMessage } from "@/lib/agent/case-investigator/evidence-fetcher";
import { CallBudget } from "../call-budget";
import type { ListItemResult } from "../list-discovery";
import { checkJudgmentRealRun } from "../real-gate";
import { makeAnthropicPageExtractor, pageExtractReserveJpy, verifyPageFacts } from "./ai-10o";
import { clusterFacts, pairRelations } from "./cluster";
import { resolveConditions, type ResolvedConditions } from "./conditions";
import { decideOpportunity, type DecisionResult } from "./decision";
import { factFromListItem, factFromRegistration, type RegistrationLike } from "./facts";
import { canonUrl, chainsMatch, storesMatch } from "./normalize";
import { buildProductMatcher } from "./product-master";
import type { Cluster, SourceFact } from "./types";

vi.mock("server-only", () => ({}));

const env = process.env;
const MAX_CALLS = Number(env.JUDGMENT_10P_MAX_CALLS ?? 90);
const MAX_COST = 50;
const MAX_FETCHES = 60;
const MAX_TARGETS = 30;
const latest = (dir: string, prefix: string): string => `${dir}/${readdirSync(dir).filter((f) => f.startsWith(prefix)).sort().at(-1)}`;
const jst = (iso: string | null): string | null => (iso ? new Date(Date.parse(iso) + 9 * 3600_000).toISOString().slice(0, 16).replace("T", " ") : null);
const count = (xs: string[]): Record<string, number> => xs.reduce<Record<string, number>>((m, x) => ((m[x] = (m[x] ?? 0) + 1), m), {});
type Row = Record<string, unknown>;
interface CachedItem { candidateId: string; parentKey: string; single: boolean; groupLabel: string; head: string; item: ListItemResult; range: { start: number; end: number }; fetchedAt: string; text: string }

describe.skipIf(env.JUDGMENT_10P_REAL !== "1")("10P 再評価（新基準）と新旧の比較: 実データ（有料）", () => {
  it("同一入力の50件を新基準で再判断し、補完6件の日時の意味を再検証し、旧・新方式を比較する", async () => {
    const gate = checkJudgmentRealRun({ env, confirm: env.JUDGMENT_REAL_CONFIRM === "yes", approvedTotalJpy: Number(env.JUDGMENT_APPROVED_TOTAL_JPY), approvedPerCaseJpy: Number(env.JUDGMENT_APPROVED_PER_CASE_JPY) });
    if (!gate.ok) throw new Error(`実行しません: ${gate.reason}`);
    const now = new Date();
    const snap = JSON.parse(readFileSync(latest("backups/masters-9h3s", "snapshot-prod-"), "utf8")) as Record<string, Row[]>;
    const cached = (JSON.parse(readFileSync("eval/real-data/xsource-10o-items.json", "utf8")) as { items: CachedItem[] }).items;
    const chainName = new Map(snap.chains.map((c) => [c.id as string, c.name as string]));
    const storeById = new Map(snap.stores.map((s) => [s.id as string, s]));
    const productName = new Map(snap.products.map((p) => [p.id as string, p.official_name as string]));
    const itemsBy = new Map<string, string[]>();
    for (const it of snap.lottery_items) itemsBy.set(it.lottery_id as string, [...(itemsBy.get(it.lottery_id as string) ?? []), productName.get(it.product_id as string) ?? ""].filter(Boolean));
    const appCount = new Map<string, number>();
    for (const a of snap.applications) appCount.set(a.lottery_id as string, (appCount.get(a.lottery_id as string) ?? 0) + 1);
    const candOf = new Map<string, string>();
    for (const c of snap.collection_candidates) if (c.lottery_id && !candOf.has(c.lottery_id as string)) candOf.set(c.lottery_id as string, c.id as string);
    const urlsOf = new Map(snap.lotteries.map((l) => [l.id as string, ((l.source_urls as string[] | null) ?? []).filter((u) => typeof u === "string")]));
    const regs: RegistrationLike[] = snap.lotteries
      .filter((l) => !l.archived_at)
      .map((l) => {
        const st = l.store_id ? storeById.get(l.store_id as string) : undefined;
        return { id: l.id as string, candidateId: candOf.get(l.id as string) ?? null, chain: chainName.get(l.chain_id as string) ?? null, store: (st?.name as string | undefined) ?? null, prefecture: (st?.prefecture as string | undefined) ?? null, products: itemsBy.get(l.id as string) ?? [], applyStart: jst((l.apply_start_at as string) ?? null), applyDeadline: jst((l.apply_deadline_at as string) ?? null), resultDate: (l.result_date as string) ?? null, applyUrl: (urlsOf.get(l.id as string) ?? [])[0] ?? null, protectedCodes: (appCount.get(l.id as string) ?? 0) > 0 ? ["applications"] : [], updatedAt: (l.updated_at as string) ?? null };
      });
    const regFacts = regs.map(factFromRegistration);
    for (const f of regFacts) f.urls = urlsOf.get((f.registration as { id: string }).id);
    const itemFacts: SourceFact[] = [];
    for (const c of cached) {
      const f = factFromListItem({ candidateId: c.candidateId, parentKey: c.parentKey, item: c.item, fetchedAt: c.fetchedAt, range: c.range, groupLabel: c.groupLabel, contextTexts: [c.head, c.text] });
      if (f) itemFacts.push(f); // 公式かどうかは判断に使わない（種類は一覧の項目のまま）
    }
    const targetsItems = new Set(cached.map((c) => c.candidateId)).size;

    // ---------------- 新基準で再判断（同一入力・AIなし）
    const all = [...regFacts, ...itemFacts];
    const byId = new Map(all.map((f) => [f.sourceId, f]));
    const clusters = clusterFacts(all);
    const rel = pairRelations(all);
    const unresolved = new Map<string, number>();
    for (const p of rel) if (p.relation.kind === "unknown" && p.relation.evidence.includes("chain_same") && !p.relation.evidence.includes("store_different") && !p.relation.evidence.includes("product_disjoint") && p.relation.score >= 0.3) for (const id of [p.a, p.b]) unresolved.set(id, (unresolved.get(id) ?? 0) + 1);
    const cs = (snap.collection_settings[0] ?? {}) as { prefectures?: string[]; include_online?: boolean };
    const cond = { prefectures: cs.prefectures ?? [], includeOnline: cs.include_online ?? true, productMode: "all" as const };
    const aliases = new Map<string, string[]>();
    for (const a of snap.product_aliases) aliases.set(a.product_id as string, [...(aliases.get(a.product_id as string) ?? []), a.alias as string]);
    const matcher = buildProductMatcher(snap.products.map((p) => ({ id: p.id as string, officialName: p.official_name as string, aliases: aliases.get(p.id as string) })));
    const nStore = (s: string | null): string => (s ?? "").normalize("NFKC").toLowerCase().replace(/[ \t　（）()【】・-]/g, "").replace(/店$/, "");
    const storeMaster = (chain: string | null, store: string | null): { prefecture: string | null } | null => {
      if (nStore(store).length < 3) return null;
      const hit = snap.stores.filter((s) => !s.archived_at && chainsMatch(chainName.get(s.chain_id as string) ?? null, chain) === "same" && ["same", "partial"].includes(storesMatch(s.name as string, store)));
      const prefs = new Set(hit.map((s) => s.prefecture as string).filter(Boolean));
      return prefs.size === 1 ? { prefecture: [...prefs][0] } : null;
    };
    const gv = (c: Cluster, n: string): unknown => c.fields.find((f) => f.field === n)?.adopted ?? c.fields.find((f) => f.field === n)?.candidates[0]?.value ?? null;
    const newOpps = clusters.filter((c) => c.registrations.length === 0 && c.members.some((m) => !m.startsWith("reg:")));
    const decided = newOpps.map((c) => {
      const facts = c.members.map((m) => byId.get(m) as SourceFact);
      const el: ResolvedConditions = resolveConditions({ chain: gv(c, "chain") as string | null, store: gv(c, "store") as string | null, prefecture: gv(c, "prefecture") as string | null, products: (gv(c, "products") as string[] | null) ?? [], texts: facts.flatMap((f) => f.texts ?? []) }, cond, [], { storeMaster, productMaster: (n) => !!matcher.match(n) });
      const d: DecisionResult = decideOpportunity({ cluster: c, facts, eligibility: el, now, unresolvedDuplicatePairs: c.members.reduce((n, m) => n + (unresolved.get(m) ?? 0), 0), isLottery: true });
      return { c, el, d, facts };
    });
    // 反事実（実測ではない）: 一覧の項目の応募先が展開され「別の応募先」と確認できた場合（新規収集分の linkMap）の応募単位 per_store を仮定したときの判断。応募単位の不明が主な保留理由かを見るための参考
    const cfFacts = [...regFacts, ...itemFacts.map((f) => (f.fields.applyUnit === "unknown" && f.fields.store ? { ...f, fields: { ...f.fields, applyUnit: "per_store" as const } } : f))];
    const cfById = new Map(cfFacts.map((f) => [f.sourceId, f]));
    const cfDecisions = clusterFacts(cfFacts)
      .filter((c) => c.registrations.length === 0 && c.members.some((m) => !m.startsWith("reg:")))
      .map((c) => {
        const facts = c.members.map((m) => cfById.get(m) as SourceFact);
        const el = resolveConditions({ chain: gv(c, "chain") as string | null, store: gv(c, "store") as string | null, prefecture: gv(c, "prefecture") as string | null, products: (gv(c, "products") as string[] | null) ?? [], texts: facts.flatMap((f) => f.texts ?? []) }, cond, [], { storeMaster, productMaster: (n) => !!matcher.match(n) });
        return decideOpportunity({ cluster: c, facts, eligibility: el, now, unresolvedDuplicatePairs: c.members.reduce((n, m) => n + (unresolved.get(m) ?? 0), 0), isLottery: true });
      });
    const cfCounts = count(cfDecisions.map((d) => d.decision));
    const cfHeldReasons = count(cfDecisions.filter((d) => d.decision === "needs_review").flatMap((d) => d.reasons));
    // 旧基準（Stage 10O）の同値: 公式（official_*/apply_form）の根拠が無い限り、除外以外は確認待ち（実データでは公式の裏付けが0のため、除外以外は全て確認待ちだった）
    const oldDecision = (x: (typeof decided)[number]): string => (x.d.decision === "excluded" ? "excluded" : "needs_review");
    const oldCounts = count(decided.map(oldDecision));
    const newCounts = count(decided.map((x) => x.d.decision));
    const releasedByRemovingOfficial = decided.filter((x) => oldDecision(x) === "needs_review" && (x.d.decision === "auto_register_preview" || x.d.decision === "candidate_with_gaps")).length;
    const stillHeld = decided.filter((x) => x.d.decision === "needs_review");
    const stillHeldReasons = count(stillHeld.flatMap((x) => x.d.reasons));
    const officialInReasons = decided.filter((x) => x.d.reasons.some((r) => /official/.test(r))).length;
    const eligCounts = count(decided.map((x) => x.el.verdict));
    const unknownCauses = count(decided.filter((x) => x.el.verdict === "unknown").map((x) => x.el.primaryUnknown ?? "unknown"));
    const stages = count(decided.flatMap((x) => [`region:${x.el.stages.region}`, `tcg:${x.el.stages.tcg}`]));
    const notifiable = decided.filter((x) => x.d.notifiable).length;
    const deadlineBasis = count(decided.map((x) => x.d.deadline?.yearBasis ?? "none"));

    // ---------------- 補完の再検証（日時の意味）: 10Oと同じ選定で、ページを日時の役割つきで再抽出
    const { default: Anthropic } = await import("@anthropic-ai/sdk");
    const client = new Anthropic({ apiKey: gate.apiKey, maxRetries: 0 });
    await client.models.retrieve(gate.model);
    const budget = new CallBudget({ maxCalls: MAX_CALLS, maxCostJpy: Math.min(MAX_COST, gate.totalCapJpy) });
    const safe = new (await import("@/lib/server/agent/real-providers")).SafePageFetcher();
    let fetchCount = 0;
    const missing = regs.filter((r) => !r.applyStart || !r.resultDate || !r.store);
    const fetchableUrl = (u: string): boolean => /^https:\/\//.test(u) && canonUrl(u).cls === "specific";
    const perHost = new Map<string, number>();
    const targets = missing
      .filter((r) => (urlsOf.get(r.id) ?? []).some(fetchableUrl) && (!r.applyStart || !r.resultDate))
      .sort((a, b) => a.protectedCodes.length - b.protectedCodes.length || (a.id < b.id ? -1 : 1))
      .filter((r) => {
        const h = canonUrl((urlsOf.get(r.id) ?? []).find(fetchableUrl) as string).host;
        if ((perHost.get(h) ?? 0) >= 2) return false;
        perHost.set(h, (perHost.get(h) ?? 0) + 1);
        return true;
      })
      .slice(0, Math.min(16, MAX_TARGETS - targetsItems));
    const extractor = makeAnthropicPageExtractor(client, { model: gate.model });
    const regById = new Map(regFacts.map((f) => [(f.registration as { id: string }).id, f]));
    const enrichLog: { regId: string; host: string; protectedReg: boolean; outcome: string; before?: Record<string, unknown>; page?: { verifiedDates: Record<string, string>; preview: Record<string, string | null>; yearBasis: Record<string, string>; unit: string | null; quotes: Record<string, string> }; proposals?: { field: string; op: string; value: unknown; protected: boolean }[]; rejected?: string[] }[] = [];
    for (const r of targets) {
      const url = (urlsOf.get(r.id) ?? []).find(fetchableUrl) as string;
      const host = canonUrl(url).host;
      const log = { regId: r.id, host, protectedReg: r.protectedCodes.length > 0 };
      if (fetchCount >= MAX_FETCHES) { enrichLog.push({ ...log, outcome: "fetch_cap" }); continue; }
      fetchCount++;
      const page = await safe.fetchPage(url);
      if (!page.ok) { enrichLog.push({ ...log, outcome: isBlockedMessage(page.message) ? "fetch_blocked" : "fetch_failed" }); continue; }
      const s = budget.start("page_extract", pageExtractReserveJpy(gate.model));
      if (!s.ok) { enrichLog.push({ ...log, outcome: `budget_${s.reason}` }); break; }
      const ex = await extractor(page.text);
      s.finish(ex.costJpy);
      if (!ex.facts) { enrichLog.push({ ...log, outcome: "extraction_failed" }); continue; }
      if (ex.facts.pageKind === "other") { enrichLog.push({ ...log, outcome: "page_not_lottery" }); continue; }
      const v = verifyPageFacts(ex.facts, page.text, now);
      const fields: SourceFact["fields"] = { chain: ex.facts.chain, store: ex.facts.store, products: ex.facts.products };
      const evid: NonNullable<SourceFact["evidence"]> = {};
      // 補完に使う値は、原文確認済み＋正規化できたもの（年が根拠なく決まらないものは使わない）
      for (const k of ["applyStart", "applyDeadline", "resultDate"] as const) {
        const pv = v.preview[k];
        if (v.verified[k] && pv) { (fields as Record<string, string>)[k] = pv; evid[k] = { quoteVerified: true, range: null, image: null }; }
      }
      if (v.unitVerified) { fields.applyUnit = ex.facts.applyUnit as never; evid.applyUnit = { quoteVerified: true, range: null, image: null }; }
      const pf: SourceFact = { sourceId: `page:${r.id.slice(0, 8)}`, kind: "unknown", fetchedAt: now.toISOString(), fields, evidence: evid, urls: [url] };
      const rf = regById.get(r.id) as SourceFact;
      const c = clusterFacts([rf, pf]).find((x) => x.members.includes(rf.sourceId)) as Cluster;
      const together = c.members.includes(pf.sourceId);
      const props = c.proposals.filter((p) => p.registrationId === r.id).map((p) => ({ field: p.field, op: p.op, value: p.value, protected: p.protected }));
      const fillable = props.filter((p) => p.op === "fill_empty" || p.op === "ask_human");
      enrichLog.push({ ...log, outcome: !together ? "not_same_opportunity" : fillable.length ? "enriched" : Object.keys(v.verified).length ? "nothing_new_in_page" : v.rejected.length ? "page_values_rejected" : "nothing_new_in_page", before: { applyStart: r.applyStart, applyDeadline: r.applyDeadline, resultDate: r.resultDate }, page: { verifiedDates: v.verified, preview: v.preview as Record<string, string | null>, yearBasis: Object.fromEntries(Object.entries(v.normalized).map(([k, n]) => [k, n?.yearBasis ?? "none"])), unit: v.unitVerified ? ex.facts.applyUnit : null, quotes: Object.fromEntries(Object.entries(ex.facts.dates).map(([k, d]) => [k, d.quote])) }, proposals: props, rejected: v.rejected });
    }
    const enrichedCases = enrichLog.filter((l) => l.outcome === "enriched");
    const roleMismatch = enrichLog.flatMap((l) => l.rejected ?? []).filter((x) => x.includes("role_mismatch"));
    const noYear = enrichLog.filter((l) => l.page && Object.values(l.page.preview).some((p) => p === null)).length;

    // ---------------- 新旧方式の比較（同じ対象: 一覧・単独告知の親投稿）。分母・経路の差を明示
    const candById = new Map(snap.collection_candidates.map((c) => [c.id as string, c]));
    const cmp = [...new Set(cached.map((c) => c.candidateId))].map((cid) => {
      const cand = candById.get(cid);
      const opps = decided.filter((x) => x.c.members.some((m) => byId.get(m)?.originId === `cand:${cid}`));
      const items = cached.filter((c) => c.candidateId === cid);
      return { oldRegistered: cand?.lottery_id ? 1 : 0, oldStatus: String(cand?.status ?? "—"), newOpportunities: opps.length, newItemsDone: items.filter((i) => i.item.status === "done").length, newItemsTotal: items.length, newDecisions: count(opps.map((o) => o.d.decision)) };
    });
    const sum = (f: (x: (typeof cmp)[number]) => number): number => cmp.reduce((n, x) => n + f(x), 0);
    const comparison = {
      denominator: { parentPosts: cmp.length, note: "旧方式は1候補＝最大1登録。新方式は親投稿の全項目から応募機会を出す。正解データ（人の確認）が無いため、件数の比較であって精度の比較ではない" },
      old: { registeredLotteries: sum((x) => x.oldRegistered), byStatus: count(cmp.map((x) => x.oldStatus)) },
      new: { itemsTotal: sum((x) => x.newItemsTotal), itemsDone: sum((x) => x.newItemsDone), opportunities: sum((x) => x.newOpportunities), decisions: newCounts },
      notMeasured: ["遅延（旧: 収集時刻・新: ワーカー未接続）", "費用の旧方式の実績（旧は本番の集計が別）", "重複・誤統合の正解（人の確認が必要）", "更新（旧方式の更新履歴との突合は未実施）"],
    };

    const summary = {
      note: "Stage 10P 再評価（ローカル・Git管理外）。人の確認は行っていない",
      sameInput: { items: targetsItems, opportunitiesNew: newOpps.length, facts: all.length },
      decisions: { old10O: oldCounts, new10P: newCounts, releasedByRemovingOfficial, officialInAnyReason: officialInReasons, stillHeldReasons, stillHeldCount: stillHeld.length },
      counterfactualApplyUnitKnown: { note: "実測ではない。応募先が別と確認できた場合を仮定した参考値", decisions: cfCounts, stillHeldReasons: cfHeldReasons },
      notifiable: { deadlineNotifiable: notifiable, deadlineYearBasis: deadlineBasis },
      conditions: { eligibility: eligCounts, unknownCauses, stages },
      enrichment: { targets: targets.length, funnel: count(enrichLog.map((l) => l.outcome)), enrichedRegistrations: enrichedCases.length, proposals: enrichedCases.reduce((n, l) => n + (l.proposals?.length ?? 0), 0), roleMismatchRejected: roleMismatch, pagesWithUnresolvedYear: noYear },
      comparison,
      fetches: fetchCount,
      budget: budget.summary(),
    };
    writeFileSync("eval/real-data/xsource-10p.json", JSON.stringify(summary, null, 1));
    writeFileSync(
      "eval/real-data/human-review-10o.json",
      JSON.stringify({
        note: "人の確認用（ローカルのみ・Git管理外）。Stage 10P の再評価。review-10o-local.mjs で確認する",
        opportunities: decided.filter((x) => x.d.decision !== "excluded").map((x) => ({ clusterId: x.c.clusterId, decision: x.d.decision, reasons: x.d.reasons, members: x.c.members.map((m) => ({ id: m, kind: byId.get(m)?.kind, fields: byId.get(m)?.fields })), fields: x.c.fields, proposals: x.c.proposals, contested: x.c.contested, applyUnit: x.c.applyUnit, eligibility: { verdict: x.el.verdict, reasons: x.el.reasons, stages: x.el.stages } })),
        enrichment: enrichedCases.map((l) => ({ regId: l.regId, host: l.host, protectedReg: l.protectedReg, before: l.before, page: { verifiedDates: l.page?.preview ?? {}, quotes: l.page?.quotes ?? {}, unit: l.page?.unit ?? null }, proposals: l.proposals ?? [] })),
      }),
    );
    expect(budget.calls).toBeLessThanOrEqual(MAX_CALLS);
    expect(budget.costJpy).toBeLessThanOrEqual(MAX_COST + 0.01);
    expect(fetchCount).toBeLessThanOrEqual(MAX_FETCHES);
    expect(targetsItems + targets.length).toBeLessThanOrEqual(MAX_TARGETS);
    expect(officialInReasons).toBe(0);
    expect(enrichedCases.every((l) => (l.proposals ?? []).every((p) => !p.protected || p.op === "ask_human"))).toBe(true);
  }, 1_800_000);
});
