"use server";

import { createClient } from "@/lib/supabase/server";
import { loadFuelSettings, loadTripDistance, saveFuelSettings, saveTripDistance, type FuelSettings } from "@/lib/server/fuel-service";
import { currentHouseholdId, type Db } from "@/lib/server/lottery-service";

/** ガソリン代（Stage 6N）。ログイン必須・自世帯のみ（RLS）。 */
type R<T = object> = ({ ok: true } & T) | { ok: false; error: string };

async function ctx(): Promise<Db | null> {
  try {
    const db = (await createClient()) as unknown as Db;
    const { data } = await db.auth.getUser();
    if (!data.user) return null;
    return (await currentHouseholdId(db)) ? db : null;
  } catch {
    return null;
  }
}

/** 設定（燃費・単価）と、系列＋店舗の保存済み片道距離（なければ null） */
export async function loadFuelContextAction(chainId: string | null, storeId: string | null): Promise<R<{ settings: FuelSettings; oneWayKm: number | null }>> {
  const db = await ctx();
  if (!db) return { ok: false, error: "ログインが必要です" };
  const [settings, oneWayKm] = await Promise.all([loadFuelSettings(db), loadTripDistance(db, chainId, storeId)]);
  return { ok: true, settings, oneWayKm };
}

export async function saveFuelSettingsAction(input: { pricePerL: number; kmPerL: number }, actor: string | null): Promise<R<{ settings: FuelSettings }>> {
  const db = await ctx();
  if (!db) return { ok: false, error: "ログインが必要です" };
  const r = await saveFuelSettings(db, input, actor);
  return r.ok ? { ok: true, settings: r.value } : { ok: false, error: r.error };
}

export async function saveTripDistanceAction(chainId: string, storeId: string | null, oneWayKm: number, actor: string | null): Promise<R> {
  const db = await ctx();
  if (!db) return { ok: false, error: "ログインが必要です" };
  const r = await saveTripDistance(db, chainId, storeId, oneWayKm, actor);
  return r.ok ? { ok: true } : { ok: false, error: r.error };
}
