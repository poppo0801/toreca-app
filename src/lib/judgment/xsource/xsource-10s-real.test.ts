// @vitest-environment node
/**
 * Stage 10S: 応募先URLの項目単位の対応・実データの検証（実AI・有料・書き込みなし・DB不要）。AIの推論方法の追加調整はせず、判断材料（リンクの出所・対応・取得）の精度と人の確認資料を主にする。
 *   A) 既存の保存データ（10Rの12件）: リンクの出所（復元可否）とページ対応の判定を、同じ入力で測る。
 *   B) **新しい公開データ**: 本番の候補が指していた実在の公開応募ページ（LivePocket・各店舗サイト等）を今回あらためて取得し、ページ自体を一次情報として 取得→項目抽出→応募単位の推論→登録プレビュー を通す（X投稿からのエンドツーエンドではない。下記）。
 *   ※ X投稿→項目分割→URL展開（linkMap）→取得 のエンドツーエンドは、**開発用のX API鍵が無く本番の鍵は使えない**ため実行していない。linkMap の経路は架空の投稿データでの単体テストのみ（実データの成功としては数えない）。
 *   上限（全工程合算・開始前に予約・ハード停止）: AI 90回・¥50・1件¥3・対象30・ページ取得60。**本番には接続しない**。
 *   出力: eval/real-data/xsource-10s.json（集計）・human-review-10s.json（人の確認用。実データのみ）。Git管理外。**人の確認は行っていない**。
 * 実行: JUDGMENT_10S_REAL=1 JUDGMENT_REAL_EVAL=allow JUDGMENT_REUSE_EXISTING_KEY=allow JUDGMENT_REAL_CONFIRM=yes JUDGMENT_APPROVED_TOTAL_JPY=50 JUDGMENT_APPROVED_PER_CASE_JPY=3 TOREMANE_ENV=local npx vitest run src/lib/judgment/xsource/xsource-10s-real.test.ts
 */
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { CallBudget } from "../call-budget";
import { checkJudgmentRealRun } from "../real-gate";
import { makeAnthropicUnitInfer, unitInferReserveJpy } from "./ai-unit";
import { makeAnthropicPageExtractor, pageExtractReserveJpy, verifyPageFacts } from "./ai-10o";
import { classifyFetchFailure, excerptApplyPage, type FetchFailure } from "./application-page";
import { extractRestrictionPhrases, verifyUnitInference, type UnitContext, type VerifiedUnitInference } from "./apply-unit";
import { clusterFacts } from "./cluster";
import { resolveConditions } from "./conditions";
import { decideOpportunity } from "./decision";
import { judgeLinkScope } from "./link-scope";
import { loadKnowledge, observeTags, selectHints } from "./knowledge/knowledge";
import { canonUrl } from "./normalize";
import type { SourceFact } from "./types";

vi.mock("server-only", () => ({}));

const env = process.env;
const MAX_CALLS = Number(env.JUDGMENT_10S_MAX_CALLS ?? 90);
const MAX_COST = 50;
const MAX_FETCHES = 60;
const MAX_TARGETS = 30;
const latest = (dir: string, prefix: string): string => `${dir}/${readdirSync(dir).filter((f) => f.startsWith(prefix)).sort().at(-1)}`;
const count = (xs: string[]): Record<string, number> => xs.reduce<Record<string, number>>((m, x) => ((m[x] = (m[x] ?? 0) + 1), m), {});
type Row = Record<string, unknown>;

describe.skipIf(env.JUDGMENT_10S_REAL !== "1")("10S 応募先URLの対応・実データ検証（有料）", () => {
  it("既存データの出所・対応を測り、新しい公開ページで取得→抽出→推論→プレビューを通し、人の確認資料を作る", async () => {
    const gate = checkJudgmentRealRun({ env, confirm: env.JUDGMENT_REAL_CONFIRM === "yes", approvedTotalJpy: Number(env.JUDGMENT_APPROVED_TOTAL_JPY), approvedPerCaseJpy: Number(env.JUDGMENT_APPROVED_PER_CASE_JPY) });
    if (!gate.ok) throw new Error(`実行しません: ${gate.reason}`);
    const now = new Date();
    const snap = JSON.parse(readFileSync(latest("backups/masters-9h3s", "snapshot-prod-"), "utf8")) as Record<string, Row[]>;
    const evRows = (JSON.parse(readFileSync(latest("backups/refresh-10g", "evidence-"), "utf8")) as { rows: { id: string; links?: string[]; text: string }[] }).rows;
    const evById = new Map(evRows.map((e) => [e.id, e]));
    const r10 = JSON.parse(readFileSync("eval/real-data/human-review-10r-d.json", "utf8")) as { opportunities: { clusterId: string; after: string; reasons: string[]; unitStatus: string; inference: VerifiedUnitInference | null; announcement: string[] }[] };
    const items = (JSON.parse(readFileSync("eval/real-data/xsource-10o-items.json", "utf8")) as { items: { candidateId: string; groupLabel: string; item: { store: string | null; chain: string | null; products: string[] }; text: string }[] }).items;

    const safe = new (await import("@/lib/server/agent/real-providers")).SafePageFetcher();
    let fetchCount = 0;
    const pages = new Map<string, { ok: boolean; failure?: FetchFailure; host: string; text: string; head: string; lines: string[] }>();
    const fetchLog: { group: string; host: string; outcome: string; failure?: FetchFailure }[] = [];
    const getPage = async (url: string, group: string) => {
      const key = canonUrl(url).key;
      const hit = pages.get(key);
      if (hit) return hit;
      const host = canonUrl(url).host;
      if (fetchCount >= MAX_FETCHES) { const r = { ok: false, failure: "cap" as FetchFailure, host, text: "", head: "", lines: [] }; fetchLog.push({ group, host, outcome: "cap", failure: "cap" }); return r; }
      fetchCount++;
      const p = await safe.fetchPage(url);
      if (!p.ok) { const failure = classifyFetchFailure(p.message); const r = { ok: false, failure, host, text: "", head: "", lines: [] }; pages.set(key, r); fetchLog.push({ group, host, outcome: "failed", failure }); return r; }
      const lines = excerptApplyPage(p.text);
      const r = { ok: true, host, text: p.text, head: p.text.slice(0, 600), lines };
      pages.set(key, r);
      fetchLog.push({ group, host, outcome: lines.length ? "ok_usable" : "ok_no_cues" });
      return r;
    };

    // ================= A) 既存の保存データ（10Rの12件）: リンクの出所・ページ対応
    const parentsOf = (announcement: string[]): string[] => items.filter((i) => announcement.some((a) => a && i.text.includes(a.slice(0, 20)))).map((i) => i.candidateId);
    const scopeA: { verdict: string; origin: string; refutes: string[]; supports: string[] }[] = [];
    const originA: string[] = [];
    for (const o of r10.opportunities.filter((x) => x.inference || x.unitStatus !== "explicit")) {
      const it = items.find((i) => (o.announcement ?? []).some((a) => a && i.text.includes(a.slice(0, 20))));
      const cid = it?.candidateId;
      const ev = cid ? evById.get(cid) : undefined;
      const shortCount = it ? (it.text.match(/https:\/\/t\.co\/[A-Za-z0-9]+/g) ?? []).length : 0;
      originA.push(shortCount ? "item_text_short_unexpanded" : "no_item_link");
      const parentLinks = (ev?.links ?? []).filter((u) => /^https:\/\/livepocket\.jp\//.test(u));
      if (!parentLinks.length) { scopeA.push({ verdict: "unknown", origin: "no_parent_link", refutes: [], supports: [] }); continue; }
      const pg = await getPage(parentLinks[0], "A_parent");
      const siblings = items.filter((i) => i.candidateId === cid);
      const v = judgeLinkScope({ link: { origin: "parent_shared" }, item: { chain: it?.item.chain ?? null, store: it?.item.store ?? null, products: it?.item.products ?? [] }, page: pg.ok ? { head: pg.head, lines: pg.lines } : null, otherStores: [...siblings.map((s) => s.item.store ?? ""), ...snap.stores.map((s) => String(s.name ?? ""))].filter((n) => n.length >= 4), otherProducts: [], sameUrlItems: siblings.length });
      scopeA.push({ verdict: v.verdict, origin: "parent_shared", refutes: v.refutes, supports: v.supports });
    }
    void parentsOf;
    const aDebug = { unmatchedItems: scopeA.filter((x) => x.origin === "no_parent_link").length, fetchGroupA: count(fetchLog.filter((l) => l.group === "A_parent").map((l) => l.outcome + ":" + (l.failure ?? ""))) };
    if (env.JUDGMENT_10S_ONLY_A === "1") {
      writeFileSync("eval/real-data/xsource-10s-a.json", JSON.stringify({ origin: count(originA), pageScope: count(scopeA.map((s) => s.verdict)), refutes: count(scopeA.flatMap((s) => s.refutes)), supports: count(scopeA.flatMap((s) => s.supports)), aDebug, fetches: fetchCount }, null, 1));
      // 既存の確認資料（実データの12件）のページ対応だけを更新する（AIは呼ばない）
      try {
        const file = JSON.parse(readFileSync("eval/real-data/human-review-10s.json", "utf8")) as { cases: { id: string; scope: unknown; fetchOutcome: string; linkOrigin: string }[] };
        const rs = file.cases.filter((c) => c.id.startsWith("r10:"));
        if (rs.length === scopeA.length) {
          rs.forEach((c, i) => {
            const sc = scopeA[i];
            c.scope = { verdict: sc.verdict, supports: sc.supports, refutes: sc.refutes, unknowns: sc.verdict === "mismatch" ? [] : ["項目ごとの応募先は復元不能（共有リンクの対応が未確認）"] };
            c.fetchOutcome = sc.origin === "no_parent_link" ? "親投稿にリンクなし" : "親投稿のリンク先を取得";
            c.linkOrigin = originA[i] === "item_text_short_unexpanded" ? "item_text_short_unexpanded" : sc.origin === "no_parent_link" ? "item_text_short_unexpanded" : "parent_shared";
          });
          writeFileSync("eval/real-data/human-review-10s.json", JSON.stringify(file, null, 1));
        }
      } catch {
        /* 確認資料が無ければ何もしない */
      }
      return;
    }

    // ================= B) 新しい公開データ: 実在の公開応募ページ（本番の候補が指していたURL）を今回あらためて取得
    const cands = snap.collection_candidates
      .filter((c) => typeof c.source_url === "string" && /^https:\/\//.test(c.source_url as string))
      .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));
    const hostOf = (u: string): string => canonUrl(u).host;
    const quota: Record<string, number> = { "livepocket.jp": 14, "www.c-labo.jp": 6, "shoplottery.e-starbox.com": 6 };
    const picked: string[] = [];
    const used = new Set<string>();
    const perHost: Record<string, number> = {};
    for (const c of cands) {
      const u = c.source_url as string;
      const h = hostOf(u);
      const k = canonUrl(u).key;
      if (used.has(k) || ["x.com", "t.co", "twitter.com", "docs.google.com", "forms.gle", "miniapp.line.me"].includes(h)) continue;
      const q = quota[h] ?? 2;
      if ((perHost[h] ?? 0) >= q) continue;
      perHost[h] = (perHost[h] ?? 0) + 1;
      used.add(k);
      picked.push(u);
      if (picked.length >= 36) break;
    }
    const live: { url: string; page: Awaited<ReturnType<typeof getPage>> }[] = [];
    for (const u of picked) {
      if (fetchCount >= MAX_FETCHES - 2) break;
      live.push({ url: u, page: await getPage(u, "B_live") });
    }
    // 取得できたページを、観察の手掛かり（文面のタグ）で分類し、偏りなく最大18件を選ぶ
    const catOf = (text: string, host: string): string => {
      const tags = observeTags({ texts: [text], stores: [], hosts: [host] });
      if (tags.includes("group_phrase")) return "group";
      if (tags.includes("after_win_phrase")) return "after_win";
      if (tags.includes("cross_store_phrase")) return "cross_store_restriction";
      if (tags.includes("store_select_phrase")) return "store_select";
      if (tags.includes("multi_product_phrase")) return "multi_product";
      if (tags.includes("round_phrase")) return "round";
      return "plain";
    };
    const usable = live.filter((l) => l.page.ok && l.page.lines.length).map((l) => ({ ...l, cat: catOf(l.page.text, l.page.host) }));
    const buckets = new Map<string, typeof usable>();
    for (const u of usable) buckets.set(u.cat, [...(buckets.get(u.cat) ?? []), u]);
    const chosen: typeof usable = [];
    for (let round = 0; chosen.length < Math.min(18, MAX_TARGETS - 12) && round < 6; round++) for (const b of buckets.values()) if (b[round] && chosen.length < Math.min(18, MAX_TARGETS - 12)) chosen.push(b[round]);

    const { default: Anthropic } = await import("@anthropic-ai/sdk");
    const client = new Anthropic({ apiKey: gate.apiKey, maxRetries: 0 });
    await client.models.retrieve(gate.model);
    const budget = new CallBudget({ maxCalls: MAX_CALLS, maxCostJpy: Math.min(MAX_COST, gate.totalCapJpy) });
    const extractor = makeAnthropicPageExtractor(client, { model: gate.model });
    const infer = makeAnthropicUnitInfer(client, { model: gate.model });
    const store = loadKnowledge();
    const cs = (snap.collection_settings[0] ?? {}) as { prefectures?: string[]; include_online?: boolean };
    const cond = { prefectures: cs.prefectures ?? [], includeOnline: cs.include_online ?? true, productMode: "all" as const };
    const flat = (s: string): string => s.normalize("NFKC").replace(/[ \t\r\n　]+/g, "").toLowerCase();
    const liveCases: Record<string, unknown>[] = [];
    const liveSummary: { cat: string; host: string; unit: string; unitStatus: string; direct: boolean; decision: string; reasons: string[]; extracted: boolean }[] = [];
    let stoppedBy: string | null = null;
    for (const l of chosen) {
      const s1 = budget.start("page_extract", pageExtractReserveJpy(gate.model));
      if (!s1.ok) { stoppedBy = s1.reason; break; }
      const ex = await extractor(l.page.text);
      s1.finish(ex.costJpy);
      const facts = ex.facts;
      const v = facts ? verifyPageFacts(facts, l.page.text, now) : null;
      const body = flat(l.page.text);
      const stated = (x: string | null): boolean => !!x && flat(x).length >= 3 && body.includes(flat(x));
      const ev = { quoteVerified: true, range: null, image: null } as const;
      const fields: SourceFact["fields"] = {};
      const evidence: NonNullable<SourceFact["evidence"]> = {};
      if (facts && v) {
        if (facts.chain) { fields.chain = facts.chain; if (stated(facts.chain)) evidence.chain = ev; }
        if (facts.store) { fields.store = facts.store; if (stated(facts.store)) evidence.store = ev; }
        if (facts.products.length) { fields.products = facts.products; if (facts.products.some((p) => stated(p))) evidence.products = ev; }
        for (const k of ["applyStart", "applyDeadline", "resultDate"] as const) if (v.verified[k] && v.preview[k]) { (fields as Record<string, string>)[k] = v.preview[k] as string; evidence[k] = ev; }
        if (v.unitVerified) { fields.applyUnit = facts.applyUnit as never; evidence.applyUnit = ev; }
        fields.applyUrl = l.url;
      }
      const fact: SourceFact = { sourceId: `live:${canonUrl(l.url).key.slice(-10)}`, kind: "unknown", fetchedAt: now.toISOString(), fields, evidence, urls: [l.url] };
      const cluster = clusterFacts([fact])[0];
      const excerpt = l.page.lines;
      const tags = observeTags({ texts: [l.page.head, ...excerpt], stores: facts?.store ? [facts.store] : [], hosts: [l.page.host] });
      const ctx: UnitContext = { texts: [l.page.head, ...excerpt.slice(0, 8)].map((t) => t.slice(0, 300)), chain: facts?.chain ?? null, stores: facts?.store ? [facts.store] : [], products: facts?.products ?? [], applyUrlHosts: [l.page.host], formObservations: [`応募ページそのもの（${l.page.host}）: ${excerpt.join(" / ").slice(0, 1800)}`], restrictionPhrases: extractRestrictionPhrases(excerpt), storeMasterCompleteness: "unknown", pastExamples: [], hints: selectHints(store, { chain: facts?.chain ?? null, hosts: [l.page.host], tags }, now), observedTags: tags };
      const s2 = budget.start("unit_infer", unitInferReserveJpy(gate.model));
      if (!s2.ok) { stoppedBy = s2.reason; break; }
      const r = await infer(ctx);
      s2.finish(r.costJpy);
      const vi = r.inference ? verifyUnitInference(r.inference, ctx) : null;
      const el = resolveConditions({ chain: facts?.chain ?? null, store: facts?.store ?? null, prefecture: null, products: facts?.products ?? [], texts: [l.page.head, ...excerpt] }, cond, [], {});
      const d = decideOpportunity({ cluster, facts: [fact], eligibility: el, now, unresolvedDuplicatePairs: 0, isLottery: facts?.pageKind !== "other", unitInference: vi });
      liveSummary.push({ cat: l.cat, host: l.page.host, unit: vi?.independentUnit ?? "none", unitStatus: d.unitStatus, direct: !!vi?.directEvidence, decision: d.decision, reasons: d.reasons, extracted: !!facts });
      liveCases.push({ id: `live:${liveCases.length + 1}`, real: true, category: `公開の応募ページ（${l.cat}・${l.page.host}）`, source: "live_public_page", sourceText: excerpt.slice(0, 12), linkOrigin: "page_itself", scope: { verdict: "confirmed", supports: ["page_is_the_application_page_itself"], refutes: [], unknowns: [] }, fetchOutcome: "ok", aiDecision: d.decision, aiUnit: v?.unitVerified && facts ? facts.applyUnit : (vi?.independentUnit ?? "unknown"), inferenceUnit: vi?.independentUnit ?? "unknown", unitSource: v?.unitVerified ? "ページが明記（抜粋が原文に実在）" : "AIの推論（仮説）", aiTiming: vi?.selectionTiming ?? "unknown", confidence: vi?.confidence ?? "low", directEvidence: !!vi?.directEvidence, method: vi?.method ?? "", alternatives: vi?.alternatives ?? [], observedFacts: vi?.observedFacts ?? [], evidence: vi?.evidence ?? [], unknowns: vi?.unknowns ?? [], hintUse: vi?.hintUse ?? [], pageExtractedUnit: facts?.applyUnit ?? null, pageExtractedUnitVerified: !!v?.unitVerified });
    }

    // ================= 10Rの12件（既存の保存データ）: 人の確認資料に変換（実データ）
    const rCases = r10.opportunities.filter((o) => o.inference).map((o, i) => {
      const inf = o.inference as VerifiedUnitInference;
      const sc = scopeA[i];
      return { id: `r10:${i + 1}`, real: true, category: "一覧の項目（Stage 10Rの保存データ）", source: "existing_x_post_item", sourceText: o.announcement ?? [], linkOrigin: originA[i] === "item_text_short_unexpanded" ? "item_text_short_unexpanded" : "parent_shared", scope: sc ? { verdict: sc.verdict, supports: sc.supports, refutes: sc.refutes, unknowns: sc.verdict === "mismatch" ? [] : ["項目ごとの応募先は復元不能"] } : null, fetchOutcome: sc ? (sc.origin === "no_parent_link" ? "親投稿にリンクなし" : "親投稿のリンク先を取得") : "—", aiDecision: o.after, aiUnit: inf.independentUnit, aiTiming: inf.selectionTiming, confidence: inf.confidence, directEvidence: inf.directEvidence, method: inf.method, alternatives: inf.alternatives, observedFacts: inf.observedFacts, evidence: inf.evidence, unknowns: inf.unknowns };
    });
    const allCases = [...rCases, ...liveCases];
    writeFileSync("eval/real-data/human-review-10s.json", JSON.stringify({ note: "人の確認用（ローカルのみ・Git管理外）。実データのみ（架空例は含めない）", cases: allCases }, null, 1));

    // ================= 阻害要因の分類（10Rの非除外）
    const CATEGORY: Record<string, string> = { tcg_unknown: "商品/TCGマスターの不足（または商品ページの一次情報）", tcg_mixed_needs_review: "一覧が複数TCGを含む（項目単位の分割・AI抽出の課題）", region_unknown: "店舗マスター（所在地）の不足", chain_missing: "AI抽出の誤り（系列が抽出できていない）", field_not_verified_chain: "AI抽出の誤り（系列が原文で未確認）", possible_duplicate_unresolved: "一次情報（店舗の特定・応募先ページ）で解決しうる", gap_apply_destination: "一次情報（項目ごとの応募先リンク）で解決しうる" };
    const blockerCat = count(r10.opportunities.filter((o) => o.after !== "excluded").flatMap((o) => o.reasons.filter((r) => CATEGORY[r]).map((r) => CATEGORY[r])));

    const unitDist = count(liveSummary.map((x) => x.unit));
    const summary = {
      note: "Stage 10S（ローカル・Git管理外）。人の確認は行っていない。AからBは母数・取得条件が異なるため単純比較しない",
      A_existingStoredData: { opportunities: scopeA.length, linkOrigin: count(originA), pageScope: count(scopeA.map((s) => s.verdict)), pageScopeDetail: count(scopeA.flatMap((s) => s.refutes)), restorable: "項目ごとの応募先URLは復元不能（保存データに linkMap が無く、短縮URLは robots により追跡しない）", aDebug },
      B_newPublicPages: { sampled: picked.length, fetched: live.length, fetchOutcomes: count(fetchLog.filter((l) => l.group === "B_live").map((l) => l.outcome)), failures: count(fetchLog.filter((l) => l.group === "B_live" && l.failure).map((l) => l.failure as string)), byHost: count(fetchLog.filter((l) => l.group === "B_live").map((l) => `${l.host}:${l.outcome}`)), usableCues: usable.length, categoriesAvailable: count(usable.map((u) => u.cat)), chosen: chosen.length, chosenByCategory: count(chosen.map((c) => c.cat)), aiProcessed: liveSummary.length, unitByAI: unitDist, directEvidence: liveSummary.filter((x) => x.direct).length, unitStatus: count(liveSummary.map((x) => x.unitStatus)), pageStatedUnit: liveCases.filter((c) => c.pageExtractedUnitVerified).length, decisions: count(liveSummary.map((x) => x.decision)), blockers: count(liveSummary.flatMap((x) => x.reasons)) },
      blockersExistingNonExcluded: blockerCat,
      reviewMaterial: { total: allCases.length, existing: rCases.length, newPublic: liveCases.length, byCategory: count(allCases.map((c) => String(c.category))) },
      stoppedBy,
      fetches: fetchCount,
      budget: budget.summary(),
    };
    writeFileSync("eval/real-data/xsource-10s.json", JSON.stringify(summary, null, 1));
    expect(budget.calls).toBeLessThanOrEqual(MAX_CALLS);
    expect(budget.costJpy).toBeLessThanOrEqual(MAX_COST + 0.01);
    expect(fetchCount).toBeLessThanOrEqual(MAX_FETCHES);
    expect(12 + chosen.length).toBeLessThanOrEqual(MAX_TARGETS);
    expect(allCases.every((c) => c.real === true)).toBe(true);
  }, 2_400_000);
});
