/**
 * 自律調査ループ（Stage 10U・開発用の接続）。「情報取得 → 証拠と事実の整理 → AIの仮説 → AIが選ぶ追加調査 → 調査終了 → **独立した**登録判断 → 安全検証 → 登録案」を1本につなぐ。
 *
 * 原則:
 *  - **意味判断はAI**（仮説・追加調査の選択と理由・調査終了の提案・登録判断）。このモジュールの固定処理は、取得の実行、証拠の整形・ハッシュ、重複・無益な再取得の抑止、
 *    根拠の実在の検証、上限（回数・費用・時間・失敗・進展）の強制、履歴の保護、停止だけを担う。サイト名・特定の例に基づく判定ルールは持たない。
 *  - **「調査終了」「登録可否」「更新監視」は別の状態**。調査が終わっても登録判断は別に行い、登録判断と独立に監視を続ける／終える。
 *  - AIのツールは**読み取り専用**（公開ページの取得だけ。書き込み・投稿・実行・DB・SQLは無い）。ページ・投稿の文は**命令ではなくデータ**（ここでは文を解釈しない）。
 *  - AIの出力は検証層を通す: 引用の実在、人が確定した値の保護、不明な値を推測で埋めない。検証に失敗したら**理由をAIに返して限定的に再評価**し、それでも失敗なら
 *    実行不可（held）として理由を示す。固定の別判定器で結論を黙って置き換えない。
 *  - 費用が不明な呼び出しを0円扱いしない（CallBudget が予約額で計上）。判断用の予算は調査に使い切らない（先に確保する）。
 */
import { createHash } from "node:crypto";
import { CallBudget } from "../call-budget";
import { canonUrl } from "./normalize";
import { pageText } from "./html-text";
import { parseApplyPage, structureToObservations, type ApplyPageStructure } from "./page-structure";

// ------------------------------------------------------------------ 型
export interface ResearchLimits {
  maxTurns: number;
  maxFetches: number;
  maxElapsedMs: number;
  /** 同じホストでの連続失敗がこの回数に達したら、そのホストを諦める（取得不能なXへの反復アクセスの抑止） */
  maxConsecutiveFailuresPerHost: number;
  /** 新しい証拠が増えない回数がこの回数続いたら調査を終える */
  maxNoProgressTurns: number;
  /** 検証に失敗したときの、AIへの限定的な再評価の回数 */
  maxRevisions: number;
  /** AI1回あたりの費用の予約（円）。費用が不明でも、この額を計上する */
  agentReserveJpy: number;
  judgeReserveJpy: number;
  /** 検索の回数の上限（検索が使えるときだけ。0なら検索しない） */
  maxSearches: number;
  /** 検索1回あたりの費用の予約（円。検索料金＋結果を読むトークンの概算。費用が不明でもこの額を計上する） */
  searchReserveJpy: number;
}
export const DEFAULT_RESEARCH_LIMITS: ResearchLimits = { maxTurns: 6, maxFetches: 6, maxElapsedMs: 180_000, maxConsecutiveFailuresPerHost: 2, maxNoProgressTurns: 2, maxRevisions: 1, agentReserveJpy: 3, judgeReserveJpy: 3, maxSearches: 2, searchReserveJpy: 3 };

export type FetchFailure = "blocked" | "robots" | "not_public" | "login_required" | "failed" | "timeout";
export type FetchOutcome = { ok: true; finalUrl: string; html: string; text: string } | { ok: false; reason: FetchFailure };
/** AIが使えるツール（読み取り専用）。公開ページの取得だけ。SSRF・robots・レート制限・サイズ・時間は実装側（既存の安全な取得）が担う */
export interface SearchHitLite {
  title: string;
  url: string;
  snippet: string;
}
export interface ResearchTools {
  fetchPage(url: string): Promise<FetchOutcome>;
  now(): Date;
  /** （任意・読み取り専用）公開Webの検索。結果は**候補のURLと抜粋（データ）**で、証拠ではない（取得してページ構造・対応の検査を通して初めて証拠になる）。無い環境では検索できない */
  search?(query: string): Promise<{ ok: true; hits: SearchHitLite[]; costJpy: number | null } | { ok: false; reason: string }>;
}

export interface Evidence {
  id: string;
  kind: "seed" | "page";
  url: string | null;
  fetchedAt: string;
  contentHash: string;
  text: string;
  /** 取得したページの構造（受付枠・関連イベント・フォーム設問。10T）。ページ自身の受付枠と「同じ販売元のイベント」は別 */
  structure: ApplyPageStructure | null;
  /** このページが対象の抽選そのものを指すか（親投稿のURLを別項目へ流用しない）。判断はAI・検証は引用の実在とスコープ確認 */
  independent: boolean;
  /** リンクの出所と、ページと項目の対応の検査結果（10S link-scope。無根拠の一括流用の防止）。X起点の接続で設定する。未設定=対応の検査なし */
  scope?: EvidenceScope;
}
export interface EvidenceScope {
  /** 例: item_entity / parent_shared / parent_card / discovered */
  origin: string;
  verdict: "confirmed" | "candidate" | "mismatch" | "unknown";
  refutes: string[];
}

export interface Claim {
  text: string;
  evidenceId: string;
  /** 根拠の引用（原文の一部）。検証層が、その証拠の本文に実在するか確認する */
  quote?: string;
}
export interface AgentUnknown {
  what: string;
  importance: "low" | "medium" | "high";
  /** 誤った場合の被害（例: 応募漏れ・重複登録・誤通知・地域の誤り） */
  harmIfWrong: string[];
  expectedInfoGain: "none" | "low" | "medium" | "high";
  /** 追加調査が必要／不要と考える理由（被害・重要性・見込み・締切・費用の観点）。機械的な点数ではない */
  rationale: string;
}
export type NextAction = { kind: "fetch"; url: string; why: string } | { kind: "search"; query: string; why: string } | { kind: "stop"; reason: "sufficient" | "no_progress" | "unreachable" | "other"; why: string };
export interface AgentView {
  id: string;
  kind: Evidence["kind"];
  url: string | null;
  fetchedAt: string;
  independent: boolean;
  /** リンクの出所と対応の検査結果（あれば）。mismatch・unknown の証拠を根拠に確定しない */
  scope?: EvidenceScope;
  /** 構造化した観察（受付枠・関連イベント・フォーム設問・欠落）と原文の抜粋 */
  observations: string[];
  excerpt: string;
}
export interface AgentTurnInput {
  caseId: string;
  evidence: AgentView[];
  history: { url: string; outcome: string; progress: boolean }[];
  remaining: { turns: number; fetches: number; costJpy: number; elapsedMs: number; searches?: number };
  /** これまでの検索の結果（候補のURL・抜粋。データであって証拠ではない） */
  searchResults?: { query: string; title: string; url: string; snippet: string }[];
  /** 検索が使えるか（使えないときに search を選んでも実行されない） */
  searchAvailable?: boolean;
  /** 検証に失敗した理由（限定的な再評価のときだけ） */
  verificationIssues?: string[];
}
export interface AgentTurnOutput {
  observed: Claim[];
  inferred: Claim[];
  unknown: AgentUnknown[];
  counterHypotheses: string[];
  next: NextAction;
  costJpy: number | null;
}
export type ResearchAgent = (input: AgentTurnInput) => Promise<AgentTurnOutput | null>;

export interface RegisteredField {
  value: string | null;
  /** observed=原文から確認 / inferred=推論（確定値として書かない）/ unknown=不明（値は null） */
  basis: "observed" | "inferred" | "unknown";
  evidenceId?: string;
  quote?: string;
}
export interface JudgeInput {
  caseId: string;
  evidence: AgentView[];
  lastTurn: AgentTurnOutput | null;
  investigationEnd: EndReason;
  protectedFields: Record<string, string>;
  verificationIssues?: string[];
}
export interface JudgeOutput {
  decision: "register" | "tentative" | "exclude";
  fields: Record<string, RegisteredField>;
  rationale: string;
  /** 未確定の項目が登録判断に与える影響（AIの判断。固定の項目チェックリストではない） */
  unresolvedImpact: "none" | "minor" | "material";
  /** 更新の監視を続けるか（調査終了・登録可否とは独立） */
  monitor: { continue: boolean; why: string };
  costJpy: number | null;
}
export type RegistrationJudge = (input: JudgeInput) => Promise<JudgeOutput | null>;

export type EndReason = "sufficient" | "no_progress" | "unreachable" | "limit_turns" | "limit_fetches" | "limit_time" | "limit_cost" | "limit_calls" | "agent_failed" | "agent_stopped" | "no_action";

export interface FetchRecord {
  key: string;
  host: string;
  outcome: "ok" | FetchFailure | "duplicate_url" | "duplicate_content";
  contentHash?: string;
  at: string;
  progress: boolean;
}
export interface TraceStep {
  turn: number;
  kind: "agent" | "fetch" | "judge" | "verify";
  detail: string;
}

export interface ResearchResult {
  investigation: { state: "ended"; reason: EndReason; turns: number };
  /** 登録判断の各ラウンド（最初の判断→限定的な再評価）の引用の分類。最終状態は registration（重複なし） */
  quoteAudit: { round: number; rows: QuoteAuditRow[] }[];
  registration: { decision: JudgeOutput["decision"] | "none"; output: JudgeOutput | null; verified: boolean; held: { reasons: string[] } | null; proposals: FieldProposal[] };
  monitoring: { state: "active" | "ended"; why: string; reopenOn: ReopenTrigger[] };
  evidence: Evidence[];
  history: FetchRecord[];
  trace: TraceStep[];
  budget: ReturnType<CallBudget["summary"]>;
  /** 実行した検索と、その結果（候補のURL。証拠ではない）。発見評価（B2）で「検索で見つけたURLか」を確認するのに使う */
  searches: { query: string; title: string; url: string; snippet: string }[];
}
export interface FieldProposal {
  field: string;
  action: "set" | "update" | "ask_human";
  value: string | null;
  basis: RegisteredField["basis"];
  note?: string;
}

// ------------------------------------------------------------------ 補助
const sha = (s: string): string => createHash("sha256").update(s.normalize("NFKC").replace(/\s+/g, " ").trim()).digest("hex").slice(0, 16);
const norm = (s: string): string => s.normalize("NFKC").replace(/[\s　]+/g, "").toLowerCase();

export function seedEvidence(id: string, text: string, now: Date, url: string | null = null): Evidence {
  return { id, kind: "seed", url, fetchedAt: now.toISOString(), contentHash: sha(text), text, structure: null, independent: true };
}

function pageEvidence(n: number, url: string, o: Extract<FetchOutcome, { ok: true }>, now: Date): Evidence {
  const structure = parseApplyPage(o.html);
  // 本文は、取得側の粗いテキストではなくHTMLから作り直す（スクリプト・head・エンティティの除去）。AIの見る抜粋と、引用の検証が同じ本文になる
  const cleaned = o.html ? pageText(o.html) : "";
  const text = cleaned.length >= 20 ? cleaned : o.text;
  return { id: `p${n}`, kind: "page", url: o.finalUrl || url, fetchedAt: now.toISOString(), contentHash: sha(text), text, structure, independent: true };
}

/** AIに渡す原文の抜粋の長さ（本文に整形したあと。実評価で、本文が見えず観察の要約を引用した失敗の是正） */
export const EXCERPT_CHARS = 2500;

export function toAgentView(e: Evidence): AgentView {
  return { id: e.id, kind: e.kind, url: e.url, fetchedAt: e.fetchedAt, independent: e.independent, scope: e.scope, observations: e.structure ? structureToObservations(e.structure) : [], excerpt: e.text.slice(0, EXCERPT_CHARS) };
}

/** 同じ内容（転載・同一ページの別URL）は独立した裏付けと数えない */
export function independentEvidenceCount(evidence: readonly Evidence[]): number {
  return new Set(evidence.filter((e) => e.independent).map((e) => e.contentHash)).size;
}

// ------------------------------------------------------------------ 検証層（AIの意味判断は変えない）
export type QuoteAuditKind = "ok" | "no_evidence" | "no_quote" | "too_short" | "in_observations_only" | "partial_overlap" | "not_found";
export interface QuoteAuditRow {
  field: string;
  kind: QuoteAuditKind;
  quoteChars: number;
  /** 引用が、AIに見せた抜粋（先頭 EXCERPT_CHARS）の範囲にあるか。範囲外にあれば「見えていない原文からの引用」 */
  inExcerpt: boolean | null;
}
/** observed 項目ごとの引用の実在を分類する（検証の合否は変えない。原因の追跡用。原文は記録しない） */
export function auditQuotes(output: JudgeOutput, evidence: readonly Evidence[]): QuoteAuditRow[] {
  const byId = new Map(evidence.map((e) => [e.id, e]));
  const rows: QuoteAuditRow[] = [];
  for (const [field, f] of Object.entries(output.fields)) {
    if (f.basis !== "observed") continue;
    const ev = f.evidenceId ? byId.get(f.evidenceId) : undefined;
    const q = f.quote ? norm(f.quote) : "";
    const base = { field, quoteChars: q.length };
    if (!ev) { rows.push({ ...base, kind: "no_evidence", inExcerpt: null }); continue; }
    if (!q) { rows.push({ ...base, kind: "no_quote", inExcerpt: null }); continue; }
    if (q.length < 3) { rows.push({ ...base, kind: "too_short", inExcerpt: null }); continue; }
    const text = norm(ev.text);
    if (text.includes(q)) { rows.push({ ...base, kind: "ok", inExcerpt: norm(ev.text.slice(0, EXCERPT_CHARS)).includes(q) }); continue; }
    const obs = norm(toAgentView(ev).observations.join(" "));
    if (obs.includes(q)) { rows.push({ ...base, kind: "in_observations_only", inExcerpt: false }); continue; }
    const grams = new Set<string>();
    for (let i = 0; i + 4 <= q.length; i++) grams.add(q.slice(i, i + 4));
    const hit = [...grams].filter((g) => text.includes(g)).length;
    rows.push({ ...base, kind: grams.size && hit / grams.size >= 0.6 ? "partial_overlap" : "not_found", inExcerpt: false });
  }
  return rows;
}

export interface VerifyInput {
  output: JudgeOutput;
  evidence: readonly Evidence[];
  protectedFields: Record<string, string>;
}
/** 根拠の実在・不明値の扱い・人が確定した値の保護。問題の理由（AIへ返す文）を返す。結論は書き換えない */
export function verifyRegistration(i: VerifyInput): { issues: string[]; proposals: FieldProposal[] } {
  const issues: string[] = [];
  const proposals: FieldProposal[] = [];
  const byId = new Map(i.evidence.map((e) => [e.id, e]));
  for (const [name, f] of Object.entries(i.output.fields)) {
    if (f.basis === "unknown") {
      if (f.value !== null) issues.push(`field_unknown_has_value:${name}`); // 不明なのに値を書かない
      proposals.push({ field: name, action: "set", value: null, basis: "unknown" });
      continue;
    }
    if (f.basis === "observed") {
      const ev = f.evidenceId ? byId.get(f.evidenceId) : undefined;
      if (!ev) issues.push(`evidence_missing:${name}`);
      else if (!f.quote || !norm(ev.text).includes(norm(f.quote)) || norm(f.quote).length < 3) issues.push(`quote_not_found:${name}`);
      else if (ev.scope?.verdict === "mismatch") issues.push(`scope_mismatch:${name}`); // 別の店舗・商品・系列・開催回のページを根拠にしない
      else if (ev.scope?.verdict === "unknown" && ev.scope.origin.startsWith("parent")) issues.push(`shared_link_scope_unverified:${name}`); // 親投稿共通のリンクを、対応が確認されないまま根拠にしない
    }
    const prot = i.protectedFields[name];
    if (prot !== undefined && f.value !== null && norm(prot) !== norm(f.value)) {
      // 人が確定した値は変更しない。矛盾は人への確認に回す（自動で上書きしない）
      proposals.push({ field: name, action: "ask_human", value: f.value, basis: f.basis, note: `確定済みの値と異なる提案（確定値: ${prot}）` });
      continue;
    }
    if (prot !== undefined) continue; // 同じ値: 変更なし
    proposals.push({ field: name, action: "set", value: f.value, basis: f.basis });
  }
  return { issues, proposals };
}

// ------------------------------------------------------------------ 本体
export async function runResearch(args: {
  caseId: string;
  seed: Evidence;
  agent: ResearchAgent;
  judge: RegistrationJudge;
  tools: ResearchTools;
  budget: CallBudget;
  limits?: Partial<ResearchLimits>;
  /** 人が確定した項目（AIが自律的に変更しない） */
  protectedFields?: Record<string, string>;
  /** 以前の取得履歴（再開時。同じURL・同じ内容の無益な再取得を避ける） */
  history?: FetchRecord[];
  evidence?: Evidence[];
  /** 取得したページの出所・対応の検査（X起点の接続で、項目ごとのリンクの出所と10Sの link-scope を使う）。未指定なら検査なし */
  scoper?: (url: string, page: Evidence) => EvidenceScope | undefined;
}): Promise<ResearchResult> {
  const L: ResearchLimits = { ...DEFAULT_RESEARCH_LIMITS, ...args.limits };
  const t0 = args.tools.now().getTime();
  const evidence: Evidence[] = [...(args.evidence ?? []), ...(args.evidence?.some((e) => e.id === args.seed.id) ? [] : [args.seed])];
  const history: FetchRecord[] = [...(args.history ?? [])];
  const trace: TraceStep[] = [];
  const protectedFields = args.protectedFields ?? {};
  const hostFail = new Map<string, number>();
  for (const h of history) if (h.outcome !== "ok" && h.outcome !== "duplicate_url" && h.outcome !== "duplicate_content") hostFail.set(h.host, (hostFail.get(h.host) ?? 0) + 1);
  let fetches = history.filter((h) => h.outcome !== "duplicate_url" && h.outcome !== "duplicate_content").length;
  let noProgress = 0;
  let lastTurn: AgentTurnOutput | null = null;
  let end: EndReason | null = null;
  let turn = 0;
  const elapsed = (): number => args.tools.now().getTime() - t0;
  const searchLog: { query: string; title: string; url: string; snippet: string }[] = [];
  const queries = new Set<string>();
  let searches = 0;
  const remaining = (): AgentTurnInput["remaining"] => ({ turns: L.maxTurns - turn, fetches: L.maxFetches - fetches, costJpy: args.budget.remainingJpy, elapsedMs: L.maxElapsedMs - elapsed(), searches: Math.max(0, L.maxSearches - searches) });

  // 判断用の予算を先に確保して、調査で使い切らない
  while (end === null) {
    if (turn >= L.maxTurns) { end = "limit_turns"; break; }
    if (elapsed() >= L.maxElapsedMs) { end = "limit_time"; break; }
    // 調査の1回分＋判断の1回分が残っているときだけ調査する
    const c = args.budget.check(L.agentReserveJpy + L.judgeReserveJpy);
    if (!c.ok) { end = c.reason === "calls" ? "limit_calls" : "limit_cost"; break; }
    turn++;
    const s = args.budget.start("research_turn", L.agentReserveJpy);
    if (!s.ok) { end = s.reason === "calls" ? "limit_calls" : "limit_cost"; break; }
    let out: AgentTurnOutput | null = null;
    try {
      out = await args.agent({ caseId: args.caseId, evidence: evidence.map(toAgentView), history: history.map((h) => ({ url: h.key, outcome: h.outcome, progress: h.progress })), remaining: remaining(), searchResults: searchLog.slice(-12), searchAvailable: !!args.tools.search && L.maxSearches > 0 });
    } catch {
      out = null; // 呼び出しが例外で終わっても、予約額を計上して（0円にしない）予約を解放し、停止する
    }
    s.finish(out?.costJpy ?? null);
    if (!out) { trace.push({ turn, kind: "agent", detail: "agent_failed" }); end = "agent_failed"; break; }
    lastTurn = out;
    trace.push({ turn, kind: "agent", detail: out.next.kind === "stop" ? `stop:${out.next.reason}` : out.next.kind === "search" ? "search" : `fetch:${out.next.url}` });
    if (out.next.kind === "stop") { end = out.next.reason === "sufficient" ? "sufficient" : out.next.reason === "unreachable" ? "unreachable" : out.next.reason === "no_progress" ? "no_progress" : "agent_stopped"; break; }

    if (out.next.kind === "search") {
      // 検索（読み取り専用・上限つき）。同じ検索語の再実行・上限超過・ツール無しは実行せず進展なしとして数える。検索語は個人情報を除いて渡す（redact は呼び出し側のツールが担う）
      const q = out.next.query.trim().slice(0, 120);
      if (!args.tools.search || searches >= L.maxSearches || !q || queries.has(norm(q))) {
        trace.push({ turn, kind: "fetch", detail: !args.tools.search ? "search_unavailable" : searches >= L.maxSearches ? "search_limit" : "search_duplicate" });
        noProgress++;
      } else {
        const ss = args.budget.start("search", L.searchReserveJpy);
        if (!ss.ok) { end = ss.reason === "calls" ? "limit_calls" : "limit_cost"; break; }
        searches++;
        queries.add(norm(q));
        let r: Awaited<ReturnType<NonNullable<ResearchTools["search"]>>> = { ok: false, reason: "failed" };
        try {
          r = await args.tools.search(q);
        } catch {
          r = { ok: false, reason: "failed" };
        }
        ss.finish(r.ok ? r.costJpy : null);
        if (r.ok) {
          for (const h of r.hits.slice(0, 8)) searchLog.push({ query: q, title: h.title.slice(0, 120), url: h.url.slice(0, 300), snippet: h.snippet.slice(0, 200) });
          trace.push({ turn, kind: "fetch", detail: `search_ok:${r.hits.length}` });
          if (r.hits.length) noProgress = 0;
          else noProgress++;
        } else {
          trace.push({ turn, kind: "fetch", detail: `search_failed:${r.reason}` });
          noProgress++;
        }
      }
      if (noProgress >= L.maxNoProgressTurns) { end = "no_progress"; break; }
      continue;
    }

    const url = out.next.url;
    const cu = canonUrl(url);
    const key = cu.key;
    // 取得してよいか（固定の安全・無益な再取得の抑止。意味判断ではない）
    if (cu.cls === "invalid" || !/^https:\/\//.test(url)) { history.push({ key, host: cu.host, outcome: "blocked", at: args.tools.now().toISOString(), progress: false }); trace.push({ turn, kind: "fetch", detail: `rejected_url:${cu.host}` }); noProgress++; }
    else if (history.some((h) => h.key === key && h.outcome === "ok")) { history.push({ key, host: cu.host, outcome: "duplicate_url", at: args.tools.now().toISOString(), progress: false }); trace.push({ turn, kind: "fetch", detail: `duplicate_url:${cu.host}` }); noProgress++; }
    else if ((hostFail.get(cu.host) ?? 0) >= L.maxConsecutiveFailuresPerHost) { history.push({ key, host: cu.host, outcome: "blocked", at: args.tools.now().toISOString(), progress: false }); trace.push({ turn, kind: "fetch", detail: `host_given_up:${cu.host}` }); noProgress++; }
    else if (fetches >= L.maxFetches) { end = "limit_fetches"; break; }
    else {
      fetches++;
      const r = await args.tools.fetchPage(url);
      const at = args.tools.now().toISOString();
      if (!r.ok) {
        hostFail.set(cu.host, (hostFail.get(cu.host) ?? 0) + 1);
        history.push({ key, host: cu.host, outcome: r.reason, at, progress: false });
        trace.push({ turn, kind: "fetch", detail: `failed:${r.reason}:${cu.host}` });
        noProgress++;
      } else {
        hostFail.set(cu.host, 0);
        const hash = sha(r.text);
        if (evidence.some((e) => e.contentHash === hash)) {
          history.push({ key, host: cu.host, outcome: "duplicate_content", contentHash: hash, at, progress: false });
          trace.push({ turn, kind: "fetch", detail: `duplicate_content:${cu.host}` });
          noProgress++;
        } else {
          const pe = pageEvidence(evidence.length, url, r, args.tools.now());
          const sc = args.scoper?.(url, pe);
          if (sc) pe.scope = sc;
          evidence.push(pe);
          history.push({ key, host: cu.host, outcome: "ok", contentHash: hash, at, progress: true });
          trace.push({ turn, kind: "fetch", detail: `ok:${cu.host}` });
          noProgress = 0;
        }
      }
    }
    if (noProgress >= L.maxNoProgressTurns) { end = "no_progress"; break; }
  }

  // ---- 登録判断（調査終了とは独立。AIが判断し、検証層が安全を確認する）
  let output: JudgeOutput | null = null;
  let verified = false;
  let held: { reasons: string[] } | null = null;
  let proposals: FieldProposal[] = [];
  let issues: string[] | undefined;
  const quoteAudit: ResearchResult["quoteAudit"] = [];
  for (let rev = 0; rev <= L.maxRevisions; rev++) {
    const js = args.budget.start("registration_judge", L.judgeReserveJpy);
    if (!js.ok) { held = { reasons: [`budget_${js.reason}`] }; trace.push({ turn, kind: "judge", detail: `no_budget:${js.reason}` }); break; }
    try {
      output = await args.judge({ caseId: args.caseId, evidence: evidence.map(toAgentView), lastTurn, investigationEnd: end ?? "no_action", protectedFields, verificationIssues: issues });
    } catch {
      output = null; // 例外でも予約額を計上して解放し、実行不可として扱う
    }
    js.finish(output?.costJpy ?? null);
    if (!output) { held = { reasons: ["judge_failed"] }; trace.push({ turn, kind: "judge", detail: "judge_failed" }); break; }
    trace.push({ turn, kind: "judge", detail: `decision:${output.decision}` });
    quoteAudit.push({ round: rev, rows: auditQuotes(output, evidence) });
    const v = verifyRegistration({ output, evidence, protectedFields });
    proposals = v.proposals;
    if (v.issues.length === 0) { verified = true; held = null; break; }
    trace.push({ turn, kind: "verify", detail: v.issues.join(",") });
    issues = v.issues;
    held = { reasons: v.issues }; // 限定的な再評価でも解消しなければ、実行不可として理由を残す（別の結論に置き換えない）
  }
  const decision = output ? output.decision : "none";
  const monitoring: ResearchResult["monitoring"] = output ? { state: output.monitor.continue ? "active" : "ended", why: output.monitor.why, reopenOn: output.monitor.continue ? ["new_official_url", "page_updated", "user_correction", "deadline_approaching"] : ["user_correction"] } : { state: "active", why: "登録判断が得られなかったため、監視は継続", reopenOn: ["new_official_url", "page_updated", "user_correction", "deadline_approaching"] };
  return { investigation: { state: "ended", reason: end ?? "no_action", turns: turn }, quoteAudit, registration: { decision, output, verified, held, proposals: verified ? proposals : [] }, monitoring, evidence, history, trace, budget: args.budget.summary(), searches: searchLog };
}

// ------------------------------------------------------------------ 再開（調査終了後の必要な部分だけの再評価）
export type ReopenTrigger = "new_official_url" | "page_updated" | "user_correction" | "deadline_approaching";
export interface ReopenState {
  monitoringEnded: boolean;
  /** 締切接近を契機にした再取得を最後に行った時刻（際限なく取り直さないため） */
  lastDeadlineRefetchAt: string | null;
  history: FetchRecord[];
}
export const DEADLINE_REFETCH_MIN_INTERVAL_MS = 12 * 60 * 60 * 1000;

/**
 * 再評価の要否と対象を決める（固定の抑止だけ。意味判断はAI）。
 *  - new_official_url: 未取得のURLだけ。page_updated: 更新が検出されたURLだけ。user_correction: 取得不要（人の訂正を保護して再評価）。
 *  - deadline_approaching: **単独では同じページを際限なく取り直さない**。前回から一定時間が空き、未取得・失敗のURLがあるときだけ。
 *  - 監視を終えた案件は、人の訂正のときだけ再開できる。
 */
export function planReopen(a: { trigger: ReopenTrigger; urls: string[]; state: ReopenState; now: Date }): { allowed: boolean; reason: string; refetch: string[] } {
  const okKeys = new Set(a.state.history.filter((h) => h.outcome === "ok").map((h) => h.key));
  if (a.trigger === "user_correction") return { allowed: true, reason: "user_correction", refetch: [] };
  if (a.state.monitoringEnded) return { allowed: false, reason: "monitoring_ended", refetch: [] };
  if (a.trigger === "new_official_url") {
    const t = [...new Set(a.urls)].filter((u) => !okKeys.has(canonUrl(u).key));
    return t.length ? { allowed: true, reason: "new_official_url", refetch: t } : { allowed: false, reason: "already_fetched", refetch: [] };
  }
  if (a.trigger === "page_updated") return a.urls.length ? { allowed: true, reason: "page_updated", refetch: [...new Set(a.urls)] } : { allowed: false, reason: "no_changed_url", refetch: [] };
  const last = a.state.lastDeadlineRefetchAt ? Date.parse(a.state.lastDeadlineRefetchAt) : 0;
  if (a.now.getTime() - last < DEADLINE_REFETCH_MIN_INTERVAL_MS) return { allowed: false, reason: "deadline_refetch_too_soon", refetch: [] };
  const t = [...new Set(a.urls)].filter((u) => !okKeys.has(canonUrl(u).key));
  return t.length ? { allowed: true, reason: "deadline_approaching_unfetched", refetch: t } : { allowed: false, reason: "no_new_signal", refetch: [] };
}
