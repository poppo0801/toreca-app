import "server-only";
import Anthropic from "@anthropic-ai/sdk";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { AnthropicAgentLLM, AnthropicWebSearch } from "@/lib/agent/anthropic";
import { investigateCase, type CaseInvestigationResult } from "@/lib/agent/case-investigator/engine";
import { EMPTY_CLASSIFY_CTX, classifyCaseSource, type ClassifyContext } from "@/lib/agent/case-investigator/source-class";
import type { CaseTarget } from "@/lib/agent/case-investigator/ledger";
import { RealRunGuard, type LedgerState } from "@/lib/agent/collection-planner/real-guard";
import { resolveControls, type ResolvedControls } from "@/lib/agent/collection-planner/controls";
import { checkRealApi } from "@/lib/agent/real-gate";
import { judgeNames, type NameJudgeOutcome, type NameQuery } from "@/lib/agent/name-judge";
import { DEFAULT_AI_MODEL } from "@/lib/ai-cost";
import { DEFAULT_LIMITS, type AgentLimits } from "@/lib/agent/core";
import { judgeRelations, type JudgeOutcome, type RelFacts } from "@/lib/agent/relation-judge";
import { researchStoreLocation, type ResearchOutcome } from "@/lib/agent/store-location/run";
import type { StoreTarget } from "@/lib/agent/store-location/verify";
import type { SearchHit, SearchOutcome, SearchProvider } from "@/lib/agent/store-location/tools";
import { createCaseWorld, SEARCH_WORST_JPY } from "@/lib/server/agent/case-world";
import { SafePageFetcher, realGeocode } from "@/lib/server/agent/real-providers";
import { createInvestigatorBrain } from "@/lib/agent/case-investigator/real-brain";
import { nameSearchQueries } from "@/lib/agent/name-judge";
import { EvidenceReuseFetcher, type EvidenceFetchStats } from "@/lib/agent/case-investigator/evidence-fetcher";
import type { StoredEvidence } from "@/lib/collector/evidence";
import { assessForm, assessInvestigation, assessRegion, nameObservations, targetOf, type Assessment, type ExistingLottery, type FormAssessment, type RegionVerdict } from "@/lib/agent/reeval-ai/assess";
import type { FieldKey } from "@/lib/collector/fields";
import { loadMasterEntries, resolveMasterAndLearn } from "@/lib/server/master-identity/alias-service";
import { lotteryProtection } from "@/lib/server/master-identity/reeval-service";
import type { Db } from "@/lib/server/lottery-service";

/**
 * 自律型AIによる既存抽選の再調査（Stage 9H-3S-2）。固定ロジックの提案（暫定）を、AIが実際の情報源を調べ直して確認する。
 *  - 調査の主体はAI（調査エンジン・店舗所在地の調査・関係の判定）。固定ロジックは、安全・整合性・費用の上限・保護の検査だけを行う
 *  - 実際に情報源を取得できなかったものは「調査済み」にしない（ai_state=failed）。確認できたものだけが、適用の対象になる
 *  - 費用は一括再評価の別枠（呼び出し側が上限を決める）で記録する。上限を超える見込みなら呼ばない
 * 実AI・実Webは、関門（開発環境・許可・開発専用キー・費用上限・確認）を通ったときだけ接続される。テストでは台本の依存（AiDeps）を渡す。
 */
export interface AiDeps {
  model: string;
  classify: ClassifyContext;
  /** o.maxCostJpy: この調査だけの費用の上限（全体の上限・1件の上限を超えない）。blockedHosts: これまでの調査で取得できなかった（ロボット制限・ログイン必須）ホスト */
  investigate(target: CaseTarget, o?: { maxCostJpy?: number; evidence?: StoredEvidence[] }): Promise<CaseInvestigationResult>;
  /** Stage 9Z: 取得部品の統計（保存済み原文の再利用・取得制限の再試行抑制・ホスト別の成否）。未接続なら無し */
  fetchStats?(): EvidenceFetchStats;
  /** Stage 9Z: 過去の取得失敗の記録（永続）を取得部品へ接続する */
  attachLedger?(o: { knownBlocked?: (url: string) => boolean; onBlocked?: (url: string, message: string) => void }): void;
  blockedHosts?: Set<string>;
  research(store: StoreTarget, existingAddress: string | null): Promise<ResearchOutcome>;
  judge(lots: RelFacts[], pairs: [string, string][]): Promise<JudgeOutcome>;
  /** 名称の同一性の調査用のWeb検索（Stage 9H-3S-3）。費用は同じ台帳へ。未接続なら名称の調査をしない */
  webSearch?(query: string): Promise<SearchHit[]>;
  judgeNames?(items: { query: NameQuery; hits: SearchHit[] }[]): Promise<NameJudgeOutcome>;
  /** 累計の費用（円。検索料金を含む）。呼び出しの前後の差を、項目に記録する */
  spentJpy(): number;
  capJpy: number;
  /** 費用の上限・連続エラーなどで全体が止まった理由（止まっていなければ null） */
  stopped(): string | null;
}

type Env = Record<string, string | undefined>;
export interface RealAiOptions {
  env: Env;
  capJpy: number;
  /** 費用の上限の最大値（既定100円）。検証専用の予算が100円を超える承認を受けたときだけ、評価の仕組み（tests/）が指定する。AIは変更できない */
  maxCapJpy?: number;
  perCaseJpy?: number;
  ledgerDir: string;
  clientFactory?: (apiKey: string) => Pick<Anthropic, "messages">;
  fetcher?: import("@/lib/agent/store-location/tools").PageFetcher;
  /** Stage 9Z: 過去の取得失敗の記録（永続）から、再取得しない情報源か。取得制限と分かった失敗の記録先 */
  knownBlocked?: (url: string) => boolean;
  onBlocked?: (url: string, message: string) => void;
  /** Stage 9Z: 取得部品の設定（改善前後の比較評価で suppress:false を指定する） */
  fetcherOptions?: import("@/lib/agent/case-investigator/evidence-fetcher").EvidenceFetcherOptions;
}

/** 実AI・実Webの接続（関門を通ったときだけ）。上限は100円以下に固定（今回の検証の承認範囲）。AIは上限を変更できない */
export function realReevalDeps(o: RealAiOptions): { ok: true; deps: AiDeps; guard: RealRunGuard } | { ok: false; reason: string } {
  const hardMax = o.maxCapJpy ?? 100;
  if (!(o.capJpy > 0) || o.capJpy > hardMax) return { ok: false, reason: `費用の上限が不正です（1〜${hardMax}円）` };
  const g = checkRealApi({ env: o.env, confirm: true, runsToday: 0 });
  if (!g.ok) return { ok: false, reason: g.reason };
  const file = join(o.ledgerDir, "ledger.json");
  const prior = (() => {
    try {
      return JSON.parse(readFileSync(file, "utf8")) as LedgerState;
    } catch {
      return null;
    }
  })();
  const guard = new RealRunGuard({
    capJpy: o.capJpy,
    perCaseJpy: o.perCaseJpy ?? 15,
    model: g.model,
    spentBefore: prior?.spentJpy ?? 0,
    persist: (s) => {
      mkdirSync(o.ledgerDir, { recursive: true });
      writeFileSync(file, JSON.stringify({ ...s, entries: [...(prior?.entries ?? []), ...s.entries] }, null, 1));
    },
  });
  const raw = o.clientFactory ? o.clientFactory(g.apiKey) : new Anthropic({ apiKey: g.apiKey, maxRetries: 0, timeout: 60_000 });
  return { ok: true, deps: assembleDeps({ raw, model: g.model, guard, capJpy: o.capJpy, perCaseJpy: o.perCaseJpy ?? 15, limits: g.limits, ...(o.fetcher ? { fetcher: o.fetcher } : {}), ...(o.knownBlocked ? { knownBlocked: o.knownBlocked } : {}), ...(o.onBlocked ? { onBlocked: o.onBlocked } : {}), ...(o.fetcherOptions ? { fetcherOptions: o.fetcherOptions } : {}) }), guard };
}

/**
 * 本番の接続（Stage 9H-3S-3）。開発の関門（real-gate）とは別に、明示的な許可（REEVAL_AI=on）と、利用者が指定した費用の上限（バッチごと）を使う。
 *  - キー: REEVAL_ANTHROPIC_API_KEY → AUTONOMOUS_ANTHROPIC_API_KEY → ANTHROPIC_API_KEY（既存のAI解析・自律型収集と同じ契約。追加契約なし）
 *  - 上限: 呼び出し側が指定（バッチの残り予算）。環境の上限 REEVAL_AI_MAX_JPY（既定100円）を超えて指定できない。AIは変更できない
 *  - 費用の記録: 台帳ファイルは使わない（Vercelはファイルに書けない）。呼び出し側が、実行後に一括再評価のバッチへ積み上げる（通常収集の予算とは別枠）
 */
export function prodReevalDeps(o: { env: Env; capJpy: number; perCaseJpy?: number; clientFactory?: (apiKey: string) => Pick<Anthropic, "messages">; fetcher?: import("@/lib/agent/store-location/tools").PageFetcher; knownBlocked?: (url: string) => boolean; onBlocked?: (url: string, message: string) => void }): { ok: true; deps: AiDeps; guard: RealRunGuard } | { ok: false; reason: string } {
  const e = o.env;
  if (e.REEVAL_AI !== "on") return { ok: false, reason: "一括再調査のAI実行が有効になっていません（REEVAL_AI=on が必要）" };
  const key = (e.REEVAL_ANTHROPIC_API_KEY ?? e.AUTONOMOUS_ANTHROPIC_API_KEY ?? e.ANTHROPIC_API_KEY)?.trim();
  if (!key) return { ok: false, reason: "AIのAPIキーが設定されていません" };
  const hardMax = Number(e.REEVAL_AI_MAX_JPY) > 0 ? Number(e.REEVAL_AI_MAX_JPY) : 100;
  if (!(o.capJpy > 0) || o.capJpy > hardMax) return { ok: false, reason: `費用の上限が不正です（1〜${hardMax}円）` };
  const perCase = Math.min(o.perCaseJpy ?? 15, o.capJpy);
  const model = e.REEVAL_MODEL?.trim() || DEFAULT_AI_MODEL;
  const guard = new RealRunGuard({ capJpy: o.capJpy, perCaseJpy: perCase, model, spentBefore: 0 });
  const raw = o.clientFactory ? o.clientFactory(key) : new Anthropic({ apiKey: key, maxRetries: 0, timeout: 60_000 });
  const limits: AgentLimits = { ...DEFAULT_LIMITS, maxCostJpy: perCase, maxMs: 120_000 };
  return { ok: true, deps: assembleDeps({ raw, model, guard, capJpy: o.capJpy, perCaseJpy: perCase, limits, ...(o.fetcher ? { fetcher: o.fetcher } : {}), ...(o.knownBlocked ? { knownBlocked: o.knownBlocked } : {}), ...(o.onBlocked ? { onBlocked: o.onBlocked } : {}) }), guard };
}

function assembleDeps(a: { raw: Pick<Anthropic, "messages">; model: string; guard: RealRunGuard; capJpy: number; perCaseJpy: number; limits: AgentLimits; fetcher?: import("@/lib/agent/store-location/tools").PageFetcher; knownBlocked?: (url: string) => boolean; onBlocked?: (url: string, message: string) => void; fetcherOptions?: import("@/lib/agent/case-investigator/evidence-fetcher").EvidenceFetcherOptions }): AiDeps {
  const { raw, model, guard } = a;
  const wrapped = guard.wrapClient(raw, "agent");
  // Stage 9Z: 取得部品を、保存済み原文の再利用・取得制限の再試行抑制つきの包みにする（取得の実体は従来のまま）
  const evFetcher = new EvidenceReuseFetcher(a.fetcher ?? new SafePageFetcher(), { ...(a.knownBlocked ? { knownBlocked: a.knownBlocked } : {}), ...(a.onBlocked ? { onBlocked: a.onBlocked } : {}), ...(a.fetcherOptions ?? {}) });
  const { world } = createCaseWorld({ search: new AnthropicWebSearch(raw as Anthropic, model), guard, fetcher: evFetcher });
  const llm = createInvestigatorBrain(wrapped, model);
  const blocked = new Set<string>();
  const remaining = () => Math.min(a.perCaseJpy, Math.max(0, a.capJpy - guard.spentJpy));
  const controls = (): ResolvedControls => {
    const d = resolveControls({ runsToday: 0, costTodayJpy: 0, workerDailyAiLimit: 30, aiCallsToday: 0 }, { mode: "dry_run", realApi: true });
    if (!d.ok) throw new Error("調査の上限を決められません");
    return { ...d.controls, limits: { ...d.controls.limits, maxSteps: 16, maxMs: 150_000, maxCostJpy: remaining() } };
  };
  // 店舗所在地・名称の調査用の検索（費用は同じ台帳へ）
  const inner = new AnthropicWebSearch(raw as Anthropic, model);
  const search: SearchProvider = {
    name: inner.name,
    search: async (q: string): Promise<SearchHit[] | SearchOutcome> => {
      guard.precheck(SEARCH_WORST_JPY);
      const r = await inner.search(q);
      const out: SearchOutcome = Array.isArray(r) ? { hits: r } : r;
      guard.chargeJpy("search", out.costJpy ?? SEARCH_WORST_JPY);
      return out;
    },
  };
  return {
    model,
    classify: EMPTY_CLASSIFY_CTX,
    blockedHosts: blocked,
    fetchStats: () => evFetcher.stats,
    attachLedger: (o) => evFetcher.setOptions(o),
    investigate: async (target, o) => {
      guard.startCase(target.id);
      evFetcher.setStored(o?.evidence ?? []);
      const c = controls();
      const r = await investigateCase({ llm, world, target, controls: o?.maxCostJpy ? { ...c, limits: { ...c.limits, maxCostJpy: Math.min(c.limits.maxCostJpy, o.maxCostJpy) } } : c, classify: EMPTY_CLASSIFY_CTX });
      // 取得できなかった情報源のホストを覚える（回避はしない。次の調査の費用の判断に使う）
      for (const x of r.sources) if (x.status === "failed" && (x.failKind === "robots_blocked" || x.failKind === "login_required")) {
        try { blocked.add(new URL(x.url).hostname.replace(/^www\./, "")); } catch { /* 不正なURLは無視 */ }
      }
      return r;
    },
    research: async (store, existing) => {
      guard.startCase(`store:${store.name}`);
      return researchStoreLocation(store, existing, { llm: new AnthropicAgentLLM(wrapped, model), search, fetcher: a.fetcher ?? new SafePageFetcher(), geocode: realGeocode, limits: { ...a.limits, maxCostJpy: remaining() }, followUps: 1 });
    },
    judge: async (lots, pairs) => {
      guard.startCase("relation-judge");
      return judgeRelations(wrapped, model, lots, pairs);
    },
    webSearch: async (q) => {
      const r = await search.search(q);
      return Array.isArray(r) ? r : r.hits;
    },
    judgeNames: async (items) => {
      guard.startCase("name-judge");
      return judgeNames(wrapped, model, items);
    },
    spentJpy: () => guard.spentJpy,
    capJpy: a.capJpy,
    stopped: () => guard.stopped,
  };
}

// ------------------------------------------------------------ 単位の処理（DBに触れない）
/** 登録済みの情報源がすべて取得できない既知のホストだけのときの、1件あたりの調査費用の上限（円） */
export const BLOCKED_SOURCE_BUDGET_JPY = 3;

export interface UnitOutcome {
  aiState: Assessment["aiState"];
  verdict: "confirm" | "refute" | "inconclusive";
  summary: Record<string, unknown>;
  assessment?: Assessment;
  region?: RegionVerdict;
  costJpy: number;
}

/** 期限切れ・日付の不足: 実Webの情報源を調べ直して、締切の状況と不足している日付を確認する */
export async function reinvestigateLottery(deps: AiDeps, l: ExistingLottery, now: Date): Promise<UnitOutcome & { result: CaseInvestigationResult | null }> {
  const before = deps.spentJpy();
  let result: CaseInvestigationResult | null = null;
  try {
    // 登録済みの情報源がすべて、これまでの調査で取得できなかったホスト（ロボット制限・ログイン必須）だけなら、解決の見込みが低いため、費用を小さく抑える
    // （調査自体は行う＝別の情報源を探すかはAIが決める。実測（Stage 9X）: こうした43件で、別の情報源から補えたものは0件・費用は1件 約6.7円）
    const hostOf = (u: string) => { try { return new URL(u).hostname.replace(/^www\./, ""); } catch { return ""; } };
    const onlyBlocked = l.sourceUrls.length > 0 && l.sourceUrls.every((u) => deps.blockedHosts?.has(hostOf(u)));
    // 初回収集で保存した原文があれば、取得制限のURLでも原文で検証できるため、費用を絞らない
    const hasStored = (l.storedEvidence?.length ?? 0) > 0;
    const opts = { ...(onlyBlocked && !hasStored ? { maxCostJpy: BLOCKED_SOURCE_BUDGET_JPY } : {}), ...(hasStored ? { evidence: l.storedEvidence } : {}) };
    result = await deps.investigate(targetOf(l, (u) => classifyCaseSource(u, deps.classify).kind), Object.keys(opts).length ? opts : undefined);
  } catch (e) {
    return { aiState: "failed", verdict: "inconclusive", summary: { error: e instanceof Error ? e.message.slice(0, 160) : "調査に失敗しました" }, costJpy: deps.spentJpy() - before, result: null };
  }
  const a = assessInvestigation(l, result, now);
  return {
    aiState: a.aiState,
    verdict: a.deadline === "passed" ? "confirm" : a.deadline === "extended" || a.deadline === "open" ? "refute" : "inconclusive",
    assessment: a,
    summary: { fetched: a.fetched, failed: a.failed, fills: a.fills, differs: a.differs, unknown: a.unknown, deadline: a.deadline, stop: a.stopReason, queries: result.queries.length, notes: a.notes, alternatives: result.alternatives && result.alternatives.blocked.length ? { blocked: result.alternatives.blocked.map((b) => ({ host: b.host, reason: b.reason })).slice(0, 4), reached: result.alternatives.found.map((f) => ({ host: f.host, tier: f.tier, status: f.status })).slice(0, 6), recovered: result.alternatives.recovered, unresolved: result.alternatives.unresolved } : null },
    costJpy: deps.spentJpy() - before,
    result,
  };
}

/** 地域: 店舗の実所在地を公式の店舗一覧などで調べ直す（告知文中の地名だけで決めない）。確認済みでなければ不明のまま */
export async function researchRegion(deps: AiDeps, store: StoreTarget, existingAddress: string | null, prefectures: string[]): Promise<UnitOutcome & { research: ResearchOutcome | null }> {
  const before = deps.spentJpy();
  try {
    const out = await deps.research(store, existingAddress);
    const r = assessRegion(out.result, prefectures);
    return {
      aiState: out.result.status === "confirmed" ? "investigated" : out.result.status === "failed" ? "failed" : "insufficient",
      verdict: r.verdict === "out_of_area" ? "confirm" : r.verdict === "in_area" ? "refute" : "inconclusive",
      region: r,
      summary: { status: out.result.status, address: out.result.address, prefecture: out.result.prefecture, official: r.official, basis: r.basis, sources: out.result.sources.slice(0, 3).map((s) => ({ url: s.url, official: s.official })) },
      costJpy: deps.spentJpy() - before,
      research: out,
    };
  } catch (e) {
    return { aiState: "failed", verdict: "inconclusive", summary: { error: e instanceof Error ? e.message.slice(0, 160) : "調査に失敗しました" }, costJpy: deps.spentJpy() - before, research: null };
  }
}


// ------------------------------------------------------------ 応募構造（抽選形態）の判定（Stage 9H-3S-3）
export interface FormOutcome extends UnitOutcome {
  result: CaseInvestigationResult | null;
  form: FormAssessment;
}
/** 同じ情報源・同じ商品の店舗別カードについて、AIが情報源から応募構造を調べる。根拠が確認できたときだけ判定を出す（正解を与えない。系列の傾向は参考にしない） */
export async function judgeFormGroup(deps: AiDeps, l: ExistingLottery, now: Date): Promise<FormOutcome> {
  const out = await reinvestigateLottery(deps, l, now);
  const form = out.result ? assessForm(out.result) : ({ form: "unknown", basis: "調査に失敗した", quote: "", url: null, tier: null, viaStructure: false } as FormAssessment);
  const fetched = out.assessment?.fetched ?? 0;
  // ページに到達できたが、同じ抽選と確認できなかった（別の抽選・二次情報のみ）ものは「取得できず」ではなく「判断に足りない」
  const reached = (out.result?.sources ?? []).filter((x) => x.status === "fetched" || x.status === "quarantined" || x.status === "different_lottery").length;
  // 取得できた情報源で確認できたときだけ。店舗選択式の確認=confirm／店舗別独立の確認=refute（統合しない）／確認できない=inconclusive
  const verdict: UnitOutcome["verdict"] = fetched === 0 ? "inconclusive" : form.form === "store_select" ? "confirm" : form.form === "store_independent" ? "refute" : "inconclusive";
  const aiState: UnitOutcome["aiState"] = reached === 0 ? "failed" : fetched === 0 || form.form === "unknown" ? "insufficient" : "investigated";
  return { ...out, aiState, verdict, form, summary: { ...out.summary, form: form.form, formBasis: form.basis, formQuote: form.quote, formUrl: form.url, formTier: form.tier, viaStructure: form.viaStructure } };
}

// ------------------------------------------------------------ 名称の同一性（Stage 9H-3S-3）
export interface NameOutcome extends UnitOutcome {
  learned: LearnedAlias | null;
}
/** 未解決の名称が、候補のマスターと同じ系列・商品かを、AIがWebで調べて判断する。根拠が揃えば別名を自動学習、足りなければ関連候補として保持 */
export async function resolveNameWithAi(db: Db, householdId: string, deps: AiDeps, q: NameQuery, actor: string | null, o: { /** 観測した名称そのもののマスター（仮登録）。照合の対象から外す（自分自身に一致して「既に登録済み」とならないように） */ excludeMasterId?: string } = {}): Promise<NameOutcome> {
  const before = deps.spentJpy();
  if (!deps.webSearch || !deps.judgeNames) return { aiState: "failed", verdict: "inconclusive", summary: { error: "名称の調査が接続されていない" }, costJpy: 0, learned: null };
  try {
    const hits: SearchHit[] = [];
    for (const query of nameSearchQueries(q)) {
      if (deps.stopped() || deps.capJpy - deps.spentJpy() < 3) break;
      for (const h of await deps.webSearch(query)) if (!hits.some((x) => x.url === h.url)) hits.push(h);
    }
    if (hits.length === 0) return { aiState: "failed", verdict: "inconclusive", summary: { note: "検索結果を取得できなかった" }, costJpy: deps.spentJpy() - before, learned: null };
    const out = await deps.judgeNames([{ query: q, hits }]);
    const j = out.judgments[0];
    if (!j) return { aiState: "insufficient", verdict: "inconclusive", summary: { note: "AIが判断しなかった" }, costJpy: deps.spentJpy() - before, learned: null };
    let learned: LearnedAlias | null = null;
    if (j.relation === "same") {
      const masters = o.excludeMasterId ? (await loadMasterEntries(db, householdId, q.kind)).filter((m) => m.id !== o.excludeMasterId) : undefined;
      const r = await resolveMasterAndLearn(db, householdId, q.kind, q.observed, { origin: "ai", evidence: j.evidence, actor, ...(masters ? { masters } : {}), target: { masterId: q.candidateId, masterName: q.candidateName, reason: "AIが調べた候補" } });
      learned = { kind: q.kind, name: q.observed, action: r.decision.action, reason: r.decision.reason, persisted: r.persisted };
    }
    return {
      aiState: "investigated",
      verdict: j.relation === "same" ? "confirm" : j.relation === "different" ? "refute" : "inconclusive",
      summary: { relation: j.relation, rationale: j.rationale, adjusted: j.adjusted, cites: j.verifiedCites, independentDomains: j.independentDomains, observed: q.observed, candidate: q.candidateName, learned },
      costJpy: deps.spentJpy() - before,
      learned,
    };
  } catch (e) {
    return { aiState: "failed", verdict: "inconclusive", summary: { error: e instanceof Error ? e.message.slice(0, 160) : "調査に失敗しました" }, costJpy: deps.spentJpy() - before, learned: null };
  }
}

// ------------------------------------------------------------ 別名の学習（調査エージェントからの根拠の接続）
export interface LearnedAlias {
  kind: "chain" | "product";
  name: string;
  action: string;
  reason: string;
  persisted: "alias" | "candidate" | null;
}
/** 調査で見つけた系列・商品の表記を、情報源・根拠つきで名寄せ機構へ渡す。根拠が十分なものは別名として登録され、足りなければ関連候補として保持される */
export async function learnFromInvestigation(db: Db, householdId: string, result: CaseInvestigationResult, actor: string | null): Promise<LearnedAlias[]> {
  const out: LearnedAlias[] = [];
  for (const o of nameObservations(result)) {
    const r = await resolveMasterAndLearn(db, householdId, o.kind, o.name, { origin: "ai", evidence: o.evidence, actor });
    out.push({ kind: o.kind, name: o.name, action: r.decision.action, reason: r.decision.reason, persisted: r.persisted });
  }
  return out;
}

// ------------------------------------------------------------ 店舗の所在地の蓄積（確認済みのときだけ）
/** 公式情報で確認できた所在地と根拠を、店舗マスターへ蓄積する。確認済み（公式の店舗一覧に番地までの住所）以外は更新しない。人が入力した住所は上書きしない */
export async function accumulateStoreLocation(db: Db, storeId: string, out: ResearchOutcome): Promise<{ updated: boolean; reason: string }> {
  const r = out.result;
  if (r.status !== "confirmed" || !r.prefecture || !r.address || !r.sources.some((s) => s.official)) return { updated: false, reason: "確認済み（公式の情報源に住所）ではないため、店舗マスターは更新しない" };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- 新しい列は生成型に含まれない
  const a = db as any;
  const { data: cur } = await a.from("stores").select("prefecture,address_optional,latitude,longitude,location_verified_at").eq("id", storeId).maybeSingle();
  if (!cur) return { updated: false, reason: "店舗が見つかりません" };
  const patch: Record<string, unknown> = { location_evidence: { address: r.address, prefecture: r.prefecture, sources: r.sources.slice(0, 3).map((s) => ({ url: s.url, quote: s.quote.slice(0, 160), official: s.official })), confidence: r.confidence, reasons: r.reasons.slice(0, 4), by: "ai-9h3s2" }, location_verified_at: new Date().toISOString() };
  if (!cur.prefecture || cur.prefecture !== r.prefecture) patch.prefecture = r.prefecture; // 都道府県は公式情報で確認できたものに合わせる
  if (!cur.address_optional) patch.address_optional = r.address;
  if (cur.latitude == null && r.lat != null && r.lng != null) Object.assign(patch, { latitude: r.lat, longitude: r.lng });
  const { error } = await a.from("stores").update(patch).eq("id", storeId);
  return error ? { updated: false, reason: "保存できませんでした" } : { updated: true, reason: "公式情報で確認した所在地と根拠を店舗マスターに蓄積した" };
}

export type { FieldKey };
export { lotteryProtection };
