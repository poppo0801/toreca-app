// @vitest-environment node
/**
 * Stage 10N: 複数情報源の照合・補完・矛盾検出・誤統合の防止・対象条件・応募構造の自律調査の実データ評価（実AI・有料・書き込みなし・DB不要）。
 *   入力: ローカルの本番書き出し（登録済みの抽選＝既存の登録）と、保存原文（一覧・単独告知）。**本番には接続しない**。
 *   工程: ①一覧・単独告知の項目をAIで判断（10M）→ ②登録＋項目を、到着順に依存せずクラスタリング（決定的）→ ③決定的に不明なペアだけAIで照合 → ④構造調査（公開の応募ページを上限つきで取得し応募単位を判断）。
 *   上限（全工程合算のハード上限）: 呼び出し 90回（再試行・再評価・画像・調査を含む）・費用 ¥50・1件 ¥3（予約）・対象 30件・取得 60回。超えそうなら停止して未完了を報告。
 *   出力: eval/real-data/xsource-10n.json（集計）と human-review-10n.json（人の確認用）。Git管理外。標準出力は件数のみ。**人の確認は行っていない**。
 * 実行: JUDGMENT_10N_REAL=1 JUDGMENT_REAL_EVAL=allow JUDGMENT_REUSE_EXISTING_KEY=allow JUDGMENT_REAL_CONFIRM=yes JUDGMENT_APPROVED_TOTAL_JPY=50 JUDGMENT_APPROVED_PER_CASE_JPY=3 TOREMANE_ENV=local npx vitest run src/lib/judgment/xsource/xsource-real.test.ts
 */
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { redact } from "@/lib/case-model/redact";
import { isBlockedMessage } from "@/lib/agent/case-investigator/evidence-fetcher";
import { absorbBudget, CallBudget } from "../call-budget";
import { detectLeaks, isPublicNotice } from "../eval/phase2";
import { discoverList, MemoryItemStore } from "../list-discovery";
import { parseListItems, singleItemParent } from "../list-items";
import { makeAnthropicListModel } from "../list-model";
import { checkJudgmentRealRun } from "../real-gate";
import { adjudicateReserveJpy, makeAnthropicPairAdjudicator, makeAnthropicStructureJudge } from "./ai";
import { clusterFacts, pairKey, pairRelations } from "./cluster";
import { evaluateOpportunityConditions } from "./conditions";
import { factFromListItem, factFromRegistration, type RegistrationLike } from "./facts";
import { investigateStructure, type FetchPageFn } from "./investigate";
import { canonUrl } from "./normalize";
import { isSelf } from "./relate";
import type { Cluster, RelationKind, SourceFact } from "./types";

vi.mock("server-only", () => ({}));

const env = process.env;
const MAX_CALLS = Number(env.JUDGMENT_10N_MAX_CALLS ?? 90); // 追加の再実行では、累計が90回を超えないよう上限を下げて実行する
const MAX_COST = 50;
const MAX_TARGETS = 30;
const MAX_FETCHES = 60;
const LIST_CALL_SHARE = 40; // 一覧の判断に使う呼び出しの上限（残りは照合・調査）
const latest = (dir: string, prefix: string): string => `${dir}/${readdirSync(dir).filter((f) => f.startsWith(prefix)).sort().at(-1)}`;
const jst = (iso: string | null): string | null => (iso ? new Date(Date.parse(iso) + 9 * 3600_000).toISOString().slice(0, 16).replace("T", " ") : null);

interface Ev { id: string; text: string; via: string; url: string; fetchedAt: string }
type Row = Record<string, unknown>;

describe.skipIf(env.JUDGMENT_10N_REAL !== "1")("10N 複数情報源の照合・補完: 実データ評価（有料）", () => {
  it("同じ抽選の情報を照合して補完し、誤統合を防ぎ、対象条件を判定し、応募構造を調査する", async () => {
    const gate = checkJudgmentRealRun({ env, confirm: env.JUDGMENT_REAL_CONFIRM === "yes", approvedTotalJpy: Number(env.JUDGMENT_APPROVED_TOTAL_JPY), approvedPerCaseJpy: Number(env.JUDGMENT_APPROVED_PER_CASE_JPY) });
    if (!gate.ok) throw new Error(`実行しません: ${gate.reason}`);

    // ---------------- 入力（ローカルの書き出し。本番には接続しない）
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

    const regs: RegistrationLike[] = snap.lotteries
      .filter((l) => !l.archived_at)
      .map((l) => {
        const st = l.store_id ? storeById.get(l.store_id as string) : undefined;
        return {
          id: l.id as string,
          candidateId: candOf.get(l.id as string) ?? null,
          chain: chainName.get(l.chain_id as string) ?? null,
          store: (st?.name as string | undefined) ?? null,
          prefecture: (st?.prefecture as string | undefined) ?? null,
          products: itemsBy.get(l.id as string) ?? [],
          applyStart: jst((l.apply_start_at as string) ?? null),
          applyDeadline: jst((l.apply_deadline_at as string) ?? null),
          resultDate: (l.result_date as string) ?? null,
          applyUrl: ((l.source_urls as string[] | null) ?? [])[0] ?? null,
          protectedCodes: (appCount.get(l.id as string) ?? 0) > 0 ? ["applications"] : [],
          updatedAt: (l.updated_at as string) ?? null,
        };
      });
    const regFacts = regs.map(factFromRegistration);
    const urlsOfReg = new Map(snap.lotteries.map((l) => [l.id as string, ((l.source_urls as string[] | null) ?? []).filter((u) => typeof u === "string")]));
    for (const f of regFacts) f.urls = urlsOfReg.get((f.registration as { id: string }).id);

    // ---------------- 対象の選定（最大30件。一覧12件＋単独告知）: 公開の告知で、秘密値を含まないもの
    const ok = evRows.filter((e) => isPublicNotice({ via: e.via, url: e.url }) && !detectLeaks(redact(e.text)).length);
    const lists = ok.map((e) => ({ e, p: parseListItems(redact(e.text)) })).filter((x) => x.p.isList && x.p.items.length >= 3 && x.p.items.length <= 12).sort((a, b) => (a.e.id < b.e.id ? -1 : 1));
    const registeredCand = new Set(candOf.values());
    const singles = ok.filter((e) => registeredCand.has(e.id) && !parseListItems(redact(e.text)).isList).sort((a, b) => (a.id < b.id ? -1 : 1));
    const targets = [...lists.slice(0, 12).map((x) => ({ e: x.e, single: false })), ...singles.slice(0, MAX_TARGETS - Math.min(12, lists.length)).slice(0, 12).map((e) => ({ e, single: true }))].slice(0, MAX_TARGETS);

    const { default: Anthropic } = await import("@anthropic-ai/sdk");
    const client = new Anthropic({ apiKey: gate.apiKey, maxRetries: 0 });
    await client.models.retrieve(gate.model);
    const budget = new CallBudget({ maxCalls: MAX_CALLS, maxCostJpy: Math.min(MAX_COST, gate.totalCapJpy) });
    const listModel = makeAnthropicListModel(client, { model: gate.model });
    const now = new Date();

    // ---------------- ① 項目の判断（一覧の全項目・単独告知）
    const listBudget = new CallBudget({ maxCalls: LIST_CALL_SHARE, maxCostJpy: 25 });
    const itemFacts: SourceFact[] = [];
    let itemsTotal = 0;
    let itemsDone = 0;
    let itemsHold = 0;
    for (const t of targets) {
      const text = redact(t.e.text);
      const parsed = t.single ? singleItemParent(text) : parseListItems(text);
      if (!parsed.items.length) continue;
      const r = await discoverList({ parsed, model: listModel, store: new MemoryItemStore(), budget: listBudget, now });
      itemsTotal += parsed.items.length;
      r.results.forEach((res, i) => {
        if (res.status === "done") itemsDone++;
        else itemsHold++;
        const f = factFromListItem({ candidateId: t.e.id, parentKey: parsed.parentKey, item: res, fetchedAt: t.e.fetchedAt, range: { start: parsed.items[i].start, end: parsed.items[i].end } });
        if (f) {
          // 単独告知は発信者（公式かどうか）を判別していないため、種類は unknown（公式とみなさない）
          itemFacts.push(t.single ? { ...f, kind: "unknown" } : f);
        }
      });
      if (listBudget.calls >= LIST_CALL_SHARE) break;
    }
    absorbBudget(budget, listBudget); // 全体の予算へ合算（回数・費用）

    // ---------------- ② クラスタリング（決定的）と、到着順・再実行の不変性の検証
    const all = [...regFacts, ...itemFacts];
    const t0 = Date.now();
    const base = clusterFacts(all);
    const ms = Date.now() - t0;
    const shape = (cs: Cluster[]): string[] => cs.map((c) => `${c.clusterId}:${c.members.join(",")}:${c.applyUnit.value}`).sort();
    const reversed = shape(clusterFacts([...all].reverse()));
    const shuffled = shape(clusterFacts([...all].sort((a, b) => ((a.sourceId.length * 31 + a.sourceId.charCodeAt(5)) % 7) - ((b.sourceId.length * 31 + b.sourceId.charCodeAt(5)) % 7))));
    const stable = JSON.stringify(shape(base)) === JSON.stringify(reversed) && JSON.stringify(shape(base)) === JSON.stringify(shuffled);

    // ---------------- ③ 決定的に不明なペアだけAIで照合（上限20回）
    const pairs = pairRelations(all);
    const selfPairs = all.flatMap((a, i) => all.slice(i + 1).filter((b) => isSelf(a, b))).length;
    const byKind: Record<RelationKind, number> = { same_opportunity: 0, same_campaign_different_opportunity: 0, independent: 0, unknown: 0 };
    for (const p of pairs) byKind[p.relation.kind]++;
    const byId = new Map(all.map((f) => [f.sourceId, f]));
    const adjCandidates = pairs
      .filter((p) => p.relation.kind === "unknown" && p.relation.evidence.includes("chain_same") && !p.relation.evidence.includes("store_different") && !p.relation.evidence.includes("product_disjoint"))
      .filter((p) => byId.get(p.a)?.kind !== "registration" || byId.get(p.b)?.kind !== "registration")
      .sort((x, y) => y.relation.score - x.relation.score || (x.a + x.b < y.a + y.b ? -1 : 1))
      .slice(0, 20);
    const adjudicate = makeAnthropicPairAdjudicator(client, { model: gate.model });
    const adjudicated = new Map<string, RelationKind>();
    const adjLog: { pair: string; verdict: RelationKind; rationale: string }[] = [];
    for (const p of adjCandidates) {
      const s = budget.start("adjudicate", adjudicateReserveJpy(gate.model));
      if (!s.ok) break;
      const r = await adjudicate(byId.get(p.a) as SourceFact, byId.get(p.b) as SourceFact);
      s.finish(r.costJpy);
      adjudicated.set(pairKey(p.a, p.b), r.verdict);
      adjLog.push({ pair: pairKey(p.a, p.b), verdict: r.verdict, rationale: r.rationale });
    }
    const withAdj = clusterFacts(all, { adjudicated });
    // AIは「無関係・別の応募機会」の決定的な判定を覆せない（unknown のペアだけを動かす）
    const overridden = pairs.filter((p) => (p.relation.kind === "independent" || p.relation.kind === "same_campaign_different_opportunity") && adjudicated.get(pairKey(p.a, p.b)) === "same_opportunity").length;

    // ---------------- 集計（応募機会ごと）
    const multi = (cs: Cluster[]): Cluster[] => cs.filter((c) => c.members.length >= 2);
    const kindsOf = (c: Cluster): string => [...new Set(c.members.map((m) => byId.get(m)?.kind))].sort().join("+");
    const composition: Record<string, number> = {};
    for (const c of multi(withAdj)) composition[kindsOf(c)] = (composition[kindsOf(c)] ?? 0) + 1;
    const proposalsBy: Record<string, number> = {};
    let protectedProposals = 0;
    for (const c of withAdj) for (const p of c.proposals) {
      proposalsBy[`${p.op}:${p.field}`] = (proposalsBy[`${p.op}:${p.field}`] ?? 0) + 1;
      if (p.protected) protectedProposals++;
      expect(p.executable).toBe(false);
    }
    const conflictsBy: Record<string, number> = {};
    for (const c of withAdj) for (const f of c.fields) if (f.status === "conflict") conflictsBy[f.field] = (conflictsBy[f.field] ?? 0) + 1;
    const enrichedBy: Record<string, number> = {};
    for (const c of withAdj) for (const f of c.fields) if (f.status === "enriched") enrichedBy[f.field] = (enrichedBy[f.field] ?? 0) + 1;
    const contestedTotal = withAdj.reduce((n, c) => n + c.contested.length, 0);
    const multiRegs = withAdj.filter((c) => c.registrations.length >= 2);

    // 対象条件: 一覧・単独告知から確定した応募機会（登録を含まない）に、利用者の収集条件を適用する
    const cs = (snap.collection_settings[0] ?? {}) as { prefectures?: string[]; include_online?: boolean; product_mode?: "all" | "include" | "exclude"; product_ids?: string[] };
    const cond = { prefectures: cs.prefectures ?? [], includeOnline: cs.include_online ?? true, productMode: (cs.product_mode ?? "all") as "all" };
    const fromItems = withAdj.filter((c) => c.members.every((m) => !byId.get(m)?.registration) || c.registrations.length === 0).filter((c) => c.members.some((m) => !byId.get(m)?.registration));
    const elig = { eligible: 0, ineligible: 0, unknown: 0 };
    const eligReasons: Record<string, number> = {};
    for (const c of fromItems) {
      const g = (n: string): unknown => c.fields.find((f) => f.field === n)?.adopted ?? c.fields.find((f) => f.field === n)?.candidates[0]?.value ?? null;
      const r = evaluateOpportunityConditions({ chain: g("chain") as string | null, store: g("store") as string | null, prefecture: g("prefecture") as string | null, products: (g("products") as string[] | null) ?? [] }, cond, []);
      elig[r.verdict]++;
      for (const x of r.reasons) eligReasons[x] = (eligReasons[x] ?? 0) + 1;
    }

    // ---------------- ④ 応募構造の自律調査（公開の具体的な応募ページ。5件・1件あたり取得4回まで）
    const safe = new (await import("@/lib/server/agent/real-providers")).SafePageFetcher();
    let fetchCount = 0;
    const fetchPage: FetchPageFn = async (url) => {
      if (fetchCount >= MAX_FETCHES) return { ok: false, reason: "failed" };
      fetchCount++;
      const r = await safe.fetchPage(url);
      if (!r.ok) return { ok: false, reason: isBlockedMessage(r.message) ? "robots" : "failed" };
      return { ok: true, text: r.text, links: (r.links ?? []).map((l) => ({ url: l.href, text: l.text })) };
    };
    const judgeStruct = makeAnthropicStructureJudge(client, { model: gate.model });
    const investTargets = withAdj.filter((c) => c.members.some((m) => (byId.get(m)?.urls ?? []).some((u) => /^https:\/\//.test(u) && canonUrl(u).cls === "specific")));
    const invest: { cluster: string; host: string | null; hold: string | null; applyUnit: string | null; quoteVerified: boolean; fetches: number; steps: string[] }[] = [];
    const doneKeys = new Set<string>();
    for (const c of investTargets.slice(0, 5)) {
      const r = await investigateStructure({ members: c.members.map((m) => byId.get(m) as SourceFact), fetchPage, judge: judgeStruct, budget, done: doneKeys });
      invest.push({ cluster: c.clusterId, host: r.finding?.host ?? null, hold: r.hold, applyUnit: r.finding?.applyUnit ?? null, quoteVerified: r.finding?.quoteVerified ?? false, fetches: r.fetches, steps: r.steps.map((s) => `${s.kind}:${s.status}`) });
    }
    // 再実行: 調査済みのページは再取得も再判断もしない（追加費用0）
    const callsBeforeRerun = budget.calls;
    const fetchesBeforeRerun = fetchCount;
    for (const c of investTargets.slice(0, 5)) await investigateStructure({ members: c.members.map((m) => byId.get(m) as SourceFact), fetchPage, judge: judgeStruct, budget, done: doneKeys });
    const rerun = { calls: budget.calls - callsBeforeRerun, fetches: fetchCount - fetchesBeforeRerun };

    // ---------------- 出力
    const summary = {
      note: "Stage 10N 実データ評価（ローカル・Git管理外）。人の確認は行っていない。種類 unknown は発信者未判別の単独告知",
      targets: targets.length,
      lists: targets.filter((t) => !t.single).length,
      singles: targets.filter((t) => t.single).length,
      items: { total: itemsTotal, done: itemsDone, hold: itemsHold, registrableFacts: itemFacts.length },
      registrations: regFacts.length,
      facts: all.length,
      pairs: { total: pairs.length, byKind, selfExcluded: selfPairs },
      clusters: { total: withAdj.length, multiSource: multi(withAdj).length, composition, duplicateRegistrations: multiRegs.length },
      enrichment: { enrichedFields: enrichedBy, proposals: proposalsBy, protectedProposals },
      conflicts: conflictsBy,
      misMergeGuard: { contested: contestedTotal, aiOverrideOfNotSame: overridden },
      invariance: { orderIndependent: stable, ms },
      adjudication: { candidates: adjCandidates.length, calls: adjLog.length, verdicts: adjLog.reduce<Record<string, number>>((m, x) => ((m[x.verdict] = (m[x.verdict] ?? 0) + 1), m), {}) },
      conditions: { extractedOpportunities: fromItems.length, ...elig, reasons: eligReasons, registrable: elig.eligible },
      investigation: { runs: invest.length, fetches: fetchCount, rerun, results: invest },
      budget: budget.summary(),
    };
    writeFileSync("eval/real-data/xsource-10n.json", JSON.stringify(summary, null, 1));
    writeFileSync(
      "eval/real-data/human-review-10n.json",
      JSON.stringify({ note: "人の確認用（ローカルのみ・Git管理外）。応募機会ごとの情報源・項目・出典・提案", opportunities: multi(withAdj).map((c) => ({ clusterId: c.clusterId, members: c.members.map((m) => ({ id: m, kind: byId.get(m)?.kind, fields: byId.get(m)?.fields })), fields: c.fields, proposals: c.proposals, contested: c.contested, applyUnit: c.applyUnit })), adjudication: adjLog }, null, 1),
    );
    expect(budget.calls).toBeLessThanOrEqual(MAX_CALLS);
    expect(budget.costJpy).toBeLessThanOrEqual(MAX_COST + 0.01);
    expect(fetchCount).toBeLessThanOrEqual(MAX_FETCHES);
    expect(stable).toBe(true);
    expect(overridden).toBe(0);
    expect(rerun).toEqual({ calls: 0, fetches: 0 });
  }, 1_800_000);
});
