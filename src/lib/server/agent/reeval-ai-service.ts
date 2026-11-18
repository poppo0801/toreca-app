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
import { judgeRelations, type JudgeOutcome, type RelFacts } from "@/lib/agent/relation-judge";
import { researchStoreLocation, type ResearchOutcome } from "@/lib/agent/store-location/run";
import type { StoreTarget } from "@/lib/agent/store-location/verify";
import type { SearchHit, SearchOutcome, SearchProvider } from "@/lib/agent/store-location/tools";
import { createCaseWorld, SEARCH_WORST_JPY } from "@/lib/server/agent/case-world";
import { SafePageFetcher, realGeocode } from "@/lib/server/agent/real-providers";
import { createInvestigatorBrain } from "@/lib/agent/case-investigator/real-brain";
import { assessInvestigation, assessRegion, nameObservations, targetOf, type Assessment, type ExistingLottery, type RegionVerdict } from "@/lib/agent/reeval-ai/assess";
import type { FieldKey } from "@/lib/collector/fields";
import { resolveMasterAndLearn } from "@/lib/server/master-identity/alias-service";
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
  investigate(target: CaseTarget): Promise<CaseInvestigationResult>;
  research(store: StoreTarget, existingAddress: string | null): Promise<ResearchOutcome>;
  judge(lots: RelFacts[], pairs: [string, string][]): Promise<JudgeOutcome>;
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
  perCaseJpy?: number;
  ledgerDir: string;
  clientFactory?: (apiKey: string) => Pick<Anthropic, "messages">;
  fetcher?: import("@/lib/agent/store-location/tools").PageFetcher;
}

/** 実AI・実Webの接続（関門を通ったときだけ）。上限は100円以下に固定（今回の検証の承認範囲）。AIは上限を変更できない */
export function realReevalDeps(o: RealAiOptions): { ok: true; deps: AiDeps; guard: RealRunGuard } | { ok: false; reason: string } {
  if (!(o.capJpy > 0) || o.capJpy > 100) return { ok: false, reason: "費用の上限が不正です（1〜100円）" };
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
  const wrapped = guard.wrapClient(raw, "agent");
  const { world } = createCaseWorld({ search: new AnthropicWebSearch(raw, g.model), guard, ...(o.fetcher ? { fetcher: o.fetcher } : {}) });
  const llm = createInvestigatorBrain(wrapped, g.model);
  const controls = (): ResolvedControls => {
    const d = resolveControls({ runsToday: 0, costTodayJpy: 0, workerDailyAiLimit: 30, aiCallsToday: 0 }, { mode: "dry_run", realApi: true });
    if (!d.ok) throw new Error("調査の上限を決められません");
    return { ...d.controls, limits: { ...d.controls.limits, maxSteps: 16, maxMs: 150_000, maxCostJpy: Math.min(o.perCaseJpy ?? 15, Math.max(0, o.capJpy - guard.spentJpy)) } };
  };
  // 店舗所在地の調査用の検索（費用は同じ台帳へ）
  const inner = new AnthropicWebSearch(raw, g.model);
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
  const deps: AiDeps = {
    model: g.model,
    classify: EMPTY_CLASSIFY_CTX,
    investigate: async (target) => {
      guard.startCase(target.id);
      return investigateCase({ llm, world, target, controls: controls(), classify: EMPTY_CLASSIFY_CTX });
    },
    research: async (store, existing) => {
      guard.startCase(`store:${store.name}`);
      return researchStoreLocation(store, existing, { llm: new AnthropicAgentLLM(wrapped, g.model), search, fetcher: o.fetcher ?? new SafePageFetcher(), geocode: realGeocode, limits: { ...g.limits, maxCostJpy: Math.min(o.perCaseJpy ?? 15, Math.max(0, o.capJpy - guard.spentJpy)) }, followUps: 1 });
    },
    judge: async (lots, pairs) => {
      guard.startCase("relation-judge");
      return judgeRelations(wrapped, g.model, lots, pairs);
    },
    spentJpy: () => guard.spentJpy,
    capJpy: o.capJpy,
    stopped: () => guard.stopped,
  };
  return { ok: true, deps, guard };
}

// ------------------------------------------------------------ 単位の処理（DBに触れない）
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
    result = await deps.investigate(targetOf(l, (u) => classifyCaseSource(u, deps.classify).kind));
  } catch (e) {
    return { aiState: "failed", verdict: "inconclusive", summary: { error: e instanceof Error ? e.message.slice(0, 160) : "調査に失敗しました" }, costJpy: deps.spentJpy() - before, result: null };
  }
  const a = assessInvestigation(l, result, now);
  return {
    aiState: a.aiState,
    verdict: a.deadline === "passed" ? "confirm" : a.deadline === "extended" || a.deadline === "open" ? "refute" : "inconclusive",
    assessment: a,
    summary: { fetched: a.fetched, failed: a.failed, fills: a.fills, differs: a.differs, unknown: a.unknown, deadline: a.deadline, stop: a.stopReason, queries: result.queries.length, notes: a.notes },
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
