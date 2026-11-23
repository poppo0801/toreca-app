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
import { evidenceFromLastGood, MAX_LINKED_PAGE_CHARS } from "@/lib/collector/evidence";
import { canonUrl } from "@/lib/judgment/xsource/normalize";
import { itemFingerprint, proposalKey, toProposalRecords, type ProposalMode, type ProposalRecord } from "@/lib/judgment/xsource/proposal";
import { mockRegistrationJudge, mockResearchAgent } from "@/lib/judgment/xsource/proposal-mock";
import type { FetchOutcome, RegistrationJudge, ResearchAgent, ResearchLimits, ResearchTools } from "@/lib/judgment/xsource/research-loop";
import { runXPostReplay, type StoredXPost } from "@/lib/judgment/xsource/x-origin";
import type { Db } from "@/lib/server/lottery-service";
import { proposalPreviewEnabled } from "./flag";
import { isRealRunTicket, type RealRunTicket } from "./real-gate";
import { coverageStatsOf, documentFromEvidence, loadBestDocument, saveCoverageStats, saveDocuments, type StoredDocument } from "./evidence-store";
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
/**
 * 収集時に保存された、本文以外の文脈（切り詰め・画像）を、AIへ渡す注記にする。観察としてのみ渡し、引用の根拠にはしない。
 * - 本文が上限で切られている: 末尾の項目・条件が欠けている（「無い」ではなく未確認）
 * - 画像: 収集時のAIが画像から読み取った情報（原本と未照合）。画像そのものはここでは提示されない＝画像の内容は一部または全部が未確認
 */
export const NOTE_TRUNCATED = "この投稿の本文は収集時の保存で上限に切り詰められており、末尾の項目・条件は確認できない";
export const NOTE_IMAGE_UNREAD = "投稿に画像があるが、収集時に画像から読み取れた内容が保存されていない（画像の内容は未確認）";
export function contextNotes(e: NonNullable<ReturnType<typeof evidenceFromLastGood>>): string[] {
  const notes: string[] = [];
  if (e.truncated) notes.push(NOTE_TRUNCATED);
  const readings = e.imageReadings ?? [];
  if (readings.length) {
    notes.push(`収集時のAIが画像から読み取った情報（原本と未照合。画像${e.imageCount ?? "?"}枚のうち一部のみの可能性）: ${readings.slice(0, 12).map((r) => `${r.field}=${r.text.slice(0, 80)}`).join(" / ")}`);
  } else if ((e.imageCount ?? 0) > 0) notes.push(NOTE_IMAGE_UNREAD);
  return notes;
}

export function postFromCandidate(c: CandidateRow): StoredXPost | null {
  const e = evidenceFromLastGood(c.last_good);
  if (!e) return null;
  return { postId: (c.x_post_id ?? e.hash).slice(0, 40), text: e.text, links: e.links ?? [], ...(e.linkMap?.length ? { linkMap: e.linkMap } : {}), recordedAt: e.fetchedAt, ...(contextNotes(e).length ? { notes: contextNotes(e) } : {}) };
}

/** 保存済みの全文（整形後）から取得結果を作る。HTMLは保存しないため、本文と構造化の観察をそのまま使う */
const fromDocument = (d: StoredDocument): FetchOutcome => ({ ok: true, finalUrl: d.url, html: "", text: d.text, cleaned: true, structure: d.structure, ...(d.textLoss?.length ? { textLoss: d.textLoss } : {}), ...(d.truncated ? { notice: `保存済みの本文も切り詰められている（${d.truncatedReason ?? "上限"}）。後半は確認できない` } : {}) });

const escapeHtml = (s: string): string => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** 失敗の分類（内容・機密を含めない）。無言で握りつぶさず、呼び出し側が記録できる */
export type FailReason = "disabled" | "no_evidence" | "run_failed" | "real_not_permitted" | "no_budget" | "save_failed";
export type GenerateResult = { ok: true; records: ProposalRecord[]; save: SaveSummary; storage: { documents: { saved: number; existing: number; failed: number }; stats: { saved: number; failed: number } }; stopped: boolean; costJpy: number } | { ok: false; reason: FailReason };

type Loose = { from: (n: string) => any }; // eslint-disable-line @typescript-eslint/no-explicit-any

/** 人の修正（項目ごと）と、レビューした版の項目の識別（見出し・本文の識別子）。適用先の照合に使う */
export interface HumanCorrection {
  /** レビューした時点の項目番号（項目の識別子が無い古い版の照合と、「この番号の項目に修正があった」の判定に使う） */
  itemNo: number;
  values: Record<string, string>;
  label: string | null;
  fingerprint: string | null;
}
/**
 * 人の修正が、いまの項目と同じ項目のものか。項目番号は再収集・並び替えで別の項目を指すことがあるため、識別子（見出し＋本文由来）が両方にあれば一致を必須にする。
 * 識別子が無い古い版は見出しで照合する（見出しだけでは同じ見出し内の入れ替わりを区別できないため、従来より厳しくはならない）。どちらも照合できなければ適用しない。
 */
export function correctionMatches(c: HumanCorrection, plan: { groupLabel: string; itemText: string }): boolean {
  if (c.fingerprint) return c.fingerprint === itemFingerprint(plan);
  return c.label !== null && c.label === plan.groupLabel.slice(0, 120);
}
/** いまの項目に適用する人の修正を探す。識別子が一致する修正は、項目番号が変わっていても項目に付いて移る。識別子の無い古い版は同じ番号で見出しが一致するときだけ */
export function findCorrection(list: readonly HumanCorrection[], itemNo: number, plan: { groupLabel: string; itemText: string }): HumanCorrection | undefined {
  const fp = itemFingerprint(plan);
  return list.find((c) => c.fingerprint === fp && c.itemNo === itemNo) ?? list.find((c) => c.fingerprint === fp) ?? list.find((c) => !c.fingerprint && c.itemNo === itemNo && correctionMatches(c, plan));
}
/** この番号の項目に以前の修正があるが、どの修正もいまの項目と一致しない（項目が変わった）。人の再確認が必要 */
export function correctionUnmatched(list: readonly HumanCorrection[], itemNo: number, plan: { groupLabel: string; itemText: string }): boolean {
  return list.some((c) => c.itemNo === itemNo) && !findCorrection(list, itemNo, plan);
}

/** 候補の各項目について、最新の人のレビューの修正を「人が確定した値」として読む（AIが上書きしない）。却下・保留は値を持たない */
export async function loadHumanCorrections(db: Db, householdId: string, candidateId: string, postId: string): Promise<HumanCorrection[]> {
  const keys = new Map<string, number>();
  for (let i = 1; i <= 60; i++) keys.set(proposalKey(candidateId, postId, i), i);
  const out: HumanCorrection[] = [];
  const r = (await (db as unknown as Loose).from("registration_proposal_reviews").select("proposal_key,proposal_id,decision,edits,created_at").eq("household_id", householdId).in("proposal_key", [...keys.keys()]).order("created_at", { ascending: false })) as { data: { proposal_key: string; proposal_id: string; decision: string; edits: Record<string, string> }[] | null };
  const seen = new Set<string>();
  for (const x of r.data ?? []) {
    if (seen.has(x.proposal_key)) continue; // 最新のレビューだけ
    seen.add(x.proposal_key);
    if (x.decision !== "approve_with_edits") continue;
    const vals = Object.fromEntries(Object.entries(x.edits ?? {}).filter(([, v]) => typeof v === "string" && v.trim()));
    if (!Object.keys(vals).length) continue;
    // レビューした版の項目の見出し（店舗など）。再収集で項目の並びが変わっても、別の項目へ人の修正を移さないための照合に使う
    const row = (await (db as unknown as Loose).from("registration_proposals").select("item_label,item_fingerprint").eq("household_id", householdId).eq("id", x.proposal_id).maybeSingle()) as { data: { item_label: string; item_fingerprint: string | null } | null };
    out.push({ itemNo: keys.get(x.proposal_key)!, values: vals, label: row.data ? row.data.item_label : null, fingerprint: row.data?.item_fingerprint ?? null });
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
      // 順序: ①収集時の保存本文（上限に達していなければ全文）②最新の取得（許可されている場合）③以前に保存した全文（evidence_documents）④切り詰められた収集時の本文（切り詰めを明示）
      const hit = linked.get(canonUrl(u).key);
      const truncated = !!hit && hit.text.length >= MAX_LINKED_PAGE_CHARS;
      if (hit && !truncated) return { ok: true, finalUrl: hit.url, html: `<html><body>${escapeHtml(hit.text)}</body></html>`, text: hit.text }; // 収集時に保存した公開ページ本文の再生（外部アクセスなし）
      if (deps.liveFetch) {
        const live = await deps.liveFetch(u).catch(() => null);
        if (live && live.ok) return live;
        if (!hit && live) {
          const doc = await loadBestDocument(a.db, a.householdId, a.candidate.id, u);
          if (doc) return fromDocument(doc);
          return live;
        }
      }
      const doc = await loadBestDocument(a.db, a.householdId, a.candidate.id, u);
      if (doc && (!hit || doc.textChars > hit.text.length)) return fromDocument(doc);
      if (hit) {
        // 収集時の保存は先頭 MAX_LINKED_PAGE_CHARS 字で切り詰められる。後半は確認できない事実を観察に明示し、AIが「無い」と読まないようにする
        const notice = `この本文は収集時の保存で先頭${MAX_LINKED_PAGE_CHARS}字に切り詰められており、後半は確認できない（無いのではなく未確認）`;
        return { ok: true, finalUrl: hit.url, html: `<html><body>${escapeHtml(hit.text)}</body></html>`, text: hit.text, notice };
      }
      return { ok: false, reason: "not_public" };
    },
  };
  try {
    const budget = deps.budget ?? new CallBudget({ maxCalls: 40, maxCostJpy: 0.0001 }); // mock/replay: 費用ゼロ（予約0）
    const limits = deps.limits ?? { agentReserveJpy: 0, judgeReserveJpy: 0, searchReserveJpy: 0, maxSearches: 0, maxTurns: 3, maxFetches: 3 };
    const corrections = await loadHumanCorrections(a.db, a.householdId, a.candidate.id, post.postId).catch(() => [] as HumanCorrection[]);
    const before = budget.costJpy;
    // 人の修正は、レビューした項目と今の項目の見出しが一致するときだけ適用する（項目番号だけで当てると、並びが変わったとき別の店舗へ移る）
    const protectedFor = (n: number, plan: { groupLabel: string; itemText: string }): Record<string, string> | undefined => {
      return findCorrection(corrections, n, plan)?.values;
    };
    const correctionSkipped = (n: number, plan: { groupLabel: string; itemText: string }): boolean => {
      return correctionUnmatched(corrections, n, plan);
    };
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
      protectedFor,
      ...(deps.perItemCapJpy ? { budgetFor: () => new CaseBudget(budget, deps.perItemCapJpy!) } : {}),
    });
    const records = toProposalRecords({ candidateId: a.candidate.id, post, run, mode: deps.mode, modelId: deps.modelId, fetchedAt: stored?.fetchedAt ?? null, protectedFor, correctionSkipped });
    const save = a.persist === false ? { inserted: 0, unchanged: 0, superseded: 0, failed: 0 } : await saveProposals(a.db, a.householdId, records);
    if (save.failed > 0 && save.inserted === 0 && save.unchanged === 0) return { ok: false, reason: "save_failed" };
    // 取得した全文と、取得網羅性の計測を保存する（失敗しても登録案は失わない。失敗は件数で返す）
    const storage = { documents: { saved: 0, existing: 0, failed: 0 }, stats: { saved: 0, failed: 0 } };
    if (a.persist !== false) {
      const docs = run.results.flatMap(({ result }) => result.evidence.map((e) => documentFromEvidence(e, { collectorTruncatedAt: e.notice ? MAX_LINKED_PAGE_CHARS : undefined })).filter((d): d is StoredDocument => d !== null));
      storage.documents = await saveDocuments(a.db, a.householdId, a.candidate.id, docs);
      const stats = run.results.flatMap(({ plan, result }) => coverageStatsOf({ proposalKey: proposalKey(a.candidate.id, post.postId, plan.itemNo), result, mode: deps.mode, collectorLimit: MAX_LINKED_PAGE_CHARS }));
      storage.stats = await saveCoverageStats(a.db, a.householdId, stats);
    }
    return { ok: true, records, save, storage, stopped: run.stopped, costJpy: Math.round((budget.costJpy - before) * 10_000) / 10_000 };
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
