/**
 * 自律追加調査（Stage 10E・非同期の状態機械）。未解決の具体的な問い → AIが次の行動を選ぶ → 読み取り専用で実行 → 再判断 → 解決/保留。
 *  - 取得は読み取り専用の `PageFetcher`（9Zの `EvidenceReuseFetcher`・`collection_hard_sources` を包んで再利用できる）。書き込み・投稿はしない。
 *  - 優先順位: 重要度・締切の近さ・期待効果（AIの示唆。上限あり）・既知の取得不能・費用。固定の点数でAIの選択を縛らず、順序づけの目安にだけ使う。
 *  - 停止: 無進展（新しい根拠も解決も無い）の連続／同じ失敗経路／取得不能（回避しない）／回数・時間・費用の上限／締切の経過／解決。
 *    新しい根拠（ハッシュ）があれば、停止中の問いを安全に再開できる。
 *  - 費用は「追加調査」の枠だけを使う。新規発見の枠から借りない（budget.ts）。費用が不明なら予約額で計上。
 *  - 通常の収集ジョブには接続しない（10F）。登録を待たせない設計: 呼び出し側は、調査の完了を待たずに暫定登録できる（`provisionalReady`）。
 */
import { redact } from "@/lib/case-model/redact";
import { precheckFetchTarget, type FetchBoundary } from "./fetch-safety";
import { BudgetStop, type BudgetPools } from "./budget";
import type { EvidenceSeed } from "./build-input";
import type { JudgmentInput, JudgmentOutput, UnresolvedItem } from "./contract";
import { judgeCase, type EngineDeps, type JudgmentResult } from "./engine";
import type { JudgmentModel, PlanAnswer } from "./model";

/** ページ取得の境界（9Zの EvidenceReuseFetcher／store-location の PageFetcher と構造的に互換。lib/agent を静的に読み込まないため、ここで型だけ定義する） */
export type FetchedPage = { ok: true; text: string; stored?: boolean } | { ok: false; message: string };
export interface PageFetcher {
  /** ネットワーク境界の保証の宣言（必須）。実装は src/lib/server/safe-fetch.ts 相当の保証（DNS解決後の全アドレス検査・リダイレクト再検査・上限）を満たすこと。宣言のない部品は渡せない */
  readonly boundary: FetchBoundary;
  fetchPage(url: string): Promise<FetchedPage>;
}

export type QuestionStatus = "open" | "resolved" | "stalled" | "blocked" | "abandoned";

export interface Question {
  id: string;
  text: string;
  importance: "high" | "medium" | "low";
  status: QuestionStatus;
  attempts: string[]; // 実行した行動の指紋
  noProgress: number;
  reason?: string;
}

export interface InvestigationLimits {
  maxSteps: number;
  /** 経過時間の上限（ミリ秒） */
  maxElapsedMs: number;
  /** 同じ問いで、進展が無いまま続けてよい回数 */
  maxNoProgress: number;
  /** 取得失敗を何回まで許すか（同じ問いで） */
  maxFailuresPerQuestion: number;
}
export const DEFAULT_LIMITS: InvestigationLimits = { maxSteps: 6, maxElapsedMs: 60_000, maxNoProgress: 2, maxFailuresPerQuestion: 2 };

export type StopReason = "all_resolved" | "max_steps" | "timeout" | "budget" | "no_progress" | "deadline_passed" | "nothing_to_do" | "model_error";

export interface InvestigationDeps {
  model: JudgmentModel;
  budget: BudgetPools;
  fetcher: PageFetcher;
  now: () => Date;
  limits?: Partial<InvestigationLimits>;
  /** 判断エンジンの依存（pool は追加調査に固定される） */
  engine: Omit<EngineDeps, "pool" | "model" | "budget">;
  /** 締切（ISO）。過ぎたら調査を止める */
  deadlineAt?: string | null;
}

export interface InvestigationResult {
  stopReason: StopReason;
  questions: Question[];
  steps: number;
  evidenceAdded: number;
  result: JudgmentResult | null;
  input: JudgmentInput;
  /** 調査の完了を待たずに暫定登録してよいか（構造が未確定でも、最低限の応募機会が検証済みで1つあるとき） */
  provisionalReady: boolean;
  log: string[];
}

const fp = (kind: string, target: string) => `${kind}:${target.replace(/#.*$/, "").replace(/\/$/, "")}`;
const hostOf = (u: string) => {
  try {
    return new URL(u).hostname.replace(/^www\./, "").toLowerCase();
  } catch {
    return "";
  }
};

/** 問いの優先度（順序づけの目安）。重要度・締切の近さ・既知の取得不能・過去の無進展 */
export function questionPriority(q: Question, o: { now: Date; deadlineAt?: string | null; blockedHint?: boolean }): number {
  let p = q.importance === "high" ? 100 : q.importance === "medium" ? 50 : 20;
  if (o.deadlineAt) {
    const h = (new Date(o.deadlineAt).getTime() - o.now.getTime()) / 3_600_000;
    if (h <= 0) return -1; // 締切後は調べない
    if (h <= 24) p += 60;
    else if (h <= 72) p += 30;
  }
  if (o.blockedHint) p -= 40;
  p -= q.noProgress * 15;
  return p;
}

export function questionsFrom(unresolved: UnresolvedItem[], prev: Question[]): Question[] {
  const byId = new Map(prev.map((q) => [q.id, q]));
  return unresolved.map((u) => ({ ...(byId.get(u.id) ?? { attempts: [], noProgress: 0, status: "open" as QuestionStatus }), id: u.id, text: u.question, importance: u.importance }));
}

const toSeed = (page: Extract<FetchedPage, { ok: true }>, url: string, now: Date): EvidenceSeed => ({
  url,
  fetchedAt: now.toISOString(),
  via: "web_fetch",
  origin: "unknown",
  text: redact(page.text ?? ""),
  hash: null,
  status: "fetched",
  reused: !!page.stored,
});

export async function investigate(deps: InvestigationDeps, startInput: JudgmentInput, first: JudgmentResult): Promise<InvestigationResult> {
  const limits = { ...DEFAULT_LIMITS, ...deps.limits };
  const startedAt = deps.now().getTime();
  const log: string[] = [];
  let input = startInput;
  let result: JudgmentResult | null = first;
  const questions = first.output ? questionsFrom(first.output.unresolved, []) : [];
  let steps = 0;
  let added = 0;
  const knownHashes = new Set(input.evidence.map((e) => e.hash).filter((h): h is string => !!h));
  const knownUrls = new Set(input.evidence.map((e) => fp("fetch_url", e.url)));
  const blockedHosts = new Set(input.failures.filter((f) => f.kind === "unfetchable").map((f) => hostOf(f.url)));

  const finish = (s: StopReason): InvestigationResult => ({
    stopReason: s,
    questions,
    steps,
    evidenceAdded: added,
    result,
    input,
    provisionalReady: provisionalReady(result?.output ?? null),
    log,
  });

  while (true) {
    const open = questions.filter((q) => q.status === "open");
    if (!open.length) return finish(questions.length && questions.every((q) => q.status === "resolved") ? "all_resolved" : "nothing_to_do");
    if (steps >= limits.maxSteps) return finish("max_steps");
    if (deps.now().getTime() - startedAt > limits.maxElapsedMs) return finish("timeout");
    const ranked = open.map((q) => ({ q, p: questionPriority(q, { now: deps.now(), deadlineAt: deps.deadlineAt }) })).sort((a, b) => b.p - a.p);
    if (ranked[0].p < 0) return finish("deadline_passed");
    const q = ranked[0].q;

    // 1. AIが次の行動を選ぶ（読み取り専用の決まった種類のみ）
    let plan: PlanAnswer;
    let planTicket;
    try {
      planTicket = deps.budget.reserve("investigation", deps.model.maxCostJpy(input));
    } catch (e) {
      if (e instanceof BudgetStop) return finish("budget");
      throw e;
    }
    try {
      const c = await deps.model.planAction({ question: q.text, attempted: q.attempts, blockedHosts: [...blockedHosts], input });
      deps.budget.settle(planTicket, c.costJpy);
      plan = c.raw as PlanAnswer;
    } catch {
      deps.budget.release(planTicket, false);
      return finish("model_error");
    }
    steps++;

    const kind = (plan as { kind?: string })?.kind;
    if (kind === "give_up" || kind === "ask_human" || kind === "none" || kind === "wait") {
      q.status = kind === "ask_human" ? "blocked" : "abandoned";
      q.reason = (plan as { reason?: string }).reason;
      log.push(`${q.id}: ${kind}`);
      continue;
    }
    if (kind !== "fetch_url" && kind !== "search") {
      // 決まった種類以外の行動（命令らしき文面から出たものを含む）は実行しない
      q.noProgress++;
      log.push(`${q.id}: 不正な行動を拒否`);
      if (q.noProgress >= limits.maxNoProgress) { q.status = "stalled"; q.reason = "不正な行動が続いた"; }
      continue;
    }
    const target = String((plan as { target?: string }).target ?? "");
    const f = fp(kind, target);
    if (q.attempts.includes(f) || (kind === "fetch_url" && knownUrls.has(f))) {
      q.noProgress++;
      log.push(`${q.id}: 同じ行動の繰り返しを拒否（${f.slice(0, 60)}）`);
      if (q.noProgress >= limits.maxNoProgress) { q.status = "stalled"; q.reason = "同じ失敗経路・同じ情報源を繰り返した"; }
      if (!questions.some((x) => x.status === "open")) return finish("no_progress");
      continue;
    }
    q.attempts.push(f);
    if (kind === "search") {
      // 検索は実AI・外部APIを伴うため、10Eのエンジンでは実行しない（取得のみ）。接続は承認後
      q.status = "blocked";
      q.reason = "検索は未接続（承認制）";
      log.push(`${q.id}: 検索は未接続`);
      continue;
    }
    if (blockedHosts.has(hostOf(target))) {
      q.status = "blocked";
      q.reason = "取得不能と記録された情報源（回避しない）";
      log.push(`${q.id}: 取得不能の情報源を実行せず`);
      continue;
    }
    // AIが返したURLは信用しない: 取得の前に事前検査（多層防御。実際の保証はfetcherのネットワーク境界）。危険なURLは取得器を呼ばない
    const pre = precheckFetchTarget(target);
    if (!pre.ok) {
      q.noProgress++;
      log.push(`${q.id}: 取得先を拒否（${pre.reason}）`);
      if (q.noProgress >= limits.maxNoProgress) { q.status = "stalled"; q.reason = "安全でない取得先が続いた"; }
      if (!questions.some((x) => x.status === "open")) return finish("no_progress");
      continue;
    }
    let page: FetchedPage;
    try {
      page = await deps.fetcher.fetchPage(target);
    } catch {
      page = { ok: false, message: "取得に失敗しました" };
    }
    if (!page.ok) {
      q.noProgress++;
      blockedHosts.add(hostOf(target)); // この実行の中では同じ情報源へ再び行かない
      input = { ...input, failures: [...input.failures, { url: target, kind: "unfetchable", at: deps.now().toISOString() }] };
      log.push(`${q.id}: 取得失敗`);
      if (q.attempts.length >= limits.maxFailuresPerQuestion && q.noProgress >= limits.maxNoProgress) { q.status = "stalled"; q.reason = "取得に失敗し続けた"; }
      if (!questions.some((x) => x.status === "open")) return finish("no_progress");
      continue;
    }

    // 2. 新しい根拠を入力へ足して再判断する
    const seed = toSeed(page, target, deps.now());
    const text = seed.text ?? "";
    knownUrls.add(f);
    const dup = input.evidence.some((e) => e.text != null && e.text === text.slice(0, 3500));
    if (dup) {
      q.noProgress++;
      log.push(`${q.id}: 既知の内容（新しい根拠なし）`);
      if (q.noProgress >= limits.maxNoProgress) { q.status = "stalled"; q.reason = "新しい根拠が得られなかった"; }
      if (!questions.some((x) => x.status === "open")) return finish("no_progress");
      continue;
    }
    const id = `E${input.evidence.length + 1}`;
    input = { ...input, evidence: [...input.evidence, { id, url: seed.url, fetchedAt: seed.fetchedAt ?? null, via: seed.via, origin: seed.origin ?? "unknown", status: "fetched", text: text.slice(0, 3500), hash: null, reused: seed.reused }], feedback: undefined };
    added++;
    const r2 = await judgeCase({ ...deps.engine, model: deps.model, budget: deps.budget, pool: "investigation" }, input);
    if (r2.status === "budget_stopped") return finish("budget");
    if (r2.status === "model_error") return finish("model_error");
    result = r2;
    if (r2.output) {
      const still = new Set(r2.output.unresolved.map((u) => u.id));
      for (const x of questions) if (x.status === "open" && !still.has(x.id)) x.status = "resolved";
      // 新しい問いも取り込む（上限つき）
      for (const nq of questionsFrom(r2.output.unresolved, questions)) if (!questions.some((x) => x.id === nq.id)) questions.push(nq);
      if (still.has(q.id) && q.status === "open") { q.noProgress++; if (q.noProgress >= limits.maxNoProgress) { q.status = "stalled"; q.reason = "新しい根拠でも解決しなかった"; } }
    }
    log.push(`${q.id}: 根拠を追加して再判断（${r2.status}）`);
  }
}

/** 停止中の問いを、新しい根拠（ハッシュ）が得られたときに再開する */
export function resumeIfNewEvidence(questions: Question[], knownHashes: Set<string>, newHashes: string[]): Question[] {
  const fresh = newHashes.some((h) => !knownHashes.has(h));
  if (!fresh) return questions;
  return questions.map((q) => (q.status === "stalled" || q.status === "abandoned" ? { ...q, status: "open" as QuestionStatus, noProgress: 0, reason: undefined } : q));
}

/** 調査の完了を待たずに暫定登録してよいか: 構造が未確定でも、検証済みの応募機会が1つ以上あり、取得できた根拠に基づく（fact）項目が1つ以上ある */
export function provisionalReady(o: JudgmentOutput | null): boolean {
  if (!o || o.opportunities.length < 1) return false;
  if (o.caseType.value === "not_lottery") return false;
  return o.opportunities.some((op) => [op.applyDeadline, op.store, op.chain, op.products].some((c) => c && c.basis === "fact" && c.citations.length > 0));
}
