// @vitest-environment node
/**
 * Stage 10R: ヒントの自由度・偏りの検証・応募先ページの実取得・阻害要因の分解の実データ評価（実AI・有料・書き込みなし・DB不要）。
 *   入力: Stage 10P/10Q と同一（保存した一覧項目 55・新規の応募機会 51・登録 235）。**本番には接続しない**。ページ取得は公開ページのみ（既存の安全な取得: SSRF・robots・リダイレクト・サイズ・時間・間隔。ログイン/CAPTCHA回避・フォーム送信なし）。
 *   比較: A=ヒント無し／B=関連ヒントのみ／C=関連ヒント＋無関係なヒントを意図的に混入／D=B＋実際の応募ページの観察。A〜C は同じ入力（ページ観察なし）で、ヒントによる誘導を測る。
 *   上限（全工程合算・開始前に予約・ハード停止）: AI 90回・¥50・1件¥3・対象30・ページ取得60。
 *   出力: eval/real-data/xsource-10r.json（集計）・human-review-10r.json（人の確認用）。Git管理外。**人の確認は行っていない**。
 * 実行: JUDGMENT_10R_REAL=1 JUDGMENT_REAL_EVAL=allow JUDGMENT_REUSE_EXISTING_KEY=allow JUDGMENT_REAL_CONFIRM=yes JUDGMENT_APPROVED_TOTAL_JPY=50 JUDGMENT_APPROVED_PER_CASE_JPY=3 TOREMANE_ENV=local npx vitest run src/lib/judgment/xsource/xsource-10r-real.test.ts
 */
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { CallBudget } from "../call-budget";
import type { ListItemResult } from "../list-discovery";
import { checkJudgmentRealRun } from "../real-gate";
import { makeAnthropicUnitInfer, unitInferReserveJpy } from "./ai-unit";
import { candidateApplyUrls, classifyFetchFailure, excerptApplyPage, pageMatchesItem, type FetchFailure } from "./application-page";
import { extractRestrictionPhrases, summarizePastExamples, verifyUnitInference, type UnitContext, type VerifiedUnitInference } from "./apply-unit";
import { clusterFacts, pairRelations } from "./cluster";
import { resolveConditions } from "./conditions";
import { decideOpportunity, type DecisionResult } from "./decision";
import { factFromListItem, factFromRegistration, type RegistrationLike } from "./facts";
import { loadKnowledge, observeTags, selectHints, type SelectedHint } from "./knowledge/knowledge";
import { canonUrl, chainsMatch, storesMatch } from "./normalize";
import { buildProductMatcher } from "./product-master";
import type { Cluster, SourceFact } from "./types";

vi.mock("server-only", () => ({}));

const env = process.env;
const MAX_CALLS = Number(env.JUDGMENT_10R_MAX_CALLS ?? 90);
const MAX_COST = 50;
const MAX_FETCHES = 60;
/** D のみ再実行（A〜C・架空ケースを省く。累計の呼び出しが上限を超えないようにする） */
const ONLY_D = env.JUDGMENT_10R_ONLY_D === "1";
const latest = (dir: string, prefix: string): string => `${dir}/${readdirSync(dir).filter((f) => f.startsWith(prefix)).sort().at(-1)}`;
const jst = (iso: string | null): string | null => (iso ? new Date(Date.parse(iso) + 9 * 3600_000).toISOString().slice(0, 16).replace("T", " ") : null);
const count = (xs: string[]): Record<string, number> => xs.reduce<Record<string, number>>((m, x) => ((m[x] = (m[x] ?? 0) + 1), m), {});
type Row = Record<string, unknown>;
interface CachedItem { candidateId: string; parentKey: string; single: boolean; groupLabel: string; head: string; item: ListItemResult; range: { start: number; end: number }; fetchedAt: string; text: string }

/** 経験則に対応する**架空の**ケース（テスト用途。実在の系列の実告知ではなく、実測の正解率には混ぜない）。期待は「望ましい方向」であって正解ではない */
const BATTERY: { name: string; chain: string; hosts: string[]; stores: string[]; texts: string[]; expect: string }[] = [
  { name: "LP-複数店舗の選択肢（明示あり）", chain: "架空百貨店", hosts: ["livepocket.jp"], stores: [], texts: ["【応募フォーム】受取店舗をお選びください: 梅田店／難波店／京橋店。応募は1店舗のみ可能です"], expect: "store_select（直接の根拠）" },
  { name: "LP-グループ別（イトーヨーカドー型）", chain: "イトーヨーカドー", hosts: ["livepocket.jp"], stores: [], texts: ["抽選応募 グループA（A店・B店）／グループB（C店・D店）／グループC（E店）／グループD（F店）。各グループごとに1回ずつご応募いただけます"], expect: "per_store_group（記載を優先）" },
  { name: "LPだが店舗別の独立応募（反例）", chain: "架空書店", hosts: ["livepocket.jp"], stores: ["梅田店"], texts: ["梅田店 専用の応募ページです。他店舗の応募は別ページから。梅田店のみの抽選販売"], expect: "per_store（LPの傾向に反論してよい）" },
  { name: "ドラスタ系・店舗ごと（明記なし）", chain: "ドラゴンスター", hosts: ["dorasuta.jp"], stores: ["架空1号店"], texts: ["架空1号店 拡張パック「テスト弾」抽選販売のお知らせ。応募期間 11/22(日)〜11/24(火)"], expect: "per_store（類推・暫定）" },
  { name: "ドラスタ系だが全店共通（反例）", chain: "ドラゴンスター", hosts: ["dorasuta.jp"], stores: [], texts: ["全店舗共通の抽選販売です。ドラゴンスター全店のうち、ご希望の店舗でお受け取りいただけます。応募は1回のみ"], expect: "shared_all_stores／store_select（ヒントに反論）" },
  { name: "他店舗同時応募で落選（制限の記載）", chain: "架空書店", hosts: ["shop.example.com"], stores: ["梅田店", "難波店"], texts: ["梅田店・難波店で同時開催。複数店舗に同時に応募された場合は全て無効（落選）となります"], expect: "store_select（記載を優先）" },
  { name: "店舗受取・多店舗系列・店舗不明（明記なし）", chain: "架空家電", hosts: [], stores: [], texts: ["拡張パック「テスト弾」抽選販売。店頭受取のみ（通販不可）。応募期間 11/22〜11/24"], expect: "store_select／全店共通など（有力な仮説・暫定）" },
  { name: "当選後に受取先を選ぶ（ヨドバシ型）", chain: "ヨドバシカメラ", hosts: [], stores: [], texts: ["抽選販売 ご当選後に、店頭受取または配送をお選びいただきます"], expect: "store_select・after_win" },
  { name: "未想定の方式（当日整理券）", chain: "架空ショップ", hosts: [], stores: ["架空店"], texts: ["当日の朝に店頭で整理券を配布し、その場で抽選を行います。事前の応募フォームはありません"], expect: "other（既存の型に押し込まない）" },
  { name: "商品別フォーム・別開催回", chain: "架空ショップ", hosts: ["shop.example.com"], stores: [], texts: ["商品Aの応募フォームはこちら（第1回: 11/22〆）。商品Bは別フォーム（第2回: 11/29〆）"], expect: "per_product／per_round" },
];
/** C条件で混入する、無関係なヒント（適用対象でもトリガーでもない）。誘導の測定のためだけに使う */
const IRRELEVANT_IDS = ["K-CHAIN-YODOBASHI-AFTERWIN", "K-EVENT-ITOYOKADO-GROUPS", "K-RULE-NO-CROSS-STORE"];

describe.skipIf(env.JUDGMENT_10R_REAL !== "1")("10R ヒントの自由度・偏り・応募先ページ・阻害要因: 実データ評価（有料）", () => {
  it("ヒント無し/関連のみ/無関係混入/ページ観察つきで推論を比較し、応募先ページを実取得し、阻害要因を分解する", async () => {
    const gate = checkJudgmentRealRun({ env, confirm: env.JUDGMENT_REAL_CONFIRM === "yes", approvedTotalJpy: Number(env.JUDGMENT_APPROVED_TOTAL_JPY), approvedPerCaseJpy: Number(env.JUDGMENT_APPROVED_PER_CASE_JPY) });
    if (!gate.ok) throw new Error(`実行しません: ${gate.reason}`);
    const now = new Date();
    const snap = JSON.parse(readFileSync(latest("backups/masters-9h3s", "snapshot-prod-"), "utf8")) as Record<string, Row[]>;
    const evRows = (JSON.parse(readFileSync(latest("backups/refresh-10g", "evidence-"), "utf8")) as { rows: { id: string; links?: string[]; text: string }[] }).rows;
    const evById = new Map(evRows.map((e) => [e.id, e]));
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
    const lotRows = snap.lotteries.filter((l) => !l.archived_at);
    const regs: RegistrationLike[] = lotRows.map((l) => {
      const st = l.store_id ? storeById.get(l.store_id as string) : undefined;
      return { id: l.id as string, candidateId: candOf.get(l.id as string) ?? null, chain: chainName.get(l.chain_id as string) ?? null, store: (st?.name as string | undefined) ?? null, prefecture: (st?.prefecture as string | undefined) ?? null, products: itemsBy.get(l.id as string) ?? [], applyStart: jst((l.apply_start_at as string) ?? null), applyDeadline: jst((l.apply_deadline_at as string) ?? null), resultDate: (l.result_date as string) ?? null, applyUrl: (urlsOf.get(l.id as string) ?? [])[0] ?? null, protectedCodes: (appCount.get(l.id as string) ?? 0) > 0 ? ["applications"] : [], updatedAt: (l.updated_at as string) ?? null };
    });
    const regFacts = regs.map(factFromRegistration);
    for (const f of regFacts) f.urls = urlsOf.get((f.registration as { id: string }).id);
    const itemFacts: SourceFact[] = [];
    const itemMeta = new Map<string, CachedItem>();
    for (const c of cached) {
      const f = factFromListItem({ candidateId: c.candidateId, parentKey: c.parentKey, item: c.item, fetchedAt: c.fetchedAt, range: c.range, groupLabel: c.groupLabel, contextTexts: [c.head, c.text] });
      if (f) { itemFacts.push(f); itemMeta.set(f.sourceId, c); }
    }
    const all = [...regFacts, ...itemFacts];
    const byId = new Map(all.map((f) => [f.sourceId, f]));
    const clusters = clusterFacts(all);
    const rel = pairRelations(all);
    const unresolved = new Map<string, number>();
    const dupPairs: { a: string; b: string; evidence: string[]; score: number }[] = [];
    for (const p of rel) if (p.relation.kind === "unknown" && p.relation.evidence.includes("chain_same") && !p.relation.evidence.includes("store_different") && !p.relation.evidence.includes("product_disjoint") && p.relation.score >= 0.3) { for (const id of [p.a, p.b]) unresolved.set(id, (unresolved.get(id) ?? 0) + 1); dupPairs.push({ a: p.a, b: p.b, evidence: p.relation.evidence, score: p.relation.score }); }
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
    const evalCond = (c: Cluster, facts: SourceFact[], extraTexts: string[] = []) => resolveConditions({ chain: gv(c, "chain") as string | null, store: gv(c, "store") as string | null, prefecture: gv(c, "prefecture") as string | null, products: (gv(c, "products") as string[] | null) ?? [], texts: [...facts.flatMap((f) => f.texts ?? []), ...extraTexts] }, cond, [], { storeMaster, productMaster: (n) => !!matcher.match(n) });
    const newOpps = clusters.filter((c) => c.registrations.length === 0 && c.members.some((m) => !m.startsWith("reg:")));
    const base = newOpps.map((c) => {
      const facts = c.members.map((m) => byId.get(m) as SourceFact);
      const el = evalCond(c, facts);
      const dup = c.members.reduce((n, m) => n + (unresolved.get(m) ?? 0), 0);
      return { c, facts, el, dup, before: decideOpportunity({ cluster: c, facts, eligibility: el, now, unresolvedDuplicatePairs: dup, isLottery: true }) as DecisionResult };
    });
    const targets = base.filter((x) => x.before.decision !== "excluded" && x.before.unitStatus === "unknown");

    // ---------------- 応募先ページの実取得（公開・限度内）。10Qで0件だった原因の調査を含む
    const safe = new (await import("@/lib/server/agent/real-providers")).SafePageFetcher();
    let fetchCount = 0;
    const pageCache = new Map<string, { ok: boolean; failure?: FetchFailure; host: string; finalHost: string; lines: string[]; textHead: string }>();
    const scopeLog: string[] = [];
    const fetchLog: { scope: string; cls: string; outcome: string; failure?: FetchFailure; host: string; finalHost: string; usableLines: number }[] = [];
    const fetchOne = async (url: string, scope: string, cls: string): Promise<{ ok: boolean; host: string; finalHost: string; lines: string[] }> => {
      const key = canonUrl(url).key;
      const hit = pageCache.get(key);
      if (hit) return hit;
      const host = canonUrl(url).host;
      if (fetchCount >= MAX_FETCHES) { const r = { ok: false, failure: "cap" as FetchFailure, host, finalHost: "", lines: [], textHead: "" }; pageCache.set(key, r); fetchLog.push({ scope, cls, outcome: "cap", failure: "cap", host, finalHost: "", usableLines: 0 }); return r; }
      fetchCount++;
      const p = await safe.fetchPage(url);
      if (!p.ok) { const failure = classifyFetchFailure(p.message); const r = { ok: false, failure, host, finalHost: "", lines: [], textHead: "" }; pageCache.set(key, r); fetchLog.push({ scope, cls, outcome: "failed", failure, host, finalHost: "", usableLines: 0 }); return r; }
      const lines = excerptApplyPage(p.text);
      const finalHost = canonUrl(p.finalUrl).host;
      const r = { ok: true, host, finalHost, lines, textHead: p.text.slice(0, 600) };
      pageCache.set(key, r);
      fetchLog.push({ scope, cls, outcome: lines.length ? "ok_usable" : "ok_no_cues", host, finalHost, usableLines: lines.length });
      return r;
    };
    const pageObs = new Map<string, string[]>();
    const pageTexts = new Map<string, string[]>();
    for (const t of targets) {
      const cids = [...new Set(t.facts.map((f) => f.originId?.replace("cand:", "")).filter((x): x is string => !!x))];
      const itemLinks = [...new Set(t.facts.flatMap((f) => (itemMeta.get(f.sourceId)?.text.match(/https:\/\/t\.co\/[A-Za-z0-9]+/g) ?? [])))];
      const parentLinks = [...new Set(cids.flatMap((id) => evById.get(id)?.links ?? []))];
      const cands = candidateApplyUrls({ itemLinks, parentLinks, max: 2 });
      const obs: string[] = [];
      const texts: string[] = [];
      for (const c of cands) {
        const r = await fetchOne(c.url, c.scope, c.cls);
        const pg = pageCache.get(canonUrl(c.url).key);
        const m = pg?.ok && r.lines.length ? pageMatchesItem({ lines: pg.lines, head: pg.textHead }, { store: gv(t.c, "store") as string | null, chain: gv(t.c, "chain") as string | null }) : "scope_mismatch";
        if (r.ok && r.lines.length) scopeLog.push(c.scope + ":" + m);
        if (r.ok && r.lines.length && m !== "scope_mismatch") { obs.push(`ページ（${r.finalHost || r.host}。${c.scope === "parent" ? "親投稿に付いていたリンク先" : "項目のリンク先"}。この項目の店舗に対応するページと確認できた）: ${r.lines.join(" / ")}`.slice(0, 1900)); texts.push(...r.lines); }
      }
      pageObs.set(t.c.clusterId, obs);
      pageTexts.set(t.c.clusterId, texts);
    }
    const fetchStats = { attempts: fetchLog.length, outcomes: count(fetchLog.map((l) => l.outcome)), failures: count(fetchLog.filter((l) => l.failure).map((l) => l.failure as string)), byScope: count(fetchLog.map((l) => `${l.scope}:${l.outcome}`)), byHost: count(fetchLog.map((l) => `${l.finalHost || l.host}:${l.outcome}`)), targetsWithPageObservation: [...pageObs.values()].filter((o) => o.length).length, pageScopeMatch: count(scopeLog) };

    // ---------------- 推論の比較 A/B/C/D
    const { default: Anthropic } = await import("@anthropic-ai/sdk");
    const client = new Anthropic({ apiKey: gate.apiKey, maxRetries: 0 });
    await client.models.retrieve(gate.model);
    const budget = new CallBudget({ maxCalls: MAX_CALLS, maxCostJpy: Math.min(MAX_COST, gate.totalCapJpy) });
    const infer = makeAnthropicUnitInfer(client, { model: gate.model });
    const store = loadKnowledge();
    const pastRows = (chain: string | null): { chainMatch: boolean; storeMode: string | null; lotteryForm: string | null; humanConfirmed: boolean }[] => lotRows.map((l) => ({ chainMatch: chainsMatch(chainName.get(l.chain_id as string) ?? null, chain) === "same", storeMode: (l.store_mode as string | null) ?? null, lotteryForm: (l.lottery_form as string | null) ?? null, humanConfirmed: !!l.confirmed_at }));
    let stoppedBy: string | null = null;
    const irrelevant: SelectedHint[] = store.entries.filter((e) => IRRELEVANT_IDS.includes(e.id)).map((entry) => ({ entry, reasons: ["参考"], preconditions: entry.preconditions.map((p) => ({ id: p.id, text: p.text, status: "unknown" as const })) }));
    type Mode = "A" | "B" | "C" | "D";
    const run = async (mode: Mode, chain: string | null, hosts: string[], stores: string[], products: string[], texts: string[], withPage: string[]): Promise<{ v: VerifiedUnitInference; hints: string[] } | null> => {
      const tags = observeTags({ texts: [...texts, ...withPage], stores, hosts });
      const relevant = selectHints(store, { chain, hosts, tags }, now);
      const hints = mode === "A" ? [] : mode === "C" ? [...relevant, ...irrelevant.filter((i) => !relevant.some((r) => r.entry.id === i.entry.id))] : relevant;
      const ctx: UnitContext = { texts, chain, stores, products, applyUrlHosts: hosts, formObservations: mode === "D" ? withPage : [], restrictionPhrases: extractRestrictionPhrases(texts), storeMasterCompleteness: "unknown", pastExamples: summarizePastExamples(pastRows(chain)), hints, observedTags: tags };
      const s = budget.start(`unit_infer_${mode}`, unitInferReserveJpy(gate.model));
      if (!s.ok) { stoppedBy = s.reason; return null; }
      const r = await infer(ctx);
      s.finish(r.costJpy);
      return r.inference ? { v: verifyUnitInference(r.inference, ctx), hints: hints.map((h) => h.entry.id) } : null;
    };
    const results: Record<Mode, Map<string, { v: VerifiedUnitInference; hints: string[] }>> = { A: new Map(), B: new Map(), C: new Map(), D: new Map() };
    for (const t of targets) {
      const chain = gv(t.c, "chain") as string | null;
      const hosts = [...new Set([...t.facts.flatMap((f) => f.urls ?? []).map((u) => canonUrl(u).host), ...(pageObs.get(t.c.clusterId) ?? []).map((o) => /ページ（([^）]+)）/.exec(o)?.[1] ?? "")].filter(Boolean))];
      const texts = [...new Set(t.facts.flatMap((f) => f.texts ?? []))].slice(0, 4);
      const stores = [gv(t.c, "store") as string | null].filter((s): s is string => !!s);
      const products = (gv(t.c, "products") as string[] | null) ?? [];
      for (const mode of ONLY_D ? ([] as const) : (["A", "B", "C"] as const)) { const r = await run(mode, chain, [], stores, products, texts, []); if (r) results[mode].set(t.c.clusterId, r); }
      const obs = pageObs.get(t.c.clusterId) ?? [];
      const d = await run("D", chain, hosts, stores, products, texts, obs); if (d) results.D.set(t.c.clusterId, d);
    }
    const dist = (m: Map<string, { v: VerifiedUnitInference }>): Record<string, number> => count([...m.values()].map((x) => x.v.independentUnit));
    const differ = (a: Mode, b: Mode): number => targets.filter((t) => { const x = results[a].get(t.c.clusterId)?.v.independentUnit; const y = results[b].get(t.c.clusterId)?.v.independentUnit; return !!x && !!y && x !== y; }).length;
    const hintUseOf = (m: Map<string, { v: VerifiedUnitInference }>): Record<string, number> => count([...m.values()].flatMap((x) => x.v.hintUse.map((h) => h.use)));
    const hintUseIrrelevantC = count([...results.C.values()].flatMap((x) => x.v.hintUse.filter((h) => IRRELEVANT_IDS.includes(h.id) && !results.B.get([...results.C.entries()].find(([, v]) => v === x)?.[0] ?? "")?.hints.includes(h.id)).map((h) => h.use)));

    // ---------------- 新判断（D を最終の推論として 10P/10Q と比較）
    const finalOf = (id: string): VerifiedUnitInference | null => results.D.get(id)?.v ?? null;
    const after = base.map((x) => ({ ...x, after: decideOpportunity({ cluster: x.c, facts: x.facts, eligibility: evalCond(x.c, x.facts, pageTexts.get(x.c.clusterId) ?? []), now, unresolvedDuplicatePairs: x.dup, isLottery: true, unitInference: finalOf(x.c.clusterId) }) }));
    const unitStatusAfter = count(after.map((x) => x.after.unitStatus));

    // ---------------- 阻害要因の分解（応募単位以外）: 非除外 13件
    const nonExcl = after.filter((x) => x.after.decision !== "excluded");
    const blockersNoUnit = nonExcl.map((x) => x.after.reasons.filter((r) => !/^unit_|^apply_unit|^alt_|^selection_timing/.test(r)));
    const blockerHist = count(blockersNoUnit.flat());
    const onlyUnitBlocked = nonExcl.filter((_, i) => blockersNoUnit[i].filter((r) => !/^gap_/.test(r)).length === 0).length;
    const condBefore = count(nonExcl.map((x) => x.before.unitStatus === "unknown" ? (x.el.primaryUnknown ?? x.el.verdict) : x.el.verdict));
    const condAfterPage = nonExcl.map((x) => evalCond(x.c, x.facts, pageTexts.get(x.c.clusterId) ?? []));
    const unknownBefore = nonExcl.filter((x) => x.el.verdict === "unknown").length;
    const unknownAfterPage = condAfterPage.filter((e) => e.verdict === "unknown").length;
    const chainMissing = nonExcl.filter((x) => x.after.reasons.some((r) => /chain_missing|field_not_verified_chain/.test(r))).map((x) => ({ chainFieldStatus: x.c.fields.find((f) => f.field === "chain")?.status, members: x.facts.map((f) => f.kind) }));

    // ---------------- 架空ケース（テスト用途。実測の正解率に混ぜない）
    const battery: { name: string; expect: string; unit: string; timing: string; direct: boolean; confidence: string; hintUse: string[]; alternatives: string[]; otherDescription: string }[] = [];
    for (const b of ONLY_D ? [] : BATTERY) {
      const r = await run("B", b.chain, b.hosts, b.stores, ["架空TCG 拡張パック「テスト弾」"], b.texts, []);
      if (r) battery.push({ name: b.name, expect: b.expect, unit: r.v.independentUnit, timing: r.v.selectionTiming, direct: r.v.directEvidence, confidence: r.v.confidence, hintUse: r.v.hintUse.map((h) => `${h.id}:${h.use}`), alternatives: r.v.alternatives.map((a) => a.unit), otherDescription: r.v.otherDescription });
    }

    const summary = {
      note: "Stage 10R 再評価（ローカル・Git管理外）。人の確認は行っていない。推論は仮説であり正解率ではない。架空ケースは実測に混ぜない",
      sameInput: { opportunities: base.length, nonExcluded: nonExcl.length, targets: targets.length, facts: all.length },
      pageFetch: { ...fetchStats, fetches: fetchCount, note: "10Qは0件（保存済みの一覧項目に応募リンクが無かったため）。10Rは親投稿に付いていた展開済みリンクと項目の短縮リンクを辿った" },
      comparison: { unitByCondition: { A_noHints: dist(results.A), B_relevantHints: dist(results.B), C_withIrrelevant: dist(results.C), D_B_plus_page: dist(results.D) }, differingConclusions: { A_vs_B: differ("A", "B"), B_vs_C: differ("B", "C"), A_vs_C: differ("A", "C"), B_vs_D: differ("B", "D") }, hintUse: { B: hintUseOf(results.B), C: hintUseOf(results.C), irrelevantInC: hintUseIrrelevantC }, confidence: { A: count([...results.A.values()].map((x) => x.v.confidence)), B: count([...results.B.values()].map((x) => x.v.confidence)), D: count([...results.D.values()].map((x) => x.v.confidence)) }, directEvidence: { A: [...results.A.values()].filter((x) => x.v.directEvidence).length, B: [...results.B.values()].filter((x) => x.v.directEvidence).length, D: [...results.D.values()].filter((x) => x.v.directEvidence).length }, timing: count([...results.D.values()].map((x) => x.v.selectionTiming)), downgradedD: count([...results.D.values()].flatMap((x) => x.v.downgraded)) },
      applyUnit: { unitStatus10Q: { unknown: 38, provisional: 12, explicit: 1 }, unitStatus10R: unitStatusAfter },
      decisions: { before10P: count(base.map((x) => x.before.decision)), after10R: count(after.map((x) => x.after.decision)), onlyUnitOrGapsBlocked: onlyUnitBlocked },
      blockers: { nonExcluded: nonExcl.length, byReasonExcludingUnit: blockerHist, unknownConditionsBefore: unknownBefore, unknownConditionsAfterPageText: unknownAfterPage, duplicatePairs: dupPairs.slice(0, 6).map((p) => ({ evidence: p.evidence, score: p.score })), chainMissing, condCauseBefore: condBefore },
      battery,
      stoppedBy,
      budget: budget.summary(),
    };
    writeFileSync(ONLY_D ? "eval/real-data/xsource-10r-d.json" : "eval/real-data/xsource-10r.json", JSON.stringify(summary, null, 1));
    // 人の確認用: 実データの応募機会（暫定・確認待ちを先に）。観察・ヒントの採否・代替・ページの観察を付ける
    const cases = after.filter((x) => x.after.decision !== "excluded").map((x) => ({ clusterId: x.c.clusterId, before: x.before.decision, after: x.after.decision, reasons: x.after.reasons, unitStatus: x.after.unitStatus, hypothesis: x.after.unitHypothesis, inference: results.D.get(x.c.clusterId)?.v ?? null, inferenceNoHints: results.A.get(x.c.clusterId)?.v.independentUnit ?? null, pageObservations: pageObs.get(x.c.clusterId) ?? [], announcement: x.facts.flatMap((f) => itemMeta.get(f.sourceId)?.text ?? []).slice(0, 2) }));
    writeFileSync(ONLY_D ? "eval/real-data/human-review-10r-d.json" : "eval/real-data/human-review-10r.json", JSON.stringify({ note: "人の確認用（ローカルのみ・Git管理外）。実データ＋架空ケース（テスト用途・実測に混ぜない）", battery, opportunities: cases }, null, 1));
    expect(budget.calls).toBeLessThanOrEqual(MAX_CALLS);
    expect(budget.costJpy).toBeLessThanOrEqual(MAX_COST + 0.01);
    expect(fetchCount).toBeLessThanOrEqual(MAX_FETCHES);
    expect(after.filter((x) => x.before.decision === "excluded").every((x) => x.after.decision === "excluded")).toBe(true);
    expect(after.filter((x) => x.after.decision === "auto_register_preview").every((x) => x.after.unitStatus === "explicit" || x.after.unitStatus === "inferred_direct")).toBe(true);
    expect(after.every((x) => x.after.reasons.every((r) => !/official/.test(r)))).toBe(true);
  }, 2_400_000);
});
