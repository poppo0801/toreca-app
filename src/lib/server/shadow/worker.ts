/**
 * 本番シャドー用の非同期ワーカー（Stage 10K）。通常収集とは**別の関数**（専用cron）で、キュー（shadow_jobs）から少数のジョブを確保し、
 * 保存済みの原文で新AI判断を実行して、**非機微の要約だけ**を追記専用の記録（shadow_judgments）に残す。
 *  - 書き込み先は shadow_* の3表だけ。旧方式の表（抽選・候補・応募・当選・購入・通知・マスター）には一切書かない（読むのは候補の原文・登録値のみ）。
 *  - 実行条件: 独立した許可（allow.ts）・DB設定 enabled・モデル（シャドー専用キー）がすべて揃うこと。どれかが欠ければ何もしない（ジョブも確保しない）。
 *  - 緊急停止: 各ジョブのAI呼び出しの**直前**に DB設定を読み直す。enabled=false ならそのジョブは確保を解除して戻し、呼び出さない（再デプロイ不要）。
 *  - 予算: 世帯ごとの日次・月次（日本時間）・1件の上限。事前予約（見込み費用が残額を超えるなら呼ばない）。上限に達したジョブは次の日・月まで保留。
 *  - 冪等・再試行: リースで二重処理を防ぐ（期限切れは別ワーカーが引き継ぐ）。失敗は指数バックオフで再試行し、試行上限で failed。同じ原文は二重に判断しない（キューの一意制約）。
 *  - 機密: 送信前に伏せ字・秘密の実値の検査・公開告知の確認（input.ts）。通らなければ外部へ送らず skipped（理由コードのみ記録）。
 */
import { evidenceFromLastGood } from "@/lib/collector/evidence";
import { jobEvidenceRelation, jobHashDiff, shadowJobHash } from "@/lib/collector/shadow-hash";
import { prioritizeShadowQueue } from "./priority";
import { buildJudgmentInput } from "@/lib/judgment/build-input";
import type { JudgmentModel } from "@/lib/judgment/model";
import type { ShadowConfig } from "@/lib/judgment/shadow/config";
import { ShadowController } from "@/lib/judgment/shadow/controller";
import type { ShadowRecord, ShadowSink } from "@/lib/judgment/shadow/record";
import type { Db } from "@/lib/server/lottery-service";
import { CallBudget, withCallBudget } from "@/lib/judgment/call-budget";
import type { ListModel } from "@/lib/judgment/list-discovery";
import { shadowWorkerPermission } from "./allow";
import { runListJob } from "./list-job";
import type { ProposalJobResult, ProposalJobSettings } from "./proposal-job";
import { SHADOW_MAX_RESUMES } from "./proposal-job";
import type { CandidateRow } from "@/lib/server/proposals/generate";
import type { ImageReading } from "@/lib/collector/evidence";
import { imageEvidenceSeeds, summarizeChecks } from "@/lib/judgment/image-verify";
import { detectLeaks } from "@/lib/judgment/eval/phase2";
import type { ImageVerification } from "./image-verifier";
import { parseListItems } from "@/lib/judgment/list-items";
import { currentCaseFromDraft, focusEvidenceSeeds, legacySummaryFromDraft, prepareShadowEvidence } from "./input";

type Env = Record<string, string | undefined>;
interface Job {
  id: string;
  household_id: string;
  candidate_id: string;
  evidence_hash: string;
  attempts: number;
  max_attempts: number;
}
export interface ShadowSettingsRow {
  enabled: boolean;
  enqueue_enabled: boolean;
  daily_budget_jpy: number;
  monthly_budget_jpy: number;
  per_case_cap_jpy: number;
  max_jobs_per_run: number;
  retention_days: number;
  /** 試行期間の終了（過ぎるとジョブを確保しない。NULL=期限なし） */
  valid_until?: string | null;
  /** 通算の費用上限（円）と集計の開始日時（NULL=通算上限なし） */
  total_budget_jpy?: number | null;
  total_since?: string | null;
  /** 登録判断だけに使うモデル（NULL=調査と同じ）。比較・切り戻し用に、DBの設定で切り替える（env変更なし） */
  judge_model?: string | null;
  judge_mode?: string | null;
}

export interface ShadowWorkerDeps {
  /** サービス権限のDBクライアント（キュー・記録・候補の読み取り） */
  db: Db;
  /** 新AIのモデル（シャドー専用キー）。null なら何もしない */
  model: JudgmentModel | null;
  env?: Env;
  now?: () => Date;
  workerId: string;
  /** この実行で確保する最大件数 */
  limit?: number;
  /** この実行に使える時間（ミリ秒）。残りが1件分に満たなければ新しいジョブを始めない */
  timeBudgetMs?: number;
  perJobTimeoutMs?: number;
  /** Stage 10M: 一覧・まとめ投稿の全項目の判断モデル。未設定なら、一覧は従来の焦点（登録値に近い項目だけ）で処理する */
  listModel?: ListModel;
  /** Stage 10M: 実行全体のハードな呼び出し上限（回数・費用）。判断の再試行・再評価・画像の書き起こし・一覧の項目判断をすべて合算して数える。未設定なら制限なし（個別の予算のみ） */
  callBudget?: CallBudget;
  /** 一覧1件（親投稿）で使える最大の呼び出し回数（既定12） */
  maxCallsPerListJob?: number;
  /** Stage 10L: 画像根拠の検証（元画像の独立した書き起こしとの照合）。未設定なら画像読み取りは「照合できていない読み取り」のまま渡す */
  /**
   * Phase 3: 本番シャドーの登録案ジョブ（収集済みの候補から、新AIの調査・判断・検証を通した登録案を作り、registration_proposals だけに保存する）。
   * 渡されたときは、**このジョブが従来の判断・一覧処理の代わりに**候補1件を処理する（同じ候補に2つのAI費用を掛けない）。未設定なら従来どおり。
   * 本番の多重ゲート・費用の事前検査・停止は、ジョブ側（proposal-job.ts）とここのDB設定・予算で二重にかかる。
   */
  proposalJob?: (a: { householdId: string; candidate: CandidateRow; settings: ProposalJobSettings; spentTodayJpy: number; remainingJpy: number; /** AUTONOMY_RESTORATION（再開）: 1回の実行を安全に終えるべき時刻・同じジョブで完了した項目・同じジョブで使った費用 */ runDeadlineMs?: number; doneItems?: number[]; spentOnJobJpy?: number }) => Promise<ProposalJobResult>;
  imageVerify?: (a: { householdId: string; candidateId: string; readings: ImageReading[]; refs: string[]; budgetJpy: number }) => Promise<ImageVerification>;
}

export interface ShadowWorkerResult {
  stoppedBy: "not_allowed" | "no_model" | "no_jobs" | "time" | "completed" | "lease_error" | "provider_error" | "record_failed";
  notAllowedReason?: string;
  leased: number;
  done: number;
  skipped: number;
  requeued: number;
  failed: number;
  spentJpy: number;
  byStatus: Record<string, number>;
  byReason: Record<string, number>;
}

type RpcResult = { data: unknown; error: { message: string } | null };
type Rpc = (n: string, a?: Record<string, unknown>) => PromiseLike<RpcResult>;
const rpc = (db: Db): Rpc => (n, a) => (db as unknown as { rpc: Rpc }).rpc(n, a);
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const table = (db: Db, t: string): any => (db as unknown as { from: (t: string) => unknown }).from(t);

const H = 3_600_000;
/** 同じ候補の登録案を有料で作り直す最短の間隔（PRODUCTION_PARITY） */
export const REEVAL_MIN_INTERVAL_MS = 12 * H;
/** 意味のある更新（本文・素材の変化・締切が近い・人の修正）の再評価の最短間隔（EVIDENCE_UTILIZATION）。無制限には再評価しない */
export const REEVAL_URGENT_INTERVAL_MS = 2 * H;

/**
 * 前回の評価からの更新が、短い間隔で再評価する価値のあるものか（純関数）。理由のコード、または null（通常の12時間）。
 *  - content: 本文（正規化後）が変わった ／ material: 本文は同じでリンク先・画像が変わった（ハッシュは shadow-hash.ts）
 *  - deadline: 旧方式の締切が日本時間で2日以内 ／ human: 前回の評価のあとに人の確認・修正がある
 */
export function reevalUrgency(a: { lastHash: string; jobHash: string; deadline: string | null; reviewedAfter: boolean; now: Date }): "content" | "material" | "deadline" | "human" | null {
  if (a.reviewedAfter) return "human";
  if (a.deadline && /^\d{4}-\d{2}-\d{2}$/.test(a.deadline)) {
    const today = new Date(a.now.getTime() + 9 * H).toISOString().slice(0, 10);
    const left = (new Date(`${a.deadline}T00:00:00Z`).getTime() - new Date(`${today}T00:00:00Z`).getTime()) / (24 * H);
    if (left >= 0 && left <= 2) return "deadline";
  }
  // 旧形式（本文のハッシュそのもの）と新形式は素材を比べられないので、素材の変化とはみなさない
  return jobHashDiff(a.lastHash, a.jobHash);
}

async function humanReviewAfter(db: Db, householdId: string, candidateId: string, sinceIso: string): Promise<boolean> {
  try {
    const ps = await table(db, "registration_proposals").select("id").eq("household_id", householdId).eq("candidate_id", candidateId).limit(200);
    const ids = ((ps.data ?? []) as { id: string }[]).map((x) => x.id);
    if (!ids.length) return false;
    const r = await table(db, "registration_proposal_reviews").select("id").eq("household_id", householdId).in("proposal_id", ids).gt("created_at", sinceIso).limit(1);
    return ((r.data ?? []) as unknown[]).length > 0;
  } catch {
    return false;
  }
}
/** 日本時間の日・月の開始（UTCの時刻） */
export function jstDayStart(now: Date): Date {
  const j = new Date(now.getTime() + 9 * H);
  return new Date(Date.UTC(j.getUTCFullYear(), j.getUTCMonth(), j.getUTCDate()) - 9 * H);
}
export function jstMonthStart(now: Date): Date {
  const j = new Date(now.getTime() + 9 * H);
  return new Date(Date.UTC(j.getUTCFullYear(), j.getUTCMonth(), 1) - 9 * H);
}
const nextJstDay = (now: Date): Date => new Date(jstDayStart(now).getTime() + 24 * H + 5 * 60_000);
const nextJstMonth = (now: Date): Date => {
  const j = new Date(now.getTime() + 9 * H);
  return new Date(Date.UTC(j.getUTCFullYear(), j.getUTCMonth() + 1, 1) - 9 * H + 5 * 60_000);
};

export async function loadShadowSettings(db: Db, householdId: string): Promise<ShadowSettingsRow | null> {
  const { data } = await table(db, "shadow_settings").select("enabled,enqueue_enabled,daily_budget_jpy,monthly_budget_jpy,per_case_cap_jpy,max_jobs_per_run,retention_days,valid_until,total_budget_jpy,total_since,judge_model,judge_mode").eq("household_id", householdId).maybeSingle();
  if (!data) return null;
  return { ...data, daily_budget_jpy: Number(data.daily_budget_jpy), monthly_budget_jpy: Number(data.monthly_budget_jpy), per_case_cap_jpy: Number(data.per_case_cap_jpy), total_budget_jpy: data.total_budget_jpy === null || data.total_budget_jpy === undefined ? null : Number(data.total_budget_jpy) };
}

class CaptureSink implements ShadowSink {
  last: ShadowRecord | null = null;
  async write(r: ShadowRecord): Promise<void> {
    this.last = r;
  }
}

/**
 * 未確定費用の引当（円）。この実行で確保したジョブ以外で、開始した試行の数（attempts）が記録（shadow_judgments）の数を上回るぶん×1件上限。
 * 実行が途中で打ち切られた（Vercelの停止・クラッシュ）試行は、費用が記録されないことがあるため、記録が追いつくまでは使ったものとして扱う（過少計上で上限を超えない）。
 * 読み取りに失敗したら、保守的に1件上限ぶんを引く。
 */
async function unconfirmedReserveInner(db: Db, householdId: string, perCaseCapJpy: number, exceptJobIds: string[], sinceIso?: string): Promise<number> {
  // sinceIso: その時刻以降に更新されたジョブだけ（日次の残額の引当用。CAPABILITY_CEILING: 過去の日の未確定の試行を毎日の残額から引き続け、シャドーが止まっていた）
  let q = table(db, "shadow_jobs").select("id,attempts,status,lease_until").eq("household_id", householdId).gt("attempts", 0).in("status", ["queued", "leased", "failed", "done"]);
  // 予算で戻しただけのジョブ（AIを呼んでいない。戻すと updated_at が今日になる）の以前の未確定の試行は、日次には数えない（月次・通算では数える）
  if (sinceIso) q = q.gte("updated_at", sinceIso).or("last_error.is.null,last_error.not.in.(budget,budget_locked)");
  const jobs = await q.limit(500);
  const rec = await table(db, "shadow_judgments").select("job_id").eq("household_id", householdId).not("job_id", "is", null).limit(2000);
  if (jobs.error || rec.error) return perCaseCapJpy;
  const recorded = new Map<string, number>();
  for (const r of (rec.data ?? []) as { job_id: string }[]) recorded.set(r.job_id, (recorded.get(r.job_id) ?? 0) + 1);
  let n = 0;
  const running = new Set(exceptJobIds);
  // この実行で確保したジョブは、いま実行中の試行（今回ぶん）を除いた「以前の試行」だけを数える
  const nowMs = Date.now();
  for (const j of (jobs.data ?? []) as { id: string; attempts: number; status: string; lease_until: string | null }[]) {
    // 別の実行が**いま**リース中のジョブ（期限内）は、その実行が完了時に費用を記録する（費用判断はロックで直列化済み）。引き当てるのは、期限が切れても記録がない＝打ち切られた試行だけ
    if (j.status === "leased" && j.lease_until && new Date(j.lease_until).getTime() > nowMs && !running.has(j.id)) continue;
    n += Math.max(0, j.attempts - (running.has(j.id) ? 1 : 0) - (recorded.get(j.id) ?? 0));
  }
  return Math.round(n * perCaseCapJpy * 100) / 100;
}
export async function unconfirmedReserveJpy(db: Db, householdId: string, perCaseCapJpy: number, exceptJobIds: string[], sinceIso?: string): Promise<number> {
  try {
    return await unconfirmedReserveInner(db, householdId, perCaseCapJpy, exceptJobIds, sinceIso);
  } catch {
    return perCaseCapJpy; // 読み取りの例外でも止めず、保守的に1件上限ぶんを引き当てる
  }
}

export async function runShadowWorker(deps: ShadowWorkerDeps): Promise<ShadowWorkerResult> {
  const { db, workerId } = deps;
  // 判断モデルの全ての呼び出し（再試行・再評価を含む）を、共通のハード上限で数える
  const model = deps.model && deps.callBudget ? withCallBudget(deps.model, deps.callBudget) : deps.model;
  const now = deps.now ?? ((): Date => new Date());
  const res: ShadowWorkerResult = { stoppedBy: "completed", leased: 0, done: 0, skipped: 0, requeued: 0, failed: 0, spentJpy: 0, byStatus: {}, byReason: {} };
  const bump = (m: Record<string, number>, k: string): void => {
    m[k] = (m[k] ?? 0) + 1;
  };
  const perm = shadowWorkerPermission(deps.env ?? process.env);
  if (!perm.allowed) return { ...res, stoppedBy: "not_allowed", notAllowedReason: perm.reason };
  if (!model && !deps.proposalJob) return { ...res, stoppedBy: "no_model" };
  const t0 = now().getTime();
  const budgetMs = deps.timeBudgetMs ?? 280_000; // 本番のルート（関数の時間枠300秒）と同じ既定（AUTONOMY_RESTORATION）
  const jobTimeout = deps.perJobTimeoutMs ?? 45_000;

  // 待ち行列の優先順位（EVIDENCE_UTILIZATION。AIなし・費用0）: 締切を過ぎた候補は閉じ、締切が近い・確認待ち・未評価の候補を先に
  if (deps.proposalJob) await prioritizeShadowQueue(db, now());
  const leased = await rpc(db)("shadow_lease", { p_worker: workerId, p_limit: deps.limit ?? 3, p_lease_seconds: Math.ceil((jobTimeout * 2 + 15_000) / 1000) });
  if (leased.error) return { ...res, stoppedBy: "lease_error" };
  const jobs = (leased.data ?? []) as Job[];  res.leased = jobs.length;
  if (!jobs.length) return { ...res, stoppedBy: "no_jobs" };

  const requeue = async (j: Job, at: Date, error: string | null, penalty: boolean): Promise<void> => {
    await table(db, "shadow_jobs")
      .update({ status: "queued", locked_by: null, lease_until: null, next_run_at: at.toISOString(), last_error: error, attempts: penalty ? j.attempts : Math.max(0, j.attempts - 1), updated_at: now().toISOString() })
      .eq("id", j.id)
      .eq("locked_by", workerId);
    res.requeued++;
  };
  const finish = async (j: Job, status: "done" | "skipped" | "failed", reason: string | null): Promise<void> => {
    await table(db, "shadow_jobs")
      .update({ status, locked_by: null, lease_until: null, skip_reason: status === "skipped" ? reason : null, last_error: status === "failed" ? reason : null, updated_at: now().toISOString() })
      .eq("id", j.id)
      .eq("locked_by", workerId);
    if (status === "done") res.done++;
    else if (status === "skipped") {
      res.skipped++;
      if (reason) bump(res.byReason, reason);
    } else {
      res.failed++;
      if (reason) bump(res.byReason, reason);
    }
  };

  for (const [n, j] of jobs.entries()) {
    try {
      // 時間: 1件分（AIの待ち時間＋余裕）が残っていなければ、残りは確保を解除して次回へ（罰なし）
      if (now().getTime() - t0 + jobTimeout + 5_000 > budgetMs) {
        for (const r of jobs.slice(n)) await requeue(r, now(), null, false);
        return { ...res, stoppedBy: "time" };
      }
      // 緊急停止（DB）: AI呼び出しの直前に毎回読み直す。無効ならこのジョブは呼ばずに戻す
      const st = await loadShadowSettings(db, j.household_id);
      if (!st || !st.enabled) {
        await requeue(j, new Date(now().getTime() + 5 * 60_000), "killed", false);
        bump(res.byReason, "killed");
        continue;
      }
      const { data: cand } = await table(db, "collection_candidates").select("id,last_good,draft,x_post_id,source_url").eq("id", j.candidate_id).eq("household_id", j.household_id).maybeSingle();
      if (!cand) {
        await finish(j, "skipped", "candidate_missing");
        continue;
      }
      const stored = evidenceFromLastGood(cand.last_good);
      const relation = stored ? jobEvidenceRelation(j.evidence_hash, stored) : "same";
      if (relation === "stale") {
        await finish(j, "skipped", "stale_evidence");
        continue;
      }
      if (relation === "material_changed" && stored) {
        // 本文は同じで、リンク先・画像がこのジョブの作成後に変わった: 最新の証拠のジョブを確実に入れて（冪等）、このジョブは閉じる
        const cur = shadowJobHash(stored);
        if (cur) await rpc(db)("shadow_enqueue", { p_household: j.household_id, p_candidate: j.candidate_id, p_hash: cur }).then(() => undefined, () => undefined);
        await finish(j, "skipped", "stale_material");
        continue;
      }
      const prep = prepareShadowEvidence(stored);
      if (!prep.ok) {
        await finish(j, "skipped", prep.reason);
        continue;
      }

      // Phase 3: 本番シャドーの登録案ジョブ。予算（DBの日次・月次・1件）を確認してから、収集済みの保存データだけで調査・判断・検証する
      if (deps.proposalJob) {
        // 同じ候補の再評価の間隔（PRODUCTION_PARITY: 証拠の小さな変化のたびに有料で再評価し、3候補で予算の半分を使っていた）。
        // 直近 REEVAL_MIN_INTERVAL_MS 以内に同じ候補のジョブが完了していれば、このジョブ（最新の証拠）はその間隔のあとへ回す（捨てない＝最新の証拠は必ず評価される）
        const recent = await table(db, "shadow_jobs").select("updated_at,evidence_hash").eq("household_id", j.household_id).eq("candidate_id", j.candidate_id).eq("status", "done").neq("id", j.id).gte("updated_at", new Date(now().getTime() - REEVAL_MIN_INTERVAL_MS).toISOString()).order("updated_at", { ascending: false }).limit(1);
        const last = (recent.data as { updated_at: string; evidence_hash: string }[] | null)?.[0];
        if (last) {
          // EVIDENCE_UTILIZATION: 意味のある更新（本文・リンク先・画像の変化、締切が近い、前回の評価後の人の修正）は、12時間を待たず短い間隔（2時間）で評価する
          const reviewedAfter = await humanReviewAfter(db, j.household_id, j.candidate_id, last.updated_at);
          const why = reevalUrgency({ lastHash: last.evidence_hash, jobHash: j.evidence_hash, deadline: (cand.draft as { input?: { applyDeadline?: { date?: string | null } } } | null)?.input?.applyDeadline?.date ?? null, reviewedAfter, now: now() });
          const wait = why ? REEVAL_URGENT_INTERVAL_MS : REEVAL_MIN_INTERVAL_MS;
          const at = new Date(last.updated_at).getTime() + wait;
          if (at > now().getTime()) {
            await requeue(j, new Date(at), why ? `reeval_wait_${why}`.slice(0, 40) : "reeval_interval", false);
            bump(res.byReason, why ? `reeval_wait_${why}` : "reeval_interval");
            continue;
          }
          if (why) bump(res.byReason, `reeval_${why}`);
        }
        if (st.valid_until && now().getTime() >= new Date(st.valid_until).getTime()) {
          await requeue(j, new Date(now().getTime() + 6 * 60 * 60_000), "expired", false); // 試行期間が過ぎた（以降のジョブはDB側で確保されない）
          bump(res.byReason, "expired");
          continue;
        }
        // 費用判断の直列化（並列実行で同じ残額を二重に使わない）。取れなければ罰なしで少し後に
        const lock = await rpc(db)("shadow_budget_lock", { p_household: j.household_id, p_worker: workerId, p_seconds: 150 });
        if (lock.error || lock.data !== true) {
          await requeue(j, new Date(now().getTime() + 3 * 60_000), "budget_locked", false);
          bump(res.byReason, "budget_locked");
          continue;
        }
        try {
        const d1 = now();
        const [day1, month1] = await Promise.all([rpc(db)("shadow_spent", { p_household: j.household_id, p_since: jstDayStart(d1).toISOString() }), rpc(db)("shadow_spent", { p_household: j.household_id, p_since: jstMonthStart(d1).toISOString() })]);
        const spentDay = Number(day1.data ?? 0);
        // 未確定費用の保守的な引当: 開始した試行（attempts）より記録（shadow_judgments）が少ないジョブ＝実行が途中で打ち切られ、費用が記録されていない可能性。1試行あたり1件上限を残額から差し引く。
        // 日次の残額には今日（日本時間）に更新されたジョブの分だけ、月次・通算には全部を引き当てる（過去の日の未確定を毎日の残額から引き続けない）
        const exceptIds = jobs.map((x) => x.id); // この実行で確保したジョブは対象外（実行中）
        const uncDay = await unconfirmedReserveJpy(db, j.household_id, st.per_case_cap_jpy, exceptIds, jstDayStart(d1).toISOString());
        const uncAll = await unconfirmedReserveJpy(db, j.household_id, st.per_case_cap_jpy, exceptIds);
        let left1 = Math.min(st.daily_budget_jpy - spentDay - uncDay, st.monthly_budget_jpy - Number(month1.data ?? 0) - uncAll);
        let totalErr = false;
        if (st.total_budget_jpy !== null && st.total_budget_jpy !== undefined) {
          const tot = await rpc(db)("shadow_spent", { p_household: j.household_id, p_since: st.total_since ?? "1970-01-01T00:00:00Z" });
          if (tot.error) totalErr = true;
          else left1 = Math.min(left1, st.total_budget_jpy - Number(tot.data ?? 0) - uncAll); // 通算の上限
        }        if (day1.error || month1.error || totalErr || !(left1 > 0.5)) {
          await requeue(j, day1.error || month1.error || totalErr ? new Date(d1.getTime() + 10 * 60_000) : nextJstDay(d1), "budget", false);
          bump(res.byReason, "budget");
          continue;
        }
        const t1 = now().getTime();
        // AUTONOMY_RESTORATION（再開）: 同じジョブの以前の実行（部分完了）で調べた項目と使った費用を、実行台帳から引き継ぐ
        // JUDGMENT_IDENTITY_EFFICIENCY F2: 読み取りに失敗したら実行しない（以前は「再開の情報なし＝0円・最初から」として進み、1候補の上限を再開で回避し、完了済みの項目を再課金しうた）。少し後に罰なしで戻す
        type PrevRow = { cost_jpy: number | null; record: { doneItems?: number[]; status?: string } | null };
        const prev = await (async (): Promise<PrevRow[] | null> => {
          try {
            const r = (await table(db, "shadow_judgments").select("cost_jpy,record").eq("household_id", j.household_id).eq("job_id", j.id).limit(200)) as { data: PrevRow[] | null; error?: unknown };
            return r.error ? null : (r.data ?? []);
          } catch {
            return null;
          }
        })();
        if (prev === null) {
          await requeue(j, new Date(now().getTime() + 10 * 60_000), "ledger_read_failed", false);
          bump(res.byReason, "ledger_read_failed");
          continue;
        }
        const doneItems = [...new Set(prev.flatMap((x) => (Array.isArray(x.record?.doneItems) ? x.record!.doneItems! : [])))];
        const spentOnJobJpy = prev.reduce((s, x) => s + Number(x.cost_jpy ?? 0), 0);
        const resumes = prev.filter((x) => x.record?.status === "partial").length;
        const runDeadlineMs = t0 + budgetMs - 8_000; // 1回の実行（関数の時間枠）を安全に終えるべき時刻。調査の締切ではない
        const pr = await deps.proposalJob({ householdId: j.household_id, candidate: { id: cand.id, x_post_id: cand.x_post_id ?? null, source_url: cand.source_url ?? null, last_good: cand.last_good }, settings: st, spentTodayJpy: spentDay, remainingJpy: left1, runDeadlineMs, ...(doneItems.length ? { doneItems } : {}), ...(spentOnJobJpy > 0 ? { spentOnJobJpy } : {}) });
        if (!pr.ok) {          bump(res.byReason, pr.reason.slice(0, 40));
          // 失敗でも、すでにかかった費用・実行の痕跡は記録する（記録しないと予算から漏れる）。AIを呼んでいない失敗（費用0）は記録しない
          if ((pr.costJpy ?? 0) > 0) {
            const failRow = { household_id: j.household_id, job_id: j.id, candidate_id: j.candidate_id, prompt_version: "proposal-shadow", model_id: "proposal-shadow", status: "error", attempts: 1, cost_jpy: pr.costJpy, latency_ms: now().getTime() - t1, structure_new: "proposal_shadow", structure_legacy: null, opportunity_count: 0, record: { v: 1, kind: "proposal_shadow", at: now().toISOString(), status: "error", reason: pr.reason.slice(0, 40), costJpy: pr.costJpy, ...(pr.trace ? { trace: pr.trace } : {}) } };
            let insF = await table(db, "shadow_judgments").insert(failRow);
            for (let k = 0; k < 2 && insF.error; k++) insF = await table(db, "shadow_judgments").insert(failRow);
            if (insF.error) {
              await table(db, "shadow_settings").update({ enabled: false }).eq("household_id", j.household_id).then(() => undefined, () => undefined);
              for (const r of jobs.slice(n)) await requeue(r, new Date(now().getTime() + 60 * 60_000), "record_failed", false);
              bump(res.byReason, "record_failed");
              return { ...res, stoppedBy: "record_failed" };
            }
            res.spentJpy += pr.costJpy ?? 0;
          }
          if (pr.fatal) {
            // 認証・利用上限: 以降を呼ばない。このジョブと残りは罰なしで戻す（再試行の連打をしない）
            for (const r of jobs.slice(n)) await requeue(r, new Date(now().getTime() + 60 * 60_000), pr.fatal, false);
            return { ...res, stoppedBy: "provider_error", notAllowedReason: pr.fatal };
          }
          if (pr.reason.startsWith("gate:") || pr.reason.startsWith("ticket:")) await finish(j, "skipped", pr.reason.slice(0, 60)); // 許可されていない: AIは1回も呼んでいない
          else if (pr.reason === "budget_per_case_exhausted") await finish(j, "done", "budget_per_case_exhausted"); // 再開をまたいで1候補の上限に達した（未完了の項目は記録に残る）
          else if (pr.reason === "budget") await requeue(j, nextJstDay(now()), "budget", false);
          else if (pr.reason === "budget_run") await requeue(j, new Date(now().getTime() + 10 * 60_000), "budget_run", false); // この実行の残りの枠が無いだけ（候補の上限ではない）
          else if (pr.reason === "run_call_limit") await requeue(j, new Date(now().getTime() + 10 * 60_000), "run_call_limit", false);
          else if (j.attempts >= j.max_attempts) await finish(j, "failed", pr.reason.slice(0, 60));
          else await requeue(j, new Date(now().getTime() + Math.min(60, 2 ** j.attempts) * 60_000), pr.reason.slice(0, 60), true);
          continue;
        }        const recP = { v: 1, kind: "proposal_shadow", at: now().toISOString(), status: pr.status, proposals: pr.proposals, inserted: pr.inserted, costJpy: pr.costJpy, stopped: pr.stopped, decisions: pr.decisions, revisions: pr.revisions, diagnostics: pr.diagnostics, basisAt: pr.basisAt, search: pr.trace.tools.search === "offered", liveFetch: pr.trace.tools.liveFetch === "offered", trace: pr.trace, ...(pr.items?.length ? { items: pr.items } : {}), ...(pr.doneItems ? { doneItems: pr.doneItems } : {}), ...(pr.pendingItems?.length ? { pendingItems: pr.pendingItems } : {}), ...(pr.totalItems !== undefined ? { totalItems: pr.totalItems } : {}), ...(pr.interruptedItems?.length ? { interruptedItems: pr.interruptedItems } : {}), ...(resumes ? { resumes } : {}) };
        // 実行台帳の行の上限（8,000バイト）を超えるときは、試行の要約を減らす（費用の記録自体は失わない）
        while (JSON.stringify(recP).length > 7000 && (recP as { items?: unknown[] }).items?.length) (recP as { items?: unknown[] }).items!.pop();
        const rowP = { household_id: j.household_id, job_id: j.id, candidate_id: j.candidate_id, prompt_version: "proposal-shadow", model_id: "proposal-shadow", status: pr.status, attempts: 1, cost_jpy: pr.costJpy, latency_ms: now().getTime() - t1, structure_new: "proposal_shadow", structure_legacy: null, opportunity_count: pr.decisions.register ?? 0, record: recP };
        // 費用の記録は予算の根拠。失敗したら再試行し、それでも記録できなければ、この世帯のシャドーを停止して実行を止める（記録できない費用を重ねない）
        let insP = await table(db, "shadow_judgments").insert(rowP);
        for (let k = 0; k < 2 && insP.error; k++) insP = await table(db, "shadow_judgments").insert(rowP);
        if (insP.error) {
          res.spentJpy += pr.costJpy;
          await table(db, "shadow_settings").update({ enabled: false }).eq("household_id", j.household_id).then(() => undefined, () => undefined);
          for (const r of jobs.slice(n)) await requeue(r, new Date(now().getTime() + 60 * 60_000), "record_failed", false);
          bump(res.byReason, "record_failed");
          return { ...res, stoppedBy: "record_failed" };
        }
        res.spentJpy += pr.costJpy;
        bump(res.byStatus, pr.status);
        if (pr.fatal) {
          // 認証・利用上限（記録は残した）: 以降を呼ばない。このジョブと残りは罰なしで戻す
          bump(res.byReason, pr.fatal);
          for (const r of jobs.slice(n)) await requeue(r, new Date(now().getTime() + 60 * 60_000), pr.fatal, false);
          return { ...res, stoppedBy: "provider_error", notAllowedReason: pr.fatal };
        }
        if (pr.status === "error") {
          if (j.attempts >= j.max_attempts) await finish(j, "failed", "proposal_error");
          else await requeue(j, new Date(now().getTime() + Math.min(60, 2 ** j.attempts) * 60_000), "proposal_error", true);
        } else if (pr.status === "partial" && (pr.pendingItems?.length ?? 0) > 0 && !pr.fatal) {
          // 未完了（時間の外枠に達した）: 調べていない項目を次の実行で続ける。罰なし（失敗ではない）。再開の回数は暴走防止の上限まで
          if (resumes + 1 >= SHADOW_MAX_RESUMES) await finish(j, "done", "resume_limit");
          else await requeue(j, new Date(now().getTime() + 60_000), "resume", false);
          bump(res.byReason, "resume");
        } else await finish(j, "done", null);
        } finally {
          await rpc(db)("shadow_budget_unlock", { p_household: j.household_id, p_worker: workerId }).then(() => undefined, () => undefined);
        }
        continue;
      }

      // 一覧・まとめ投稿（Stage 10M）: 全項目を処理する（登録値に近い1項目だけに絞らない）。モデルが無ければ従来の焦点
      if (deps.listModel && stored && parseListItems(stored.text).isList) {
        if (deps.callBudget && deps.callBudget.remainingCalls <= 0) {
          await requeue(j, new Date(now().getTime() + 10 * 60_000), "run_call_limit", false);
          bump(res.byReason, "run_call_limit");
          continue;
        }
        const d0 = now();
        const [day0, month0] = await Promise.all([rpc(db)("shadow_spent", { p_household: j.household_id, p_since: jstDayStart(d0).toISOString() }), rpc(db)("shadow_spent", { p_household: j.household_id, p_since: jstMonthStart(d0).toISOString() })]);
        const left0 = Math.min(st.daily_budget_jpy - Number(day0.data ?? 0), st.monthly_budget_jpy - Number(month0.data ?? 0));
        if (!(left0 > 0.5)) {
          await requeue(j, nextJstDay(d0), "budget", false);
          bump(res.byReason, "budget");
          continue;
        }
        const lr = await runListJob({ db, householdId: j.household_id, candidateId: j.candidate_id, stored, draft: cand.draft, listModel: deps.listModel, budgetJpy: Math.min(left0, st.per_case_cap_jpy * 3), runBudget: deps.callBudget, maxCallsPerJob: deps.maxCallsPerListJob, now });
        if (!lr) {
          await finish(j, "skipped", "list_parse");
          continue;
        }
        const cv = lr.coverage;
        const status = cv.complete ? "accepted" : "partial";
        const rec = { v: 1, kind: "list_discovery", at: now().toISOString(), promptVersion: deps.listModel.promptVersion, modelId: deps.listModel.id, status, calls: lr.calls, costJpy: Math.round(lr.costJpy * 10000) / 10000, latencyMs: lr.latencyMs, stoppedBy: lr.stoppedBy, reused: lr.reused, processed: lr.processed, list: { total: cv.total, done: cv.done, hold: cv.hold, failed: cv.failed, pending: cv.pending, complete: cv.complete, opportunitiesConfirmed: cv.opportunitiesConfirmed, candidatesOnHold: cv.opportunityCandidatesOnHold, byVerdict: cv.byVerdict, groups: lr.parsed.groups }, legacy: { matchedItems: lr.legacyMatchedItems, itemCount: lr.legacyItemCount } };
        const insL = await table(db, "shadow_judgments").insert({ household_id: j.household_id, job_id: j.id, candidate_id: j.candidate_id, prompt_version: deps.listModel.promptVersion, model_id: deps.listModel.id.slice(0, 80), status, attempts: lr.calls, cost_jpy: Math.round(lr.costJpy * 10000) / 10000, latency_ms: lr.latencyMs, structure_new: "list_discovery", structure_legacy: null, opportunity_count: cv.opportunitiesConfirmed, record: rec });
        if (insL.error) {
          await requeue(j, new Date(now().getTime() + 10 * 60_000), "record_failed", true);
          continue;
        }
        res.spentJpy += lr.costJpy;
        bump(res.byStatus, status);
        if (cv.complete) await finish(j, "done", null);
        else if (j.attempts >= j.max_attempts) await finish(j, "failed", "list_incomplete");
        else {
          // 未処理（上限で停止）・失敗の項目がある: 処理済みの項目は再利用されるので、少し後に続きから再開する。進んだなら罰なし
          await requeue(j, new Date(now().getTime() + 10 * 60_000), lr.stoppedBy ? `list_stopped_${lr.stoppedBy}` : "list_incomplete", lr.processed === 0);
          bump(res.byReason, "list_incomplete");
        }
        continue;
      }

      if (!model) {
        await requeue(j, new Date(now().getTime() + 10 * 60_000), "no_model", false);
        continue;
      }
      const current = currentCaseFromDraft(cand.draft, stored);
      const foc = focusEvidenceSeeds(prep.seeds, current);
      if (!foc.ok) {
        await finish(j, "skipped", foc.reason);
        continue;
      }
      // 予算（日次・月次・1件）。事前予約: 見込み費用が残額を超えるなら呼ばない。画像の検証の費用も、この予算（判断と合計）の中で使う
      const d = now();
      const [day, month] = await Promise.all([rpc(db)("shadow_spent", { p_household: j.household_id, p_since: jstDayStart(d).toISOString() }), rpc(db)("shadow_spent", { p_household: j.household_id, p_since: jstMonthStart(d).toISOString() })]);
      const dayLeft = st.daily_budget_jpy - Number(day.data ?? 0);
      const monthLeft = st.monthly_budget_jpy - Number(month.data ?? 0);
      let remaining = Math.min(dayLeft, monthLeft);
      let caseCap = st.per_case_cap_jpy;

      // 画像根拠の検証（Stage 10L）: 収集時の読み取りがあり、元画像への参照がある場合だけ。照合できた行だけが fact の根拠になる
      let seeds = foc.seeds;
      if (stored?.imageReadings?.length) {
        let ver: ImageVerification | null = null;
        if (deps.imageVerify && stored.imageRefs?.length && remaining > 0) {
          ver = await deps.imageVerify({ householdId: j.household_id, candidateId: j.candidate_id, readings: stored.imageReadings, refs: stored.imageRefs, budgetJpy: Math.min(remaining, caseCap / 2) }).catch(() => null);
        }
        const checks = ver?.checks ?? stored.imageReadings.map((r) => ({ field: r.field, imageIndex: r.imageIndex, status: "no_image" as const }));
        const imgSeeds = imageEvidenceSeeds(stored.imageReadings, checks, "https://evidence.invalid/img", stored.fetchedAt).filter((x) => !x.text || detectLeaks(x.text).length === 0);
        seeds = [...seeds.filter((x) => x.kind !== "image_reading"), ...imgSeeds].map((x, n) => ({ ...x, url: `https://evidence.invalid/${n + 1}` }));
        if (ver) {
          remaining -= ver.costJpy;
          caseCap = Math.max(0, caseCap - ver.costJpy);
          for (const [k, v] of Object.entries(summarizeChecks(checks))) if (v) bump(res.byReason, `image_${k}`);
        }
      }
      const input = await buildJudgmentInput({ caseId: null, title: "", now: now(), evidence: seeds, related: [], currentCase: current, masters: [], failures: [], regionPrefectures: [] });
      const reserve = Math.min(model.maxCostJpy(input), caseCap);
      if (!(remaining >= reserve) || remaining <= 0 || caseCap <= 0) {
        await requeue(j, monthLeft < reserve ? nextJstMonth(d) : nextJstDay(d), "budget", false);
        bump(res.byReason, "budget");
        continue;
      }

      const sink = new CaptureSink();
      const config = (): ShadowConfig => ({ enabled: true, reason: "enabled", mode: "mock", maxPerWindow: 1000, windowMs: H, timeoutMs: jobTimeout, budgetCapJpy: Math.min(remaining, caseCap), perCaseCapJpy: caseCap, maxConcurrent: 1 });
      const ctl = new ShadowController({ model, sink, config, now: () => Date.now() });
      const out = await ctl.observe({ caseKey: `${j.candidate_id}:${j.evidence_hash}`, input, legacy: legacySummaryFromDraft(cand.draft), legacySource: "collector_extraction" });
      const rec = out.record ?? sink.last;
      if (!out.ran || !rec) {
        // 実行されなかった（予算・同時実行など）。罰なしで少し後にやり直す
        await requeue(j, new Date(now().getTime() + 10 * 60_000), out.skipped ? `skip_${out.skipped}`.slice(0, 60) : "not_run", false);
        continue;
      }
      const ins = await table(db, "shadow_judgments").insert({
        household_id: j.household_id,
        job_id: j.id,
        candidate_id: j.candidate_id,
        prompt_version: rec.promptVersion,
        model_id: rec.modelId,
        status: rec.status,
        attempts: rec.attempts,
        cost_jpy: rec.costJpy,
        latency_ms: rec.latencyMs,
        structure_new: rec.next?.structure ?? null,
        structure_legacy: rec.legacy.structure,
        opportunity_count: rec.next?.opportunityCount ?? null,
        record: rec,
      });
      if (ins.error) {
        await requeue(j, new Date(now().getTime() + 10 * 60_000), "record_failed", true);
        continue;
      }
      bump(res.byStatus, rec.status);
      res.spentJpy += rec.costJpy ?? 0;
      if (rec.status === "timeout" || rec.status === "error" || rec.status === "model_error") {
        // 失敗: 指数バックオフで再試行。試行の上限で failed
        if (j.attempts >= j.max_attempts) await finish(j, "failed", rec.status);
        else await requeue(j, new Date(now().getTime() + Math.min(60, 2 ** j.attempts) * 60_000), rec.status, true);
      } else await finish(j, "done", null);
    } catch {
      // 想定外の例外: 罰ありで再試行（上限で failed）。旧方式・他のジョブには波及させない
      try {
        if (j.attempts >= j.max_attempts) await finish(j, "failed", "exception");
        else await requeue(j, new Date(now().getTime() + Math.min(60, 2 ** j.attempts) * 60_000), "exception", true);
      } catch {
        /* リース切れで他のワーカーが引き継ぐ */
      }
    }
  }
  return res;
}
