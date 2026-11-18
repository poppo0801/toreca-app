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

export function resolveEffectiveEngine(o: { stored: unknown; loadFailed?: boolean; toremaneEnv?: string }): EffectiveEngine {
  if (o.loadFailed) return { engine: "legacy", stored: null, note: "収集方式の設定を読み込めなかったため、今回は従来方式で実行します（設定は変更していません）" };
  const stored = parseEngine(o.stored);
  if (stored === null) return { engine: "legacy", stored: null, note: "収集方式の設定が不正なため、従来方式で実行します" };
  if (stored === "autonomous" && o.toremaneEnv !== "local") return { engine: "legacy", stored, note: "自律型AI主体は開発環境のみで利用できます（本番の導入は別の手順）。従来方式で実行します" };
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
