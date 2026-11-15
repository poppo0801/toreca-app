import "server-only";
import Anthropic from "@anthropic-ai/sdk";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AgentLLM } from "@/lib/agent/core";
import { AnthropicWebSearch } from "@/lib/agent/anthropic";
import { resolveControls, type ResolvedControls } from "@/lib/agent/collection-planner/controls";
import { RealRunGuard, type LedgerState } from "@/lib/agent/collection-planner/real-guard";
import type { PlannerWorld } from "@/lib/agent/collection-planner/types";
import { investigateCase, type CaseInvestigationResult } from "@/lib/agent/case-investigator/engine";
import type { CaseTarget } from "@/lib/agent/case-investigator/ledger";
import { createInvestigatorBrain } from "@/lib/agent/case-investigator/real-brain";
import { EMPTY_CLASSIFY_CTX, classifyCaseSource, type ClassifyContext } from "@/lib/agent/case-investigator/source-class";
import { resultToCaseFile } from "@/lib/agent/case-investigator/to-case";
import { checkRealApi } from "@/lib/agent/real-gate";
import type { PageFetcher } from "@/lib/agent/store-location/tools";
import { flexToStr } from "@/lib/case-model/from-extraction";
import type { InvestigationRequest, InvestigationResponse } from "@/lib/case-model/investigation-types";
import type { CaseFieldKey } from "@/lib/case-model/types";
import type { FieldKey } from "@/lib/collector/fields";
import { createCaseWorld, type WorldLogEntry } from "@/lib/server/agent/case-world";

/**
 * 収集処理 → 調査エージェントの橋渡し（Stage 9H-3B/3C。開発専用。収集処理からは investigation-hook 経由の動的読み込みだけで呼ばれる）。
 * 収集処理の抽出結果から調査対象（CaseTarget）を作り、調査エンジンを実行し、結果を共通モデル（案件ファイル）で返す。**DBへは書かない**（反映は収集処理の既存の登録経路が行う）。
 *
 * 調査機能（AIの頭脳・情報の取得）の接続:
 *  1. 明示的な接続（configureInvestigation）: 開発・評価・テストが、頭脳と情報源を指定する。
 *  2. 実AI（Haiku・実検索）: 環境が **すべて** 許可しているときだけ。関門 checkRealApi（TOREMANE_ENV=local・AGENT_REAL_API=allow・開発専用キー・費用上限）に加えて、
 *     COLLECT_INVESTIGATE_CONFIRM=yes（実行ごとの確認）と COLLECT_INVESTIGATE_CAP_JPY（累計の上限円。未設定は接続しない）が必要。累計・1件あたりの費用は RealRunGuard が呼び出しの前に確認し、超える見込みなら呼ばない。
 *  どれにも当てはまらなければ未接続（skipped）。収集は従来どおり進む。
 */
export interface BridgeDeps {
  llm: AgentLLM;
  world: PlannerWorld;
  /** 調査の上限。関数なら案件ごとに呼ぶ（残りの予算で上限が変わる実AI用） */
  controls?: ResolvedControls | ((caseId: string) => ResolvedControls);
  classify?: ClassifyContext;
  now?: () => number;
  /** 案件の調査の前後（費用の台帳の案件単位の開始など） */
  beforeCase?: (caseId: string) => void;
  /** 調査の結果の全体（行動の記録・入力・費用）を受け取る（評価・記録用。DBへは書かない） */
  onResult?: (r: CaseInvestigationResult, target: CaseTarget) => void;
}

let configured: BridgeDeps | null = null;
/** 開発・評価用の明示的な接続（null で解除） */
export function configureInvestigation(d: BridgeDeps | null): void {
  configured = d;
  realCache = null;
}

type Env = Record<string, string | undefined>;
export type RealDepsResult = { ok: true; deps: BridgeDeps; guard: RealRunGuard; log: WorldLogEntry[] } | { ok: false; reason: string };

export interface RealOptions {
  env: Env;
  /** Anthropic クライアントの生成（テストで台本のクライアントに差し替える。既定は実クライアント） */
  clientFactory?: (apiKey: string) => Pick<Anthropic, "messages">;
  /** ページ取得（テストで差し替える。既定は安全な取得＝robots.txt尊重・SSRF対策） */
  fetcher?: PageFetcher;
  /** 費用の台帳の置き場所（既定 backups/eval-9h3c） */
  ledgerDir?: string;
}

const PER_CASE_DEFAULT = 15;

/** 実AI・実検索の接続（関門を通ったときだけ）。キー・認証情報は返す理由に含めない */
export function realInvestigationDeps(o: RealOptions): RealDepsResult {
  const e = o.env;
  const cap = Number(e.COLLECT_INVESTIGATE_CAP_JPY);
  if (!(cap > 0)) return { ok: false, reason: "実AIの累計上限（COLLECT_INVESTIGATE_CAP_JPY）が未設定です" };
  const g = checkRealApi({ env: e, confirm: e.COLLECT_INVESTIGATE_CONFIRM === "yes", runsToday: 0 });
  if (!g.ok) return { ok: false, reason: g.reason };
  const perCase = Number(e.COLLECT_INVESTIGATE_PER_CASE_JPY) > 0 ? Number(e.COLLECT_INVESTIGATE_PER_CASE_JPY) : PER_CASE_DEFAULT;
  const dir = o.ledgerDir ?? join(process.cwd(), "backups", "eval-9h3c");
  const file = join(dir, "ledger.json");
  const prior = (() => {
    try {
      return JSON.parse(readFileSync(file, "utf8")) as LedgerState;
    } catch {
      return null;
    }
  })();
  const guard = new RealRunGuard({
    capJpy: cap,
    perCaseJpy: perCase,
    model: g.model,
    spentBefore: prior?.spentJpy ?? 0,
    persist: (s) => {
      mkdirSync(dir, { recursive: true });
      writeFileSync(file, JSON.stringify({ ...s, entries: [...(prior?.entries ?? []), ...s.entries] }, null, 1));
    },
  });
  const raw = o.clientFactory ? o.clientFactory(g.apiKey) : new Anthropic({ apiKey: g.apiKey, maxRetries: 0, timeout: 60_000 });
  const llm = createInvestigatorBrain(guard.wrapClient(raw, "agent"), g.model);
  const { world, log } = createCaseWorld({ search: new AnthropicWebSearch(raw, g.model), guard, ...(o.fetcher ? { fetcher: o.fetcher } : {}) });
  const controls = (): ResolvedControls => {
    const d = resolveControls({ runsToday: 0, costTodayJpy: 0, workerDailyAiLimit: 30, aiCallsToday: 0 }, { mode: "dry_run", realApi: true });
    if (!d.ok) throw new Error("調査の上限を決められません");
    const remaining = Math.max(0, cap - guard.spentJpy);
    return { ...d.controls, limits: { ...d.controls.limits, maxSteps: 16, maxMs: 150_000, maxCostJpy: Math.min(perCase, remaining) } };
  };
  return { ok: true, guard, log, deps: { llm, world, controls, beforeCase: (id) => guard.startCase(id) } };
}

let realCache: RealDepsResult | null = null;
function realFromEnv(): RealDepsResult {
  if (!realCache || !realCache.ok) realCache = realInvestigationDeps({ env: process.env });
  return realCache;
}

const TO_FIELD: Partial<Record<CaseFieldKey, FieldKey>> = { chain: "chain", store: "store", items: "items", applyStart: "applyStart", applyDeadline: "applyDeadline", resultStart: "resultDate", applyMethod: "applyMethod", conditions: "conditions", applyUrl: "applyUrl", receiveMethod: "receiveMethod" };

export function targetFromRequest(req: InvestigationRequest, classify: ClassifyContext): CaseTarget {
  const ex = req.extraction;
  const select = ex.applyUnit === "store_select";
  const known: Partial<Record<FieldKey, string>> = {};
  const put = (k: FieldKey, v: string | null) => {
    if (v) known[k] = v;
  };
  put("items", ex.items.map((i) => i.name).join(" / "));
  put("applyStart", flexToStr(ex.applyStart));
  put("applyDeadline", flexToStr(ex.applyDeadline));
  put("resultDate", flexToStr(ex.resultDate));
  return {
    id: req.candidateId,
    chain: ex.chainName,
    ...(!select && ex.storeName ? { store: ex.storeName } : {}),
    storeMode: select ? "select_on_apply" : "fixed",
    products: ex.items.map((i) => i.name),
    known,
    manualFields: req.humanLocked.map((k) => TO_FIELD[k]).filter((f): f is FieldKey => !!f),
    knownSources: [{ url: req.url, kind: classifyCaseSource(req.url, classify).kind }],
  };
}

export async function investigateForCollection(req: InvestigationRequest, explicit: BridgeDeps | null = configured): Promise<InvestigationResponse> {
  let deps = explicit;
  if (!deps) {
    const real = realFromEnv();
    if (!real.ok) return { skipped: "no_investigator_configured" };
    deps = real.deps;
  }
  // 情報源の分類: 収集側が渡した材料（利用者が登録した公式サイト・公式X・まとめ）を、明示された設定に加える（9H-3D。渡さないと、取得したページが公式と判定されず確定に至らなかった）
  const base = deps.classify ?? EMPTY_CLASSIFY_CTX;
  const u = (a: string[], b: string[] = []) => [...new Set([...a, ...b])];
  const classify: ClassifyContext = req.classify ? { officialHosts: u(base.officialHosts, req.classify.officialHosts), officialAccounts: u(base.officialAccounts, req.classify.officialAccounts), aggregatorHosts: u(base.aggregatorHosts, req.classify.aggregatorHosts), aggregatorAccounts: u(base.aggregatorAccounts, req.classify.aggregatorAccounts) } : base;
  const controls =
    typeof deps.controls === "function"
      ? deps.controls(req.candidateId)
      : (deps.controls ??
        (() => {
          const d = resolveControls({ runsToday: 0, costTodayJpy: 0, workerDailyAiLimit: 30, aiCallsToday: 0 }, { mode: "dry_run", realApi: false });
          if (!d.ok) throw new Error("調査の上限を決められません");
          return d.controls;
        })());
  deps.beforeCase?.(req.candidateId);
  const target = targetFromRequest(req, classify);
  const r = await investigateCase({ llm: deps.llm, world: deps.world, target, controls, classify, ...(deps.now ? { now: deps.now } : {}), context: req.humanHints });
  deps.onResult?.(r, target);
  const at = new Date((deps.now ?? Date.now)()).toISOString();
  return { caseFile: resultToCaseFile(r, target, at), stopReason: r.stopReason };
}
