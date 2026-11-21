// @vitest-environment node
/**
 * Stage 10O: 複数情報源の補完の実証・対象条件の改善・公式の識別・登録/更新判断・AI照合の揺れ・ブロッキングの実データ評価（実AI・有料・書き込みなし・DB不要）。
 *   入力: ローカルの本番書き出し（登録 235件・保存原文 179件）。**本番には接続しない**。取得は公開ページのみ（既存の安全な取得: SSRF対策・robots尊重・ログイン非回避・間隔1.5秒）。
 *   上限（全工程合算のハード上限・開始前に予約）: AI呼び出し 90回・費用 ¥50・1件 ¥3・対象 30件・ページ取得 60回。超えそうなら停止して未完了を報告。
 *   出力: eval/real-data/xsource-10o.json（集計）・human-review-10o.json（人の確認用）・xsource-10o-items.json（項目の判断の保存。再実行で再課金しない）。Git管理外。**人の確認は行っていない**。
 * 実行: JUDGMENT_10O_REAL=1 JUDGMENT_REAL_EVAL=allow JUDGMENT_REUSE_EXISTING_KEY=allow JUDGMENT_REAL_CONFIRM=yes JUDGMENT_APPROVED_TOTAL_JPY=50 JUDGMENT_APPROVED_PER_CASE_JPY=3 TOREMANE_ENV=local npx vitest run src/lib/judgment/xsource/xsource-10o-real.test.ts
 */
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { redact } from "@/lib/case-model/redact";
import { isBlockedMessage } from "@/lib/agent/case-investigator/evidence-fetcher";
import { absorbBudget, CallBudget } from "../call-budget";
import { detectLeaks, isPublicNotice } from "../eval/phase2";
import { discoverList, MemoryItemStore, type ListItemResult } from "../list-discovery";
import { parseListItems, singleItemParent } from "../list-items";
import { makeAnthropicListModel } from "../list-model";
import { checkJudgmentRealRun } from "../real-gate";
import { applyAdjudicationPolicy } from "./adjudication-policy";
import { adjudicateReserveJpy, makeAnthropicPairAdjudicator } from "./ai";
import { assistReserveJpy, makeAnthropicConditionAssist, makeAnthropicPageExtractor, pageExtractReserveJpy, verifyPageFacts, type AssistInput } from "./ai-10o";
import { candidatePairIndexes, clusterFacts, pairKey, pairRelations, pairRelationsAll } from "./cluster";
import { evaluateOpportunityConditions, resolveConditions, type ResolvedConditions } from "./conditions";
import { decideOpportunity, type Decision } from "./decision";
import { factFromListItem, factFromRegistration, type RegistrationLike } from "./facts";
import { canonUrl, chainsMatch, productsMatch, storesMatch } from "./normalize";
import { buildHostUsage, handleOf, hostHistoryVerdict, isSharedHost, kindForSource, verifyOfficialPair } from "./official";
import type { Cluster, RelationKind, SourceFact } from "./types";

vi.mock("server-only", () => ({}));

const env = process.env;
const MAX_CALLS = Number(env.JUDGMENT_10O_MAX_CALLS ?? 90);
const MAX_COST = 50;
const MAX_TARGETS = 30;
const MAX_FETCHES = 60;
const ITEMS_CACHE = "eval/real-data/xsource-10o-items.json";
const latest = (dir: string, prefix: string): string => `${dir}/${readdirSync(dir).filter((f) => f.startsWith(prefix)).sort().at(-1)}`;
const jst = (iso: string | null): string | null => (iso ? new Date(Date.parse(iso) + 9 * 3600_000).toISOString().slice(0, 16).replace("T", " ") : null);
const count = <T extends string>(xs: T[]): Record<string, number> => xs.reduce<Record<string, number>>((m, x) => ((m[x] = (m[x] ?? 0) + 1), m), {});

interface Ev { id: string; text: string; via: string; url: string; fetchedAt: string; links?: string[] }
type Row = Record<string, unknown>;
interface CachedItem { candidateId: string; parentKey: string; single: boolean; groupLabel: string; head: string; item: ListItemResult; range: { start: number; end: number }; fetchedAt: string; text: string }

describe.skipIf(env.JUDGMENT_10O_REAL !== "1")("10O 補完の実証・条件解決・登録判断: 実データ評価（有料）", () => {
  it("補完できない原因を漏斗で分け、実際の別情報源から補完し、条件・公式・判断基準を測る", async () => {
    const gate = checkJudgmentRealRun({ env, confirm: env.JUDGMENT_REAL_CONFIRM === "yes", approvedTotalJpy: Number(env.JUDGMENT_APPROVED_TOTAL_JPY), approvedPerCaseJpy: Number(env.JUDGMENT_APPROVED_PER_CASE_JPY) });
    if (!gate.ok) throw new Error(`実行しません: ${gate.reason}`);
    const now = new Date();

    // ---------------- 入力（ローカルの書き出し）
    const snap = JSON.parse(readFileSync(latest("backups/masters-9h3s", "snapshot-prod-"), "utf8")) as Record<string, Row[]>;
    const evRows = (JSON.parse(readFileSync(latest("backups/refresh-10g", "evidence-"), "utf8")) as { rows: Ev[] }).rows;
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

    const { default: Anthropic } = await import("@anthropic-ai/sdk");
    const client = new Anthropic({ apiKey: gate.apiKey, maxRetries: 0 });
    await client.models.retrieve(gate.model);
    const budget = new CallBudget({ maxCalls: MAX_CALLS, maxCostJpy: Math.min(MAX_COST, gate.totalCapJpy) });
    const safe = new (await import("@/lib/server/agent/real-providers")).SafePageFetcher();
    let fetchCount = 0;
    const fetchPublic = async (url: string): Promise<{ ok: true; text: string; links: string[] } | { ok: false; reason: "blocked" | "failed" | "cap" }> => {
      if (fetchCount >= MAX_FETCHES) return { ok: false, reason: "cap" };
      fetchCount++;
      const r = await safe.fetchPage(url);
      if (!r.ok) return { ok: false, reason: isBlockedMessage(r.message) ? "blocked" : "failed" };
      return { ok: true, text: r.text, links: (r.links ?? []).map((l) => l.href) };
    };

    // ================ 漏斗（決定的・費用なし）: 登録の欠落項目 → 補完の候補がどこで消えるか
    const nStore = (s: string | null): string => (s ?? "").normalize("NFKC").toLowerCase().replace(/[\s　（）()【】・\-]/g, "").replace(/店$/, "");
    const missing = regs.filter((r) => !r.applyStart || !r.resultDate || !r.store);
    const missingFieldCounts = { applyStart: regs.filter((r) => !r.applyStart).length, resultDate: regs.filter((r) => !r.resultDate).length, store: regs.filter((r) => !r.store).length, prefecture: regs.filter((r) => !r.prefecture).length };
    const otherEvidenceMention = (r: RegistrationLike): number => {
      const sk = nStore(r.store);
      return sk.length < 3 ? 0 : evRows.filter((e) => e.id !== r.candidateId && nStore(e.text).includes(sk) && nStore(e.text).includes(nStore(r.chain).slice(0, 4))).length;
    };
    const fetchableUrl = (u: string): boolean => /^https:\/\//.test(u) && ["specific"].includes(canonUrl(u).cls);
    const funnel = {
      registrations: regs.length,
      withMissingField: missing.length,
      missingByField: missingFieldCounts,
      ownEvidenceStored: missing.filter((r) => evRows.some((e) => e.id === r.candidateId)).length,
      otherStoredEvidenceMentioningStore: missing.filter((r) => otherEvidenceMention(r) > 0).length,
      hasAnyUrl: missing.filter((r) => (urlsOf.get(r.id) ?? []).length > 0).length,
      hasFetchableSpecificUrl: missing.filter((r) => (urlsOf.get(r.id) ?? []).some(fetchableUrl)).length,
      protectedAmongMissing: missing.filter((r) => r.protectedCodes.length > 0).length,
    };

    // ================ ① 項目の判断（一覧・単独告知。保存して再実行で再課金しない）
    const ok = evRows.filter((e) => isPublicNotice({ via: e.via, url: e.url }) && !detectLeaks(redact(e.text)).length);
    let cached: CachedItem[] = [];
    let itemCalls = 0;
    const itemTotals = { targets: 0, items: 0, done: 0, hold: 0 };
    if (env.JUDGMENT_10O_REUSE_ITEMS === "1" && existsSync(ITEMS_CACHE)) {
      const c = JSON.parse(readFileSync(ITEMS_CACHE, "utf8")) as { items: CachedItem[]; totals: typeof itemTotals; calls: number };
      cached = c.items;
      Object.assign(itemTotals, c.totals);
    } else {
      const lists = ok.map((e) => ({ e, p: parseListItems(redact(e.text)) })).filter((x) => x.p.isList && x.p.items.length >= 3 && x.p.items.length <= 12).sort((a, b) => (a.e.id < b.e.id ? -1 : 1)).slice(0, 10);
      const registeredCand = new Set(candOf.values());
      const singles = ok.filter((e) => registeredCand.has(e.id) && !parseListItems(redact(e.text)).isList).sort((a, b) => (a.id < b.id ? -1 : 1)).slice(0, 4);
      const targets = [...lists.map((x) => ({ e: x.e, single: false })), ...singles.map((e) => ({ e, single: true }))];
      const listModel = makeAnthropicListModel(client, { model: gate.model });
      const listBudget = new CallBudget({ maxCalls: 28, maxCostJpy: 15 });
      for (const t of targets) {
        const text = redact(t.e.text);
        const parsed = t.single ? singleItemParent(text) : parseListItems(text);
        if (!parsed.items.length) continue;
        const r = await discoverList({ parsed, model: listModel, store: new MemoryItemStore(), budget: listBudget, now });
        itemTotals.targets++;
        itemTotals.items += parsed.items.length;
        r.results.forEach((res, i) => {
          if (res.status === "done") itemTotals.done++;
          else itemTotals.hold++;
          cached.push({ candidateId: t.e.id, parentKey: parsed.parentKey, single: t.single, groupLabel: parsed.items[i].groupLabel, head: text.slice(0, 120), item: res, range: { start: parsed.items[i].start, end: parsed.items[i].end }, fetchedAt: t.e.fetchedAt, text: parsed.items[i].text });
        });
        if (listBudget.calls >= 28) break;
      }
      absorbBudget(budget, listBudget);
      itemCalls = listBudget.calls;
      writeFileSync(ITEMS_CACHE, JSON.stringify({ note: "項目の判断の保存（ローカル・Git管理外）", items: cached, totals: itemTotals, calls: itemCalls }));
    }
    const itemFacts: SourceFact[] = [];
    for (const c of cached) {
      const f = factFromListItem({ candidateId: c.candidateId, parentKey: c.parentKey, item: c.item, fetchedAt: c.fetchedAt, range: c.range, groupLabel: c.groupLabel, contextTexts: [c.head, c.text] });
      if (f) itemFacts.push(c.single ? { ...f, kind: "unknown" } : f);
    }

    // 条件判定の「前」（10Nの方式）: 見出し・文脈を持たない観測だけで、旧い判定（evaluateOpportunityConditions）
    const itemFactsBefore: SourceFact[] = [];
    for (const c of cached) {
      const f = factFromListItem({ candidateId: c.candidateId, parentKey: c.parentKey, item: c.item, fetchedAt: c.fetchedAt, range: c.range });
      if (f) itemFactsBefore.push(c.single ? { ...f, kind: "unknown", texts: undefined } : { ...f, texts: undefined });
    }

    // ================ ② 補完の実証: 欠落のある登録の応募先ページ（公開・別の発信源）から補完できるか
    const hostUsage = buildHostUsage(regs.map((r) => ({ chainKey: (r.chain ?? "").normalize("NFKC").toLowerCase(), urls: urlsOf.get(r.id) ?? [] })));
    const perHost = new Map<string, number>();
    const enrichTargets = missing
      .filter((r) => (urlsOf.get(r.id) ?? []).some(fetchableUrl) && (!r.applyStart || !r.resultDate))
      .sort((a, b) => a.protectedCodes.length - b.protectedCodes.length || (a.id < b.id ? -1 : 1))
      .filter((r) => {
        const u = (urlsOf.get(r.id) ?? []).find(fetchableUrl) as string;
        const h = canonUrl(u).host;
        if ((perHost.get(h) ?? 0) >= 2) return false;
        perHost.set(h, (perHost.get(h) ?? 0) + 1);
        return true;
      })
      .slice(0, MAX_TARGETS - itemTotals.targets);
    const extractor = makeAnthropicPageExtractor(client, { model: gate.model });
    const enrichLog: { regId: string; host: string; outcome: string; protectedReg: boolean; fields: string[]; page?: { kind: string; verifiedDates: Record<string, string>; unit: string | null; quotes: Record<string, string> }; before?: Record<string, unknown>; rejected?: string[] }[] = [];
    const pageFacts: SourceFact[] = [];
    for (const r of enrichTargets) {
      const url = (urlsOf.get(r.id) ?? []).find(fetchableUrl) as string;
      const host = canonUrl(url).host;
      const log = { regId: r.id, host, protectedReg: r.protectedCodes.length > 0, fields: [] as string[] };
      const page = await fetchPublic(url);
      if (!page.ok) { enrichLog.push({ ...log, outcome: `fetch_${page.reason}` }); continue; }
      const s = budget.start("page_extract", pageExtractReserveJpy(gate.model));
      if (!s.ok) { enrichLog.push({ ...log, outcome: `budget_${s.reason}` }); break; }
      const ex = await extractor(page.text);
      s.finish(ex.costJpy);
      if (!ex.facts) { enrichLog.push({ ...log, outcome: "extraction_failed" }); continue; }
      if (ex.facts.pageKind === "other") { enrichLog.push({ ...log, outcome: "page_not_lottery" }); continue; }
      const v = verifyPageFacts(ex.facts, page.text);
      const verdict = hostHistoryVerdict(host, hostUsage, (r.chain ?? "").normalize("NFKC").toLowerCase());
      const kind = kindForSource(ex.facts.pageKind === "apply_form" ? "form" : "site", verdict);
      const fields: SourceFact["fields"] = { chain: ex.facts.chain, store: ex.facts.store, products: ex.facts.products };
      const evid: NonNullable<SourceFact["evidence"]> = {};
      for (const [k, val] of Object.entries(v.verified)) { (fields as Record<string, string>)[k] = val as string; evid[k as "applyStart"] = { quoteVerified: true, range: null, image: null }; }
      if (v.unitVerified) { fields.applyUnit = ex.facts.applyUnit as never; evid.applyUnit = { quoteVerified: true, range: null, image: null }; }
      const pf: SourceFact = { sourceId: `page:${r.id.slice(0, 8)}`, kind, fetchedAt: now.toISOString(), fields, evidence: evid, urls: [url] };
      pageFacts.push(pf);
      const before = { applyStart: r.applyStart, applyDeadline: r.applyDeadline, resultDate: r.resultDate, store: r.store };
      const gotNew = (["applyStart", "resultDate"] as const).filter((k) => !r[k] && v.verified[k]);
      enrichLog.push({ ...log, outcome: gotNew.length ? "candidate" : Object.keys(v.verified).length ? "nothing_new_in_page" : "page_values_unverified", fields: gotNew, page: { kind, verifiedDates: v.verified, unit: v.unitVerified ? ex.facts.applyUnit : null, quotes: Object.fromEntries(Object.entries(ex.facts.dates).map(([k, d]) => [k, d.quote])) }, before, rejected: v.rejected });
    }
    // 登録と、取得したページの観測を照合して、補完の提案を求める（同じ応募機会と判定されたものだけが補完になる）
    const regById = new Map(regFacts.map((f) => [(f.registration as { id: string }).id, f]));
    const enriched: { regId: string; protectedReg: boolean; proposals: unknown[]; relation: RelationKind; host: string }[] = [];
    for (const l of enrichLog.filter((x) => x.outcome === "candidate")) {
      const rf = regById.get(l.regId) as SourceFact;
      const pf = pageFacts.find((p) => p.sourceId === `page:${l.regId.slice(0, 8)}`) as SourceFact;
      const cs = clusterFacts([rf, pf]);
      const c = cs.find((x) => x.members.includes(rf.sourceId)) as Cluster;
      const together = c.members.includes(pf.sourceId);
      const props = c.proposals.filter((p) => p.registrationId === l.regId);
      const rel = pairRelations([rf, pf])[0]?.relation.kind ?? "unknown";
      if (together && props.length) enriched.push({ regId: l.regId, protectedReg: l.protectedReg, proposals: props.map((p) => ({ field: p.field, op: p.op, value: p.value, protected: p.protected })), relation: rel, host: l.host });
      else l.outcome = together ? "no_proposal" : `not_same_opportunity_${rel}`;
    }
    const enrichFunnel = count(enrichLog.map((l) => l.outcome));
    enrichFunnel.enriched_proposals = enriched.length;

    // ================ ③ 公式の識別: サイト→アカウントのリンク（公開ページ）と、アカウント→サイトのリンク（保存した投稿のリンク）の相互確認
    const pairs: { host: string; handle: string; accountLinks: string[] }[] = [];
    for (const e of evRows) {
      const handle = handleOf(e.url);
      if (!handle) continue;
      for (const l of e.links ?? []) {
        const c = canonUrl(l);
        if (c.cls === "specific" && !isSharedHost(c.host)) pairs.push({ host: c.host, handle, accountLinks: e.links ?? [] });
      }
    }
    const uniqPairs = [...new Map(pairs.map((p) => [`${p.host}|${p.handle}`, p])).values()].slice(0, 12);
    const officialResults: { host: string; status: string; basis: string }[] = [];
    for (const p of uniqPairs) {
      const home = await fetchPublic(`https://${p.host}/`);
      const v = verifyOfficialPair({ host: p.host, siteLinks: home.ok ? home.links : null, siteCheckedAt: home.ok ? now.toISOString() : null, handle: p.handle, accountLinks: p.accountLinks, accountCheckedAt: now.toISOString() }, now);
      officialResults.push({ host: p.host, status: v.status, basis: v.basis[0]?.code ?? "" });
    }

    // ================ ④ クラスタリング・ブロッキング・条件の前後比較・判断基準
    const all = [...regFacts, ...itemFacts];
    const sortedForIdx = [...all].sort((x, y) => (x.sourceId < y.sourceId ? -1 : 1));
    const tIdx = Date.now();
    const blockedPairs = candidatePairIndexes(sortedForIdx).length;
    const msBlocked = Date.now() - tIdx;
    const fullPairsN = (all.length * (all.length - 1)) / 2;
    const t0 = Date.now();
    const rel = pairRelations(all);
    const msRel = Date.now() - t0;
    const nonIndep = (xs: ReturnType<typeof pairRelations>): string[] => xs.filter((p) => p.relation.kind !== "independent").map((p) => `${p.a}|${p.b}|${p.relation.kind}`).sort();
    const equalToFull = JSON.stringify(nonIndep(rel)) === JSON.stringify(nonIndep(pairRelationsAll(all)));
    const byId = new Map(all.map((f) => [f.sourceId, f]));
    // AI照合: 決定的に不明なペアを2回ずつ（揺れの測定）。結論が全回一致し独立根拠を満たすものだけ「統合の候補」
    const adjCand = rel.filter((p) => p.relation.kind === "unknown" && p.relation.evidence.includes("chain_same") && !p.relation.evidence.includes("store_different") && !p.relation.evidence.includes("product_disjoint") && !(byId.get(p.a)?.kind === "registration" && byId.get(p.b)?.kind === "registration")).sort((x, y) => y.relation.score - x.relation.score || (x.a + x.b < y.a + y.b ? -1 : 1)).slice(0, 6);
    const adjudicate = makeAnthropicPairAdjudicator(client, { model: gate.model });
    const policyOutcomes: { outcome: string; runs: RelationKind[] }[] = [];
    const mergeMap = new Map<string, RelationKind>();
    for (const p of adjCand) {
      const runs: RelationKind[] = [];
      for (let k = 0; k < 2; k++) {
        const s = budget.start("adjudicate", adjudicateReserveJpy(gate.model));
        if (!s.ok) break;
        const r = await adjudicate(byId.get(p.a) as SourceFact, byId.get(p.b) as SourceFact);
        s.finish(r.costJpy);
        runs.push(r.verdict);
      }
      const o = applyAdjudicationPolicy(p.relation, runs);
      policyOutcomes.push({ outcome: o.outcome, runs });
      if (o.outcome === "merge_candidate") mergeMap.set(pairKey(p.a, p.b), "same_opportunity");
    }
    const unresolvedBy = new Map<string, number>();
    for (const p of rel) if (p.relation.kind === "unknown" && p.relation.evidence.includes("chain_same") && !p.relation.evidence.includes("store_different") && !p.relation.evidence.includes("product_disjoint") && p.relation.score >= 0.3 && !mergeMap.has(pairKey(p.a, p.b))) for (const id of [p.a, p.b]) unresolvedBy.set(id, (unresolvedBy.get(id) ?? 0) + 1);
    const unstableIds = new Set(adjCand.filter((_, i) => policyOutcomes[i]?.outcome === "hold_unstable").flatMap((p) => [p.a, p.b]));
    const clusters = clusterFacts(all, { adjudicated: mergeMap });

    // 条件: 前（10Nの方式: 見出し・文脈・店舗マスターなし）と後（段階的な解決）
    const cs = (snap.collection_settings[0] ?? {}) as { prefectures?: string[]; include_online?: boolean; product_mode?: "all" | "include" | "exclude" };
    const cond = { prefectures: cs.prefectures ?? [], includeOnline: cs.include_online ?? true, productMode: (cs.product_mode ?? "all") as "all" };
    const storeMaster = (chain: string | null, store: string | null): { prefecture: string | null } | null => {
      const k = nStore(store);
      if (k.length < 3) return null;
      const hit = snap.stores.filter((s) => !s.archived_at && chainsMatch(chainName.get(s.chain_id as string) ?? null, chain) === "same" && storesMatch(s.name as string, store) !== "different" && storesMatch(s.name as string, store) !== "unknown");
      const prefs = new Set(hit.map((s) => s.prefecture as string).filter(Boolean));
      return prefs.size === 1 ? { prefecture: [...prefs][0] } : null;
    };
    const productMaster = (name: string): boolean => snap.products.some((p) => ["same", "overlap"].includes(productsMatch([name], [p.official_name as string])));
    const itemClusters = clusters.filter((c) => c.registrations.length === 0 && c.members.some((m) => byId.get(m)?.kind !== "registration"));
    const gv = (c: Cluster, n: string): unknown => c.fields.find((f) => f.field === n)?.adopted ?? c.fields.find((f) => f.field === n)?.candidates[0]?.value ?? null;
    const before = { eligible: 0, ineligible: 0, unknown: 0 };
    const after = { eligible: 0, ineligible: 0, unknown: 0 };
    const afterPrimary: string[] = [];
    const stageCounts: string[] = [];
    const resolvedByCluster = new Map<string, ResolvedConditions>();
    const toAssist: AssistInput[] = [];
    itemClusters.forEach((c, idx) => {
      const base = { chain: gv(c, "chain") as string | null, store: gv(c, "store") as string | null, prefecture: gv(c, "prefecture") as string | null, products: (gv(c, "products") as string[] | null) ?? [] };
      const texts = c.members.flatMap((m) => byId.get(m)?.texts ?? []);
      const r = resolveConditions({ ...base, texts }, cond, [], { storeMaster, productMaster });
      after[r.verdict]++;
      resolvedByCluster.set(c.clusterId, r);
      if (r.verdict === "unknown") { afterPrimary.push(r.primaryUnknown ?? "unknown"); toAssist.push({ i: idx, chain: base.chain, store: base.store, products: base.products, context: texts.join(" ") }); }
      stageCounts.push(`region:${r.stages.region}`, `tcg:${r.stages.tcg}`);
    });
    const beforeReasons: string[] = [];
    const gvB = (c: Cluster, n: string): unknown => c.fields.find((f) => f.field === n)?.adopted ?? c.fields.find((f) => f.field === n)?.candidates[0]?.value ?? null;
    const beforeClusters = clusterFacts([...regFacts, ...itemFactsBefore]).filter((c) => c.registrations.length === 0 && c.members.some((m) => !m.startsWith("reg:")));
    for (const c of beforeClusters) {
      const r0 = evaluateOpportunityConditions({ chain: gvB(c, "chain") as string | null, store: gvB(c, "store") as string | null, prefecture: gvB(c, "prefecture") as string | null, products: (gvB(c, "products") as string[] | null) ?? [] }, cond, []);
      before[r0.verdict]++;
      if (r0.verdict === "unknown") beforeReasons.push(...r0.reasons.filter((x) => x === "region_unknown" || x === "tcg_unknown" || x === "tcg_mixed_needs_review"));
    }
    // AI補助（提案のみ）: 不明のものを最大2回の呼び出しでまとめて。出典の抜粋が文脈に実在し、県名が抜粋に含まれるものだけ「検証済み」
    const assistFn = makeAnthropicConditionAssist(client, { model: gate.model });
    const suggestions: { i: number; verified: boolean; prefecture: string | null }[] = [];
    for (let k = 0; k < 2 && k * 12 < toAssist.length; k++) {
      const batch = toAssist.slice(k * 12, k * 12 + 12);
      const s = budget.start("assist", assistReserveJpy(gate.model));
      if (!s.ok) break;
      const r = await assistFn(batch);
      s.finish(r.costJpy);
      for (const x of r.suggestions) {
        const ctxText = (batch.find((b) => b.i === x.i)?.context ?? "").normalize("NFKC");
        const verified = !!x.prefecture && x.prefectureQuote.length >= 2 && ctxText.includes(x.prefectureQuote.normalize("NFKC")) && x.prefectureQuote.normalize("NFKC").includes(x.prefecture.replace(/[都府県]$/, ""));
        suggestions.push({ i: x.i, verified, prefecture: x.prefecture });
      }
    }
    // 検証済みの補助を加えた後の判定
    const afterAssist = { eligible: 0, ineligible: 0, unknown: 0 };
    itemClusters.forEach((c, idx) => {
      const base = { chain: gv(c, "chain") as string | null, store: gv(c, "store") as string | null, prefecture: gv(c, "prefecture") as string | null, products: (gv(c, "products") as string[] | null) ?? [] };
      const sg = suggestions.find((s) => s.i === idx && s.verified);
      afterAssist[resolveConditions({ ...base, texts: c.members.flatMap((m) => byId.get(m)?.texts ?? []) }, cond, [], { storeMaster, productMaster }, { prefecture: sg?.prefecture ?? null }).verdict]++;
    });

    // 判断基準: 全応募機会（登録に結びつくもの含む）
    const decisions: Decision[] = [];
    const reasonsHist: string[] = [];
    const review: unknown[] = [];
    for (const c of clusters) {
      const el = resolvedByCluster.get(c.clusterId) ?? null;
      const dup = c.members.reduce((n, m) => n + (unresolvedBy.get(m) ?? 0), 0);
      const d = decideOpportunity({ cluster: c, eligibility: el, now, unresolvedDuplicatePairs: dup, aiUnstable: c.members.some((m) => unstableIds.has(m)), isLottery: true });
      decisions.push(d.decision);
      if (c.registrations.length === 0) for (const r of d.reasons) reasonsHist.push(`${d.decision}:${r}`);
      if (c.members.length >= 2 || d.decision === "auto_register_preview" || d.decision === "candidate_with_gaps") review.push({ clusterId: c.clusterId, decision: d.decision, reasons: d.reasons, members: c.members.map((m) => ({ id: m, kind: byId.get(m)?.kind, fields: byId.get(m)?.fields })), fields: c.fields, proposals: c.proposals, contested: c.contested, applyUnit: c.applyUnit, eligibility: el ? { verdict: el.verdict, reasons: el.reasons, stages: el.stages } : null });
    }
    // 補完の事例（人の確認用）: 登録の現在値・ページの値・根拠の抜粋・提案
    const enrichReview = enrichLog.filter((l) => l.outcome === "candidate" || enriched.some((e) => e.regId === l.regId)).map((l) => ({ regId: l.regId, host: l.host, protectedReg: l.protectedReg, before: l.before, page: l.page, proposals: enriched.find((e) => e.regId === l.regId)?.proposals ?? [] }));

    const summary = {
      note: "Stage 10O 実データ評価（ローカル・Git管理外）。人の確認は行っていない。種類 unknown は公式が裏付けられない発信者",
      funnel,
      items: { ...itemTotals, registrableFacts: itemFacts.length, reusedFromCache: env.JUDGMENT_10O_REUSE_ITEMS === "1" },
      enrichment: { targets: enrichTargets.length, funnel: enrichFunnel, enrichedProposals: enriched.length, enrichedProtected: enriched.filter((e) => e.protectedReg).length, relationOfEnriched: count(enriched.map((e) => e.relation)) },
      official: { checked: officialResults.length, byStatus: count(officialResults.map((o) => o.status as "x")), byBasis: count(officialResults.map((o) => o.basis as "x")) },
      pairSearch: { facts: all.length, allPairs: fullPairsN, blockedCandidatePairs: blockedPairs, reductionPct: Math.round((1 - blockedPairs / fullPairsN) * 1000) / 10, equalToFull, msBlocked, msRel },
      adjudication: { candidates: adjCand.length, runsPerPair: 2, outcomes: count(policyOutcomes.map((p) => p.outcome as "x")), unstable: policyOutcomes.filter((p) => p.outcome === "hold_unstable").length },
      conditions: { opportunities: itemClusters.length, opportunitiesBefore: beforeClusters.length, before, beforeUnknownReasons: count(beforeReasons as "x"[]), after, afterVerifiedAssist: afterAssist, unknownCausesAfter: count(afterPrimary as "x"[]), stages: count(stageCounts as "x"[]), assist: { suggestions: suggestions.length, verified: suggestions.filter((s) => s.verified).length } },
      decisions: { registrationClustersWithProposals: clusters.filter((c) => c.registrations.length > 0 && c.proposals.length > 0).length, all: count(decisions), reasonsForNew: count(reasonsHist as "x"[]) },
      clusters: { total: clusters.length, multiSource: clusters.filter((c) => c.members.length >= 2).length },
      fetches: fetchCount,
      budget: budget.summary(),
    };
    writeFileSync("eval/real-data/xsource-10o.json", JSON.stringify(summary, null, 1));
    writeFileSync("eval/real-data/human-review-10o.json", JSON.stringify({ note: "人の確認用（ローカルのみ・Git管理外）", opportunities: review, enrichment: enrichReview, official: officialResults, adjudication: policyOutcomes }, null, 1));
    expect(budget.calls).toBeLessThanOrEqual(MAX_CALLS);
    expect(budget.costJpy).toBeLessThanOrEqual(MAX_COST + 0.01);
    expect(fetchCount).toBeLessThanOrEqual(MAX_FETCHES);
    expect(itemTotals.targets + enrichTargets.length).toBeLessThanOrEqual(MAX_TARGETS);
    expect(equalToFull).toBe(true);
    expect(enriched.every((e) => e.proposals.every((p) => !(p as { protected: boolean }).protected || (p as { op: string }).op === "ask_human"))).toBe(true);
  }, 1_800_000);
});
