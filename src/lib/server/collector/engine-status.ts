import "server-only";
import type { Db } from "@/lib/server/lottery-service";

/** 設定画面用: 現在の収集方式の設定と、自律型の直近の実行状況（読み取りのみ。Stage 9H-3Q）。マイグレーション104が無い環境では読み込みに失敗し、従来方式として扱われる */
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- 新しい表・列は生成型に無い
const anyDb = (db: Db) => db as any;

export interface EngineRunRow {
  id: string;
  trigger: string;
  status: string;
  started_at: string;
  finished_at: string | null;
  stop_reason: string | null;
  error: string | null;
  counts: { found?: number; registered?: number; duplicates?: number; excluded?: number; alreadyKnown?: number; held?: number };
  cost_jpy: number;
  duration_ms: number;
}

export async function loadOpsStatus(db: Db, householdId: string): Promise<{ loadFailed: boolean; stored: string | undefined; changedAt: string | null | undefined; runs: EngineRunRow[] }> {
  const [s, runs] = await Promise.all([
    anyDb(db).from("collection_settings").select("collection_engine,collection_engine_changed_at").eq("household_id", householdId).maybeSingle(),
    anyDb(db).from("discovery_runs").select("id,trigger,status,started_at,finished_at,stop_reason,error,counts,cost_jpy,duration_ms").eq("household_id", householdId).order("started_at", { ascending: false }).limit(10),
  ]);
  return { loadFailed: !!s.error || !s.data, stored: s.data?.collection_engine as string | undefined, changedAt: s.data?.collection_engine_changed_at as string | null | undefined, runs: (runs.data ?? []) as EngineRunRow[] };
}
