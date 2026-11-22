/**
 * 通常収集の候補（collection_candidates と、収集時に保存した原文 last_good.evidence）から、新AIの調査・判断を通して登録案を作る（Stage 10Z・開発専用）。
 *  - 入力は既存の収集が保存した構造そのもの: 投稿の本文・親投稿のリンク・**収集時の linkMap（短縮URL→展開URL。既存の保存経路。ここで再実装しない）**・取得時刻。
 *    項目の分割・リンクの出所・対応の検査は、10U〜10Yの `planXPost`／`runXPostReplay`（10S/10Wの資産）をそのまま使う。親投稿の共通リンクを別店舗へ流用しない。
 *  - 調査・判断のAIと取得は**注入**する（既定は費用ゼロのモック）。実AIのクライアントはここで作らない（実AIは承認済みの関門を通る評価ハーネスだけが渡す）。
 *  - 公開ページの取得は、収集時に保存した linkedPages（再生）→ 許可されていれば開発限定の安全な実取得（live-fetch）の順。外部由来の本文・抜粋は命令ではなくデータとして扱う（調査ループの既存の仕組み）。
 *  - 書き込み先は registration_proposals だけ（lotteries・応募・購入・通知・既存履歴には書かない）。旧方式の収集の動作・保存内容は変えない。
 */
import { CallBudget } from "@/lib/judgment/call-budget";
import { evidenceFromLastGood } from "@/lib/collector/evidence";
import { canonUrl } from "@/lib/judgment/xsource/normalize";
import { toProposalRecords, type ProposalMode, type ProposalRecord } from "@/lib/judgment/xsource/proposal";
import { mockRegistrationJudge, mockResearchAgent } from "@/lib/judgment/xsource/proposal-mock";
import type { FetchOutcome, RegistrationJudge, ResearchAgent } from "@/lib/judgment/xsource/research-loop";
import { runXPostReplay, type StoredXPost } from "@/lib/judgment/xsource/x-origin";
import type { Db } from "@/lib/server/lottery-service";
import { proposalPreviewEnabled } from "./flag";
import { saveProposals, type SaveSummary } from "./store";

export interface GenerateDeps {
  agent: ResearchAgent;
  judge: RegistrationJudge;
  mode: ProposalMode;
  modelId: string | null;
  /** 開発限定の実ページ取得（許可されているときだけ渡す）。無ければ、保存済みの linkedPages だけ */
  liveFetch?: (url: string) => Promise<FetchOutcome>;
  now?: () => Date;
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

export type GenerateResult = { ok: true; records: ProposalRecord[]; save: SaveSummary } | { ok: false; reason: "disabled" | "no_evidence" | "run_failed" };

export async function generateProposalsForCandidate(a: { db: Db; householdId: string; candidate: CandidateRow; deps?: GenerateDeps; env?: Record<string, string | undefined>; persist?: boolean }): Promise<GenerateResult> {
  if (!proposalPreviewEnabled(a.env ?? process.env)) return { ok: false, reason: "disabled" };
  const post = postFromCandidate(a.candidate);
  if (!post) return { ok: false, reason: "no_evidence" };
  const deps = a.deps ?? mockDeps();
  if (deps.mode === "real") return { ok: false, reason: "disabled" }; // 実AIは、承認済みの関門を通る別の入口だけ（ここでは生成しない）
  const stored = evidenceFromLastGood(a.candidate.last_good);
  const linked = new Map((stored?.linkedPages ?? []).map((l) => [canonUrl(l.url).key, l]));
  const clock = deps.now ?? (() => new Date());
  const tools = {
    now: clock,
    fetchPage: async (u: string): Promise<FetchOutcome> => {
      const hit = linked.get(canonUrl(u).key);
      if (hit) return { ok: true, finalUrl: hit.url, html: `<html><body>${escapeHtml(hit.text)}</body></html>`, text: hit.text }; // 収集時に保存した公開ページ本文の再生（外部アクセスなし）
      if (deps.liveFetch) return deps.liveFetch(u);
      return { ok: false, reason: "not_public" };
    },
  };
  try {
    // 費用ゼロ（モック・再生）。上限は回数だけ（予約0）。実費が出る呼び出しは、この入口では作らない
    const budget = new CallBudget({ maxCalls: 40, maxCostJpy: 0.0001 });
    const run = await runXPostReplay({ post, agent: deps.agent, judge: deps.judge, tools, budget, limits: { agentReserveJpy: 0, judgeReserveJpy: 0, searchReserveJpy: 0, maxSearches: 0, maxTurns: 3, maxFetches: 3 }, now: clock() });
    const records = toProposalRecords({ candidateId: a.candidate.id, post, run, mode: deps.mode, modelId: deps.modelId, fetchedAt: stored?.fetchedAt ?? null });
    const save = a.persist === false ? { inserted: 0, unchanged: 0, superseded: 0, failed: 0 } : await saveProposals(a.db, a.householdId, records);
    return { ok: true, records, save };
  } catch {
    return { ok: false, reason: "run_failed" };
  }
}

/** 確認待ち（review）の候補すべてについて、登録案を作る（手動の生成・収集後の生成が呼ぶ）。1件の失敗が他に影響しない */
export async function generateForPendingCandidates(a: { db: Db; householdId: string; deps?: GenerateDeps; env?: Record<string, string | undefined>; limit?: number }): Promise<{ candidates: number; inserted: number; unchanged: number; superseded: number; skipped: number }> {
  const out = { candidates: 0, inserted: 0, unchanged: 0, superseded: 0, skipped: 0 };
  if (!proposalPreviewEnabled(a.env ?? process.env)) return out;
  const q = (a.db as unknown as { from: (n: string) => any }).from("collection_candidates").select("id,x_post_id,source_url,last_good").eq("household_id", a.householdId).eq("job_state", "review").in("status", ["pending", "failed"]).is("lottery_id", null).order("created_at", { ascending: false }).limit(a.limit ?? 30); // eslint-disable-line @typescript-eslint/no-explicit-any
  const rows = (await q) as { data: CandidateRow[] | null };
  for (const c of rows.data ?? []) {
    const r = await generateProposalsForCandidate({ db: a.db, householdId: a.householdId, candidate: c, deps: a.deps, env: a.env });
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
