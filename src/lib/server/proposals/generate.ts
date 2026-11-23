/**
 * 通常収集の候補（collection_candidates と、収集時に保存した原文 last_good.evidence）から、新AIの調査・判断を通して登録案を作る（開発専用）。
 *  - 入力は既存の収集が保存した構造そのもの: 投稿の本文・親投稿のリンク・**収集時の linkMap（短縮URL→展開URL。既存の保存経路。ここで再実装しない）**・取得時刻。
 *    項目の分割・リンクの出所・対応の検査は、10U〜10Yの `planXPost`／`runXPostReplay`（10S/10Wの資産）をそのまま使う。親投稿の共通リンクを別店舗へ流用しない。
 *  - 調査・判断のAIと取得は**注入**する（既定は費用ゼロのモック）。**実AIのクライアントはここで作らない**。mode=real は、承認済みの関門を通った評価入口だけが発行する許可証（real-gate.ts）がある場合だけ生成する。
 *  - 公開ページの取得は、収集時に保存した linkedPages（再生）→ 許可されていれば開発限定の安全な実取得（live-fetch）の順。外部由来の本文・抜粋は命令ではなくデータとして扱う（調査ループの既存の仕組み）。
 *  - 人のレビュー（修正）は、再評価のとき「人が確定した値」として調査・判断の入力に渡す（AIは変更できない。食い違いは人への確認）。**保存した人の判断を再利用するだけで、モデルが学習したのではない**。
 *  - 書き込み先は registration_proposals だけ（lotteries・応募・購入・通知・履歴には書かない）。旧方式の収集の動作・保存内容は変えない。
 *  - 協調的な中止（shouldStop）・失敗の分類（reason。内容・機密を含めない）・費用の予約/計上（呼び出し側が渡す CallBudget）に対応する。
 */
import { CallBudget, CaseBudget } from "@/lib/judgment/call-budget";
import { evidenceFromLastGood } from "@/lib/collector/evidence";
import { canonUrl } from "@/lib/judgment/xsource/normalize";
import { proposalKey, toProposalRecords, type ProposalMode, type ProposalRecord } from "@/lib/judgment/xsource/proposal";
import { mockRegistrationJudge, mockResearchAgent } from "@/lib/judgment/xsource/proposal-mock";
import type { FetchOutcome, RegistrationJudge, ResearchAgent, ResearchLimits, ResearchTools } from "@/lib/judgment/xsource/research-loop";
import { runXPostReplay, type StoredXPost } from "@/lib/judgment/xsource/x-origin";
import type { Db } from "@/lib/server/lottery-service";
import { proposalPreviewEnabled } from "./flag";
import { isRealRunTicket, type RealRunTicket } from "./real-gate";
import { saveProposals, type SaveSummary } from "./store";

export interface GenerateDeps {
  agent: ResearchAgent;
  judge: RegistrationJudge;
  mode: ProposalMode;
  modelId: string | null;
  /** 開発限定の実ページ取得（許可されているときだけ渡す）。無ければ、保存済みの linkedPages だけ */
  liveFetch?: (url: string) => Promise<FetchOutcome>;
  now?: () => Date;
  /** 実AI（mode=real）の許可証。承認済みの関門を通った評価入口だけが発行する。無ければ real は生成しない */
  ticket?: RealRunTicket;
  /** 読み取り専用の検索ツール（実AIの評価入口だけが渡す。無ければ検索しない） */
  search?: ResearchTools["search"];
  /** 調査の上限。mock/replay の既定は予約0・検索なし。real は評価入口が決める */
  limits?: Partial<ResearchLimits>;
  /** 全体の予算と、項目ごとの上限（円）。real では必須（予算なしの実AIは実行しない） */
  budget?: CallBudget;
  perItemCapJpy?: number;
  /** 協調的な中止（true で、以降の項目を処理しない） */
  shouldStop?: () => boolean;
}

/** 費用ゼロのモード（既定）。実AIではない */
export const mockDeps = (extra: Partial<GenerateDeps> = {}): GenerateDeps => ({ agent: mockResearchAgent, judge: mockRegistrationJudge, mode: "mock", modelId: null, ...extra });

export interface CandidateRow {
  id: string;
  x_post_id?: string | null;
  source_url?: string | null;
  last_good?: unknown;
}

/** 保存済みの原文（StoredEvidence）を、新AIの入力（保存済みの公開投稿）へ。収集時の linkMap をそのまま渡す */
export function postFromCandidate(c: CandidateRow): StoredXPost | null {
  const e = evidenceFromLastGood(c.last_good);
  if (!e) return null;
  return { postId: (c.x_post_id ?? e.hash).slice(0, 40), text: e.text, links: e.links ?? [], ...(e.linkMap?.length ? { linkMap: e.linkMap } : {}), recordedAt: e.fetchedAt };
}

const escapeHtml = (s: string): string => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** 失敗の分類（内容・機密を含めない）。無言で握りつぶさず、呼び出し側が記録できる */
export type FailReason = "disabled" | "no_evidence" | "run_failed" | "real_not_permitted" | "no_budget" | "save_failed";
export type GenerateResult = { ok: true; records: ProposalRecord[]; save: SaveSummary; stopped: boolean; costJpy: number } | { ok: false; reason: FailReason };

type Loose = { from: (n: string) => any }; // eslint-disable-line @typescript-eslint/no-explicit-any

/** 候補の各項目について、最新の人のレビューの修正を「人が確定した値」として読む（AIが上書きしない）。却下・保留は値を持たない */
export async function loadHumanCorrections(db: Db, householdId: string, candidateId: string, postId: string): Promise<Map<number, Record<string, string>>> {
  const keys = new Map<string, number>();
  for (let i = 1; i <= 30; i++) keys.set(proposalKey(candidateId, postId, i), i);
  const out = new Map<number, Record<string, string>>();
  const r = (await (db as unknown as Loose).from("registration_proposal_reviews").select("proposal_key,decision,edits,created_at").eq("household_id", householdId).in("proposal_key", [...keys.keys()]).order("created_at", { ascending: false })) as { data: { proposal_key: string; decision: string; edits: Record<string, string> }[] | null };
  const seen = new Set<string>();
  for (const x of r.data ?? []) {
    if (seen.has(x.proposal_key)) continue; // 最新のレビューだけ
    seen.add(x.proposal_key);
    if (x.decision !== "approve_with_edits") continue;
    const vals = Object.fromEntries(Object.entries(x.edits ?? {}).filter(([, v]) => typeof v === "string" && v.trim()));
    if (Object.keys(vals).length) out.set(keys.get(x.proposal_key)!, vals);
  }
  return out;
}

export async function generateProposalsForCandidate(a: { db: Db; householdId: string; candidate: CandidateRow; deps?: GenerateDeps; env?: Record<string, string | undefined>; persist?: boolean }): Promise<GenerateResult> {
  const env = a.env ?? process.env;
  if (!proposalPreviewEnabled(env)) return { ok: false, reason: "disabled" };
  const post = postFromCandidate(a.candidate);
  if (!post) return { ok: false, reason: "no_evidence" };
  const deps = a.deps ?? mockDeps();
  const real = deps.mode === "real";
  if (real && !isRealRunTicket(deps.ticket)) return { ok: false, reason: "real_not_permitted" }; // 実AIは、承認済みの関門を通った評価入口の許可証がある場合だけ
  if (real && !deps.budget) return { ok: false, reason: "no_budget" }; // 予算なしの実AIは実行しない
  const stored = evidenceFromLastGood(a.candidate.last_good);
  const linked = new Map((stored?.linkedPages ?? []).map((l) => [canonUrl(l.url).key, l]));
  const clock = deps.now ?? (() => new Date());
  const tools: ResearchTools = {
    now: clock,
    ...(deps.search ? { search: deps.search } : {}),
    fetchPage: async (u: string): Promise<FetchOutcome> => {
      const hit = linked.get(canonUrl(u).key);
      if (hit) return { ok: true, finalUrl: hit.url, html: `<html><body>${escapeHtml(hit.text)}</body></html>`, text: hit.text }; // 収集時に保存した公開ページ本文の再生（外部アクセスなし）
      if (deps.liveFetch) return deps.liveFetch(u);
      return { ok: false, reason: "not_public" };
    },
  };
  try {
    const budget = deps.budget ?? new CallBudget({ maxCalls: 40, maxCostJpy: 0.0001 }); // mock/replay: 費用ゼロ（予約0）
    const limits = deps.limits ?? { agentReserveJpy: 0, judgeReserveJpy: 0, searchReserveJpy: 0, maxSearches: 0, maxTurns: 3, maxFetches: 3 };
    const corrections = await loadHumanCorrections(a.db, a.householdId, a.candidate.id, post.postId).catch(() => new Map<number, Record<string, string>>());
    const before = budget.costJpy;
    const run = await runXPostReplay({
      post,
      agent: deps.agent,
      judge: deps.judge,
      tools,
      budget,
      limits,
      now: clock(),
      shouldStop: deps.shouldStop,
      registerRequiresUnit: true,
      protectedFor: (n) => corrections.get(n),
      ...(deps.perItemCapJpy ? { budgetFor: () => new CaseBudget(budget, deps.perItemCapJpy!) } : {}),
    });
    const records = toProposalRecords({ candidateId: a.candidate.id, post, run, mode: deps.mode, modelId: deps.modelId, fetchedAt: stored?.fetchedAt ?? null, protectedFor: (n) => corrections.get(n) });
    const save = a.persist === false ? { inserted: 0, unchanged: 0, superseded: 0, failed: 0 } : await saveProposals(a.db, a.householdId, records);
    if (save.failed > 0 && save.inserted === 0 && save.unchanged === 0) return { ok: false, reason: "save_failed" };
    return { ok: true, records, save, stopped: run.stopped, costJpy: Math.round((budget.costJpy - before) * 10_000) / 10_000 };
  } catch {
    return { ok: false, reason: "run_failed" };
  }
}

/** 確認待ち（review）の候補すべてについて、登録案を作る（手動の生成が呼ぶ。モックのみ）。1件の失敗が他に影響しない */
export async function generateForPendingCandidates(a: { db: Db; householdId: string; deps?: GenerateDeps; env?: Record<string, string | undefined>; limit?: number }): Promise<{ candidates: number; inserted: number; unchanged: number; superseded: number; skipped: number }> {
  const out = { candidates: 0, inserted: 0, unchanged: 0, superseded: 0, skipped: 0 };
  if (!proposalPreviewEnabled(a.env ?? process.env)) return out;
  const deps = a.deps ?? mockDeps();
  if (deps.mode === "real") return out; // 画面・server action からは実AIを生成しない（評価入口だけ）
  const q = (a.db as unknown as Loose).from("collection_candidates").select("id,x_post_id,source_url,last_good").eq("household_id", a.householdId).eq("job_state", "review").in("status", ["pending", "failed"]).is("lottery_id", null).order("created_at", { ascending: false }).limit(a.limit ?? 30);
  const rows = (await q) as { data: CandidateRow[] | null };
  for (const c of rows.data ?? []) {
    const r = await generateProposalsForCandidate({ db: a.db, householdId: a.householdId, candidate: c, deps, env: a.env });
    out.candidates++;
    if (!r.ok) out.skipped++;
    else {
      out.inserted += r.save.inserted;
      out.unchanged += r.save.unchanged;
      out.superseded += r.save.superseded;
    }
  }
  return out;
}
