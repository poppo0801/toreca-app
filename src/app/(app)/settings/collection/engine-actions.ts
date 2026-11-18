"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { resolveEffectiveEngine } from "@/lib/collector/engine-setting";
import { createClient } from "@/lib/supabase/server";
import { runAutonomousManual } from "@/lib/server/collector/autonomous-hook";
import { getExtractor } from "@/lib/ai/provider";
import { currentHouseholdId, type Db } from "@/lib/server/lottery-service";

export type EngineActionResult = { ok: true; message?: string } | { ok: false; error: string };

async function ctx(): Promise<{ db: Db; householdId: string; userId: string } | null> {
  const db = (await createClient()) as unknown as Db;
  const { data: auth } = await db.auth.getUser();
  if (!auth.user) return null;
  const householdId = await currentHouseholdId(db);
  return householdId ? { db, householdId, userId: auth.user.id } : null;
}

/** 情報収集方式を保存する（世帯に1つ。DBに保存され、端末間で共有される）。変更は次回の収集実行から反映する（実行中の処理は変更しない）。データは削除・初期化しない */
export async function setCollectionEngineAction(engine: string): Promise<EngineActionResult> {
  const p = z.enum(["legacy", "autonomous"]).safeParse(engine);
  if (!p.success) return { ok: false, error: "不正な指定です" };
  const c = await ctx();
  if (!c) return { ok: false, error: "ログインが必要です" };
  if (p.data === "autonomous" && process.env.TOREMANE_ENV !== "local") return { ok: false, error: "自律型AI主体は開発環境のみで利用できます（本番への導入は別の手順で行います）" };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- 新しい列は生成型に無い（マイグレーション104）
  const { data, error } = await (c.db as any).from("collection_settings").update({ collection_engine: p.data, collection_engine_changed_at: new Date().toISOString() }).eq("household_id", c.householdId).select("collection_engine");
  if (error || !data || data.length !== 1) return { ok: false, error: "保存できませんでした。画面を再読み込みしてもう一度お試しください" };
  revalidatePath("/settings/collection");
  return { ok: true, message: "保存しました。次回の収集実行から反映されます（実行中の処理は変更されません）" };
}

/** 自律型の収集を1回、手動で実行する（開発環境のみ。実AIの関門を通らなければ実行しない）。排他・上限・登録経路は定期実行と同じ */
export async function runAutonomousNowAction(): Promise<EngineActionResult> {
  const c = await ctx();
  if (!c) return { ok: false, error: "ログインが必要です" };
  const row = (await (c.db as any).from("collection_settings").select("collection_engine").eq("household_id", c.householdId).maybeSingle()).data as { collection_engine?: string } | null; // eslint-disable-line @typescript-eslint/no-explicit-any
  const eff = resolveEffectiveEngine({ stored: row?.collection_engine, loadFailed: !row, toremaneEnv: process.env.TOREMANE_ENV });
  if (eff.engine !== "autonomous") return { ok: false, error: eff.note ?? "収集方式が自律型AI主体ではありません" };
  const out = await runAutonomousManual({ db: c.db, householdId: c.householdId, extractor: getExtractor() });
  revalidatePath("/settings/collection");
  if (out.status === "ran") return { ok: true, message: `完了: 新規発見${out.counts?.found ?? 0}件・登録${out.counts?.registered ?? 0}件・重複${out.counts?.duplicates ?? 0}件` };
  return { ok: false, error: out.message ?? "実行できませんでした" };
}
