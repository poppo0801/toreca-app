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
import { buildJudgmentInput } from "@/lib/judgment/build-input";
import type { JudgmentModel } from "@/lib/judgment/model";
import type { ShadowConfig } from "@/lib/judgment/shadow/config";
import { ShadowController } from "@/lib/judgment/shadow/controller";
import type { ShadowRecord, ShadowSink } from "@/lib/judgment/shadow/record";
import type { Db } from "@/lib/server/lottery-service";
import { shadowWorkerPermission } from "./allow";
import type { ImageReading } from "@/lib/collector/evidence";
import { imageEvidenceSeeds, summarizeChecks } from "@/lib/judgment/image-verify";
import { detectLeaks } from "@/lib/judgment/eval/phase2";
import type { ImageVerification } from "./image-verifier";
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
  /** Stage 10L: 画像根拠の検証（元画像の独立した書き起こしとの照合）。未設定なら画像読み取りは「照合できていない読み取り」のまま渡す */
  imageVerify?: (a: { householdId: string; candidateId: string; readings: ImageReading[]; refs: string[]; budgetJpy: number }) => Promise<ImageVerification>;
}

export interface ShadowWorkerResult {
  stoppedBy: "not_allowed" | "no_model" | "no_jobs" | "time" | "completed" | "lease_error";
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
  const { data } = await table(db, "shadow_settings").select("enabled,enqueue_enabled,daily_budget_jpy,monthly_budget_jpy,per_case_cap_jpy,max_jobs_per_run,retention_days").eq("household_id", householdId).maybeSingle();
  if (!data) return null;
  return { ...data, daily_budget_jpy: Number(data.daily_budget_jpy), monthly_budget_jpy: Number(data.monthly_budget_jpy), per_case_cap_jpy: Number(data.per_case_cap_jpy) };
}

class CaptureSink implements ShadowSink {
  last: ShadowRecord | null = null;
  async write(r: ShadowRecord): Promise<void> {
    this.last = r;
  }
}

export async function runShadowWorker(deps: ShadowWorkerDeps): Promise<ShadowWorkerResult> {
  const { db, model, workerId } = deps;
  const now = deps.now ?? ((): Date => new Date());
  const res: ShadowWorkerResult = { stoppedBy: "completed", leased: 0, done: 0, skipped: 0, requeued: 0, failed: 0, spentJpy: 0, byStatus: {}, byReason: {} };
  const bump = (m: Record<string, number>, k: string): void => {
    m[k] = (m[k] ?? 0) + 1;
  };
  const perm = shadowWorkerPermission(deps.env ?? process.env);
  if (!perm.allowed) return { ...res, stoppedBy: "not_allowed", notAllowedReason: perm.reason };
  if (!model) return { ...res, stoppedBy: "no_model" };
  const t0 = now().getTime();
  const budgetMs = deps.timeBudgetMs ?? 100_000;
  const jobTimeout = deps.perJobTimeoutMs ?? 45_000;

  const leased = await rpc(db)("shadow_lease", { p_worker: workerId, p_limit: deps.limit ?? 3, p_lease_seconds: Math.ceil((jobTimeout * 2 + 15_000) / 1000) });
  if (leased.error) return { ...res, stoppedBy: "lease_error" };
  const jobs = (leased.data ?? []) as Job[];
  res.leased = jobs.length;
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
      const { data: cand } = await table(db, "collection_candidates").select("id,last_good,draft").eq("id", j.candidate_id).eq("household_id", j.household_id).maybeSingle();
      if (!cand) {
        await finish(j, "skipped", "candidate_missing");
        continue;
      }
      const stored = evidenceFromLastGood(cand.last_good);
      if (stored && !stored.hash.startsWith(j.evidence_hash)) {
        await finish(j, "skipped", "stale_evidence");
        continue;
      }
      const prep = prepareShadowEvidence(stored);
      if (!prep.ok) {
        await finish(j, "skipped", prep.reason);
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
