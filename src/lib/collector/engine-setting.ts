/**
 * 情報収集方式の設定の解決と、自律型の実行枠の判定（Stage 9H-3Q・純関数）。
 *   - 設定が読めない・不正な値 → 従来方式（既存ロジック主体）に安全にフォールバックする。ただし設定そのものは書き換えない
 *     （一時的なエラーで、利用者に知らせず方式を恒久的に切り替えない。実行ごとに設定を読み直す）
 *   - 自律型は開発環境（TOREMANE_ENV=local）だけ。本番は設定が autonomous でも従来方式（本番導入は9H-3R）
 *   - 実行枠: 定期収集の時刻（日本時間）ごとの枠で、自律型の実行回数に上限を設ける（1回の呼び出しは約60秒以内のため、枠ごとに複数回に分けて進める）
 */
import { currentSlot } from "@/lib/collector/schedule";
import type { CollectionEngineId } from "@/lib/collector/engine-contract";

export const parseEngine = (v: unknown): CollectionEngineId | null => (v === "autonomous" || v === "legacy" ? v : null);

export interface EffectiveEngine {
  engine: CollectionEngineId;
  /** 設定の値（読めなければ null） */
  stored: CollectionEngineId | null;
  /** 設定どおりでない場合の理由（画面に表示する） */
  note: string | null;
}

/** 自律型AI主体を使ってよい環境か。開発環境（TOREMANE_ENV=local）、または明示的な許可（AUTONOMOUS_COLLECTION=on。本番は利用者が環境変数で有効にしたときだけ） */
export const autonomousAllowed = (env: { TOREMANE_ENV?: string; AUTONOMOUS_COLLECTION?: string }): boolean => env.TOREMANE_ENV === "local" || env.AUTONOMOUS_COLLECTION === "on";

export function resolveEffectiveEngine(o: { stored: unknown; loadFailed?: boolean; toremaneEnv?: string; /** 本番での明示的な許可（AUTONOMOUS_COLLECTION=on） */ enabled?: boolean }): EffectiveEngine {
  if (o.loadFailed) return { engine: "legacy", stored: null, note: "収集方式の設定を読み込めなかったため、今回は従来方式で実行します（設定は変更していません）" };
  const stored = parseEngine(o.stored);
  if (stored === null) return { engine: "legacy", stored: null, note: "収集方式の設定が不正なため、従来方式で実行します" };
  if (stored === "autonomous" && o.toremaneEnv !== "local" && !o.enabled) return { engine: "legacy", stored, note: "自律型AI主体はこの環境で有効になっていません（環境変数 AUTONOMOUS_COLLECTION=on が必要）。従来方式で実行します" };
  return { engine: stored, stored, note: null };
}

/** 1つの枠で、自律型を実行する回数の上限（1回の実行＝ミッション1件） */
export const MAX_RUNS_PER_SLOT = 3;
/** 実行中の排他の期限（異常終了しても、この時間で自動的に解ける） */
export const LOCK_MS = 5 * 60_000;
/** 履歴の保持方針 */
export const RETENTION = Object.freeze({ days: 60, maxRuns: 300, maxRecordChars: 60_000 });

export interface SlotDecision {
  due: boolean;
  slot: string;
  reason: string;
}

/** 定期実行で、いま自律型を実行する枠か。runsInSlot は、この枠で開始した自律型の実行数（skipped を除く）。lastRunning は実行中の記録の開始時刻（あれば） */
export function autonomousSlotDecision(o: { now: Date; hours: ReadonlyArray<number | null | undefined>; runsInSlot: number; runningSince?: Date | null; maxRuns?: number }): SlotDecision {
  const s = currentSlot(o.now, o.hours);
  const slot = `${s.date}T${String(s.hour).padStart(2, "0")}`;
  if (o.runningSince && o.now.getTime() - o.runningSince.getTime() < LOCK_MS) return { due: false, slot, reason: "前回の実行がまだ終わっていません" };
  if (o.runsInSlot >= (o.maxRuns ?? MAX_RUNS_PER_SLOT)) return { due: false, slot, reason: "この時間枠の実行回数に達しました" };
  return { due: true, slot, reason: "" };
}

/** 保持方針: 古い記録・件数超過の記録の削除対象を決める（実行中の記録は残す） */
export function pruneTargets(rows: { id: string; started_at: string; status: string }[], now: Date): string[] {
  const cutoff = now.getTime() - RETENTION.days * 86_400_000;
  const sorted = [...rows].sort((a, b) => b.started_at.localeCompare(a.started_at));
  return sorted.filter((r, i) => r.status !== "running" && (i >= RETENTION.maxRuns || new Date(r.started_at).getTime() < cutoff)).map((r) => r.id);
}

/** 保存する記録を小さくする（原文の抜粋・長い文面の切り詰め。全文は保存しない）。上限を超えるときは、手がかりの詳細から落とす */
export function compactRecord<T extends { leads: { lead: { quote: string } }[]; followUps: { outcome: string }[] }>(r: T): T {
  const c = JSON.parse(JSON.stringify(r)) as T;
  for (const l of c.leads) l.lead.quote = l.lead.quote.slice(0, 300);
  for (const f of c.followUps) f.outcome = f.outcome.slice(0, 160);
  if (JSON.stringify(c).length > RETENTION.maxRecordChars) {
    c.followUps = c.followUps.slice(0, 20);
    c.leads = c.leads.slice(0, 30);
  }
  return c;
}

/** 現在の実行枠のキー（日本時間の日付と時刻。例 2026-11-20T06） */
export function slotKeyOf(now: Date, hours: ReadonlyArray<number | null | undefined>): string {
  const s = currentSlot(now, hours);
  return `${s.date}T${String(s.hour).padStart(2, "0")}`;
}

// ---- 本番運用の調査機会・費用（Stage 9H-3R-Release）----

/** 1日の調査機会（日本時間の時）。通常は1日4回、新商品の発売前後の繁忙期は8回。回数を必ず消化するものではなく、費用・成果・残予算で見送る */
export const OPPORTUNITY_HOURS = Object.freeze({ normal: [6, 11, 16, 21] as readonly number[], busy: [6, 8, 10, 12, 14, 16, 18, 21] as readonly number[] });
/** 1つの調査機会（枠）で実行するミッション数の上限（1回のCron呼び出し＝ミッション1件） */
export const MAX_MISSIONS_PER_OPPORTUNITY = 3;
/** ミッション1件の費用の目安（実測の平均≒9.5円）。残予算の配分の判定に使う */
export const EXPECTED_MISSION_JPY = 10;
/** 繁忙期: 商品の発売日が、今日の3日前〜7日後にある */
export function isBusyPeriod(todayJst: string, releaseDates: ReadonlyArray<string | null | undefined>): boolean {
  const t = Date.parse(`${todayJst}T00:00:00Z`);
  return releaseDates.some((d) => {
    if (!d) return false;
    const x = Date.parse(`${d.slice(0, 10)}T00:00:00Z`);
    if (Number.isNaN(x)) return false;
    const days = Math.round((x - t) / 86_400_000);
    return days >= -3 && days <= 7;
  });
}
export const opportunityHours = (busy: boolean): readonly number[] => (busy ? OPPORTUNITY_HOURS.busy : OPPORTUNITY_HOURS.normal);

export interface AutonomousCaps { dailyJpy: number; monthlyJpy: number; perMissionJpy: number }
/** 費用の上限（環境変数）。既定は 日次100円・月次1,500円・1件15円。不正な値は既定に戻す */
export function autonomousCaps(env: Record<string, string | undefined>): AutonomousCaps {
  const n = (v: string | undefined, d: number) => (Number(v) > 0 && Number.isFinite(Number(v)) ? Number(v) : d);
  return { dailyJpy: n(env.AUTONOMOUS_DAILY_CAP_JPY, 100), monthlyJpy: n(env.AUTONOMOUS_MONTHLY_CAP_JPY, 1500), perMissionJpy: n(env.COLLECT_AUTONOMOUS_PER_MISSION_JPY, 15) };
}

/** 1回の調査の時間配分（ミリ秒）。ミッションの調査 ＋ 登録処理。Vercel の maxDuration（Cron の入口）より十分に短くする */
export function autonomousTimeBudget(env: Record<string, string | undefined>): { missionMs: number; totalMs: number } {
  const v = Number(env.AUTONOMOUS_TIME_BUDGET_MS);
  const missionMs = Number.isFinite(v) && v >= 20_000 ? Math.min(v, 120_000) : 100_000;
  return { missionMs, totalMs: missionMs + 40_000 };
}

/**
 * 費用の配分: 今日の残り予算を、残りの調査機会に配る。
 * 枠の最初のミッションは、残りが1件の上限以上なら始める。2件目以降は、この枠の配分（残り÷残りの機会数）に収まるときだけ。
 * 月次・日次の上限に達していれば開始しない（有料処理を止める）。
 */
export function paceDecision(o: { dailyRemaining: number; monthlyRemaining: number; slotSpent: number; slotsLeftToday: number; perMissionJpy: number }): { ok: boolean; reason: string } {
  const remaining = Math.min(o.dailyRemaining, o.monthlyRemaining);
  if (remaining < o.perMissionJpy) return { ok: false, reason: o.monthlyRemaining < o.dailyRemaining ? "今月の費用の上限に近いため開始しません" : "今日の費用の上限に近いため開始しません" };
  if (o.slotSpent <= 0) return { ok: true, reason: "" };
  const allowance = (o.dailyRemaining + o.slotSpent) / Math.max(1, o.slotsLeftToday);
  if (o.slotSpent + EXPECTED_MISSION_JPY > allowance) return { ok: false, reason: "この調査機会の費用の配分に達したため、残りの調査は次の機会に回します" };
  return { ok: true, reason: "" };
}

/** この枠で続けて調査する価値があるか。通常期は、直前のミッションが新しい発見も要確認も出さなければ、残りの調査を見送る（費用の節約）。繁忙期は続ける */
export function slotWorthContinuing(o: { busy: boolean; previous: ReadonlyArray<{ status: string; found: number; registered: number; held: number }> }): { ok: boolean; reason: string } {
  if (o.busy || o.previous.length === 0) return { ok: true, reason: "" };
  const last = o.previous[o.previous.length - 1];
  if (last.status === "completed" && last.found === 0 && last.registered === 0 && last.held === 0) return { ok: false, reason: "直前の調査で新しい情報が見つからなかったため、この機会の残りの調査は見送ります" };
  return { ok: true, reason: "" };
}
