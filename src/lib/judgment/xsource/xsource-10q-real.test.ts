// @vitest-environment node
/**
 * Stage 10Q: 応募単位のAI推論の実データ再評価（実AI・有料・書き込みなし・DB不要）。Stage 10P と同一の入力（保存した一覧項目 55件・新規の応募機会 51件・登録 235件）で、
 *   応募単位 不明／明示／推論／暫定 と、自動登録（プレビュー）・暫定候補・確認待ち・除外の件数がどう変わるかを測る。あわせて、ユーザー提供の経験則に対応する架空の対立仮説ケース（参考知識の使い方の確認）を評価する。
 *   上限（全工程合算・開始前に予約・ハード停止）: AI呼び出し 90回・費用 ¥50・1件 ¥3・対象 30・取得 60（今回の取得は 0）。**本番には接続しない**。
 *   出力: eval/real-data/xsource-10q.json（集計）・human-review-10q.json（人の確認用。例外・不確実なものを先に）。Git管理外。**人の確認は行っていない**。
 * 実行: JUDGMENT_10Q_REAL=1 JUDGMENT_REAL_EVAL=allow JUDGMENT_REUSE_EXISTING_KEY=allow JUDGMENT_REAL_CONFIRM=yes JUDGMENT_APPROVED_TOTAL_JPY=50 JUDGMENT_APPROVED_PER_CASE_JPY=3 TOREMANE_ENV=local npx vitest run src/lib/judgment/xsource/xsource-10q-real.test.ts
 */
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { CallBudget } from "../call-budget";
import type { ListItemResult } from "../list-discovery";
import { checkJudgmentRealRun } from "../real-gate";
import { makeAnthropicUnitInfer, unitInferReserveJpy } from "./ai-unit";
import { extractRestrictionPhrases, summarizePastExamples, verifyUnitInference, type UnitContext, type VerifiedUnitInference } from "./apply-unit";
import { clusterFacts, pairRelations } from "./cluster";
import { resolveConditions } from "./conditions";
import { decideOpportunity, type DecisionResult } from "./decision";
import { factFromListItem, factFromRegistration, type RegistrationLike } from "./facts";
import { loadKnowledge, selectKnowledge } from "./knowledge/knowledge";
import { canonUrl, chainsMatch, storesMatch } from "./normalize";
import { buildProductMatcher } from "./product-master";
import type { Cluster, SourceFact } from "./types";

vi.mock("server-only", () => ({}));

const env = process.env;
const MAX_CALLS = Number(env.JUDGMENT_10Q_MAX_CALLS ?? 90);
const MAX_COST = 50;
const latest = (dir: string, prefix: string): string => `${dir}/${readdirSync(dir).filter((f) => f.startsWith(prefix)).sort().at(-1)}`;
const jst = (iso: string | null): string | null => (iso ? new Date(Date.parse(iso) + 9 * 3600_000).toISOString().slice(0, 16).replace("T", " ") : null);
const count = (xs: string[]): Record<string, number> => xs.reduce<Record<string, number>>((m, x) => ((m[x] = (m[x] ?? 0) + 1), m), {});
type Row = Record<string, unknown>;
interface CachedItem { candidateId: string; parentKey: string; single: boolean; groupLabel: string; head: string; item: ListItemResult; range: { start: number; end: number }; fetchedAt: string; text: string }

/** ユーザー提供の経験則に対応する、**架空の**対立仮説ケース（実在の系列の実告知ではない）。AIが参考知識を固定ルールにせず、今回の記載を優先できるかを見る。期待は「望ましい方向」で、正解ではない */
const BATTERY: { name: string; chain: string; hosts: string[]; stores: string[]; texts: string[]; expect: string }[] = [
  { name: "LP-複数店舗の選択肢（明示あり）", chain: "架空百貨店", hosts: ["livepocket.jp"], stores: [], texts: ["【応募フォーム】受取店舗をお選びください: 梅田店／難波店／京橋店。応募は1店舗のみ可能です"], expect: "store_select（直接の根拠）" },
  { name: "LP-店舗グループ別の例外（イトーヨーカドー型）", chain: "イトーヨーカドー", hosts: ["livepocket.jp"], stores: [], texts: ["抽選応募 グループA（A店・B店）／グループB（C店・D店）／グループC（E店）／グループD（F店）。各グループごとに1回ずつご応募いただけます"], expect: "per_store_group（LPの傾向ではなく今回の記載を優先）" },
  { name: "ドラスタ系・店舗ごとの抽選（明記なし）", chain: "ドラゴンスター", hosts: ["dorasuta.jp"], stores: ["架空1号店"], texts: ["架空1号店 拡張パック「テスト弾」抽選販売のお知らせ。応募期間 11/22(日)〜11/24(火)"], expect: "per_store（類推・暫定）" },
  { name: "竜のしっぽ・店舗ごとの抽選（明記なし）", chain: "竜のしっぽ", hosts: [], stores: ["架空店"], texts: ["竜のしっぽ 架空店 抽選販売のご案内 11/23(月)まで"], expect: "per_store（類推・暫定）" },
  { name: "他店舗同時応募で落選（制限の記載）", chain: "架空書店", hosts: ["shop.example.com"], stores: ["梅田店", "難波店"], texts: ["梅田店・難波店で同時開催。複数店舗に同時に応募された場合は全て無効（落選）となります"], expect: "store_select（記載を優先。独立応募ではない）" },
  { name: "店舗受取・多店舗系列・店舗不明（明記なし）", chain: "架空家電", hosts: [], stores: [], texts: ["拡張パック「テスト弾」抽選販売。店頭受取のみ（通販不可）。応募期間 11/22〜11/24"], expect: "store_select（有力な仮説・暫定）／単店舗とは推論しない" },
  { name: "当選後に受取先を選ぶ（ヨドバシ型）", chain: "ヨドバシカメラ", hosts: [], stores: [], texts: ["抽選販売 ご当選後に、店頭受取または配送をお選びいただきます"], expect: "store_select・after_win（応募時選択必須ではない）" },
  { name: "商品別フォーム・別開催回", chain: "架空ショップ", hosts: ["shop.example.com"], stores: [], texts: ["商品Aの応募フォームはこちら（第1回: 11/22〆）。商品Bは別フォーム（第2回: 11/29〆）"], expect: "per_product／per_round（商品別・開催回別）" },
];

describe.skipIf(env.JUDGMENT_10Q_REAL !== "1")("10Q 応募単位のAI推論: 実データ再評価（有料）", () => {
  it("同一入力で応募単位を推論し、応募単位・自動登録・暫定候補・確認待ちの件数の変化を測る", async () => {
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
    const lotRows = snap.lotteries.filter((l) => !l.archived_at);
    const regs: RegistrationLike[] = lotRows.map((l) => {
      const st = l.store_id ? storeById.get(l.store_id as string) : undefined;
      return { id: l.id as string, candidateId: candOf.get(l.id as string) ?? null, chain: chainName.get(l.chain_id as string) ?? null, store: (st?.name as string | undefined) ?? null, prefecture: (st?.prefecture as string | undefined) ?? null, products: itemsBy.get(l.id as string) ?? [], applyStart: jst((l.apply_start_at as string) ?? null), applyDeadline: jst((l.apply_deadline_at as string) ?? null), resultDate: (l.result_date as string) ?? null, applyUrl: (urlsOf.get(l.id as string) ?? [])[0] ?? null, protectedCodes: (appCount.get(l.id as string) ?? 0) > 0 ? ["applications"] : [], updatedAt: (l.updated_at as string) ?? null };
    });
    const regFacts = regs.map(factFromRegistration);
    for (const f of regFacts) f.urls = urlsOf.get((f.registration as { id: string }).id);
    const itemFacts: SourceFact[] = [];
    for (const c of cached) {
      const f = factFromListItem({ candidateId: c.candidateId, parentKey: c.parentKey, item: c.item, fetchedAt: c.fetchedAt, range: c.range, groupLabel: c.groupLabel, contextTexts: [c.head, c.text] });
      if (f) itemFacts.push(f);
    }
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
    const base = newOpps.map((c) => {
      const facts = c.members.map((m) => byId.get(m) as SourceFact);
      const el = resolveConditions({ chain: gv(c, "chain") as string | null, store: gv(c, "store") as string | null, prefecture: gv(c, "prefecture") as string | null, products: (gv(c, "products") as string[] | null) ?? [], texts: facts.flatMap((f) => f.texts ?? []) }, cond, [], { storeMaster, productMaster: (n) => !!matcher.match(n) });
      const dup = c.members.reduce((n, m) => n + (unresolved.get(m) ?? 0), 0);
      const before: DecisionResult = decideOpportunity({ cluster: c, facts, eligibility: el, now, unresolvedDuplicatePairs: dup, isLottery: true });
      return { c, facts, el, dup, before };
    });

    // ---------------- 推論（対象: 除外でなく、応募単位が原文で確定していない応募機会。除外は費用をかけない）
    const { default: Anthropic } = await import("@anthropic-ai/sdk");
    const client = new Anthropic({ apiKey: gate.apiKey, maxRetries: 0 });
    await client.models.retrieve(gate.model);
    const budget = new CallBudget({ maxCalls: MAX_CALLS, maxCostJpy: Math.min(MAX_COST, gate.totalCapJpy) });
    const infer = makeAnthropicUnitInfer(client, { model: gate.model });
    const store = loadKnowledge();
    const pastRows = (chain: string | null): { chainMatch: boolean; storeMode: string | null; lotteryForm: string | null; humanConfirmed: boolean }[] => lotRows.map((l) => ({ chainMatch: chainsMatch(chainName.get(l.chain_id as string) ?? null, chain) === "same", storeMode: (l.store_mode as string | null) ?? null, lotteryForm: (l.lottery_form as string | null) ?? null, humanConfirmed: !!l.confirmed_at }));
    const targets = base.filter((x) => x.before.decision !== "excluded" && x.before.unitStatus === "unknown");
    const raw = new Map<string, VerifiedUnitInference>();
    const log: { id: string; unit: string; direct: boolean; confidence: string; timing: string; downgraded: string[] }[] = [];
    let stoppedBy: string | null = null;
    for (const t of targets) {
      const chain = gv(t.c, "chain") as string | null;
      const hosts = [...new Set(t.facts.flatMap((f) => f.urls ?? []).map((u) => canonUrl(u).host).filter(Boolean))];
      const texts = [...new Set(t.facts.flatMap((f) => f.texts ?? []))].slice(0, 4);
      const ctx: UnitContext = { texts, chain, stores: [gv(t.c, "store") as string | null].filter((s): s is string => !!s), products: (gv(t.c, "products") as string[] | null) ?? [], applyUrlHosts: hosts, formObservations: [], restrictionPhrases: extractRestrictionPhrases(texts), storeMasterCompleteness: "unknown", pastExamples: summarizePastExamples(pastRows(chain)), knowledge: selectKnowledge(store, { chain, hosts }, now) };
      const s = budget.start("unit_infer", unitInferReserveJpy(gate.model));
      if (!s.ok) { stoppedBy = s.reason; break; }
      const r = await infer(ctx);
      s.finish(r.costJpy);
      if (!r.inference) continue;
      const v = verifyUnitInference(r.inference, ctx);
      raw.set(t.c.clusterId, v);
      log.push({ id: t.c.clusterId, unit: v.independentUnit, direct: v.directEvidence, confidence: v.confidence, timing: v.selectionTiming, downgraded: v.downgraded });
    }
    const after = base.map((x) => ({ ...x, after: decideOpportunity({ cluster: x.c, facts: x.facts, eligibility: x.el, now, unresolvedDuplicatePairs: x.dup, isLottery: true, unitInference: raw.get(x.c.clusterId) ?? null }) }));

    // ---------------- 対立仮説の電池（架空）
    const battery: { name: string; expect: string; unit: string; timing: string; direct: boolean; confidence: string; alternatives: string[]; knowledgeIds: string[]; displayAtApply: boolean; downgraded: string[] }[] = [];
    for (const b of BATTERY) {
      const ctx: UnitContext = { texts: b.texts, chain: b.chain, stores: b.stores, products: ["架空TCG 拡張パック「テスト弾」"], applyUrlHosts: b.hosts, formObservations: [], restrictionPhrases: extractRestrictionPhrases(b.texts), storeMasterCompleteness: "unknown", pastExamples: [], knowledge: selectKnowledge(store, { chain: b.chain, hosts: b.hosts }, now) };
      const s = budget.start("unit_infer_battery", unitInferReserveJpy(gate.model));
      if (!s.ok) { stoppedBy = s.reason; break; }
      const r = await infer(ctx);
      s.finish(r.costJpy);
      if (!r.inference) continue;
      const v = verifyUnitInference(r.inference, ctx);
      battery.push({ name: b.name, expect: b.expect, unit: v.independentUnit, timing: v.selectionTiming, direct: v.directEvidence, confidence: v.confidence, alternatives: v.alternatives.map((a) => a.unit), knowledgeIds: [...new Set(v.evidence.flatMap((e) => e.knowledgeIds))], displayAtApply: v.displayStoreSelectAtApply, downgraded: v.downgraded });
    }

    const unitBefore = count(base.map((x) => x.before.unitStatus));
    const unitAfter = count(after.map((x) => x.after.unitStatus));
    const notExcl = after.filter((x) => x.after.decision !== "excluded");
    const stoppedElsewhere = after.filter((x) => x.after.unitStatus !== "unknown" && x.after.decision === "needs_review");
    const summary = {
      note: "Stage 10Q 再評価（ローカル・Git管理外）。人の確認は行っていない。推論は仮説であり正解率ではない",
      sameInput: { opportunities: base.length, nonExcluded: notExcl.length, facts: all.length },
      applyUnit: { before10P: unitBefore, after10Q: unitAfter, inferred: raw.size, inferredDirectEvidence: [...raw.values()].filter((v) => v.directEvidence).length, byUnit: count([...raw.values()].map((v) => v.independentUnit)), byConfidence: count([...raw.values()].map((v) => v.confidence)), timing: count([...raw.values()].map((v) => v.selectionTiming)), downgraded: count([...raw.values()].flatMap((v) => v.downgraded)) },
      decisions: { before10P: count(base.map((x) => x.before.decision)), after10Q: count(after.map((x) => x.after.decision)), stillNeedsReviewDespiteUnit: stoppedElsewhere.length, stillNeedsReviewReasons: count(after.filter((x) => x.after.decision === "needs_review").flatMap((x) => x.after.reasons)), tentativeReasons: count(after.filter((x) => x.after.decision === "tentative_candidate").flatMap((x) => x.after.reasons)) },
      battery,
      stoppedBy,
      budget: budget.summary(),
    };
    writeFileSync("eval/real-data/xsource-10q.json", JSON.stringify(summary, null, 1));
    writeFileSync("eval/real-data/human-review-10q.json", JSON.stringify({ note: "人の確認用（ローカルのみ・Git管理外）。例外・不確実なものを先に", battery, opportunities: after.filter((x) => x.after.decision !== "excluded").map((x) => ({ clusterId: x.c.clusterId, before: x.before.decision, after: x.after.decision, reasons: x.after.reasons, unitStatus: x.after.unitStatus, hypothesis: x.after.unitHypothesis, inference: raw.get(x.c.clusterId) ?? null })).sort((a, b) => (a.after === "tentative_candidate" ? 0 : 1) - (b.after === "tentative_candidate" ? 0 : 1)) }, null, 1));
    expect(budget.calls).toBeLessThanOrEqual(MAX_CALLS);
    expect(budget.costJpy).toBeLessThanOrEqual(MAX_COST + 0.01);
    // 公式性・応募単位の推論は、除外・既存の登録の判断を変えない
    expect(after.filter((x) => x.before.decision === "excluded").every((x) => x.after.decision === "excluded")).toBe(true);
    expect(after.every((x) => x.after.reasons.every((r) => !/official/.test(r)))).toBe(true);
    expect(after.filter((x) => x.after.decision === "auto_register_preview").every((x) => x.after.unitStatus === "explicit" || x.after.unitStatus === "inferred_direct")).toBe(true);
  }, 1_800_000);
});
