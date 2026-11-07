import { z } from "zod";
import { DEFAULT_FUEL_KM_PER_L, DEFAULT_FUEL_PRICE_PER_L, fuelSettingsError } from "@/lib/fuel";
import { currentHouseholdId, mapDbError, type Db, type ServiceResult } from "@/lib/server/lottery-service";

/**
 * ガソリン代の設定と、系列×店舗ごとの片道距離（Stage 6N）。認証済み(RLS適用)のクライアントを受け取る。
 *  - 燃費・ガソリン単価の初期値は世帯の設定（行が無ければ既定 155円/L・16.7km/L）
 *  - 片道距離は「系列＋店舗」ごとに1つ。店舗なしは系列のみの距離で、別店舗の距離を流用しない
 *  - 過去の支出金額は保存された値のままで、設定を変えても書き換えない
 */
const ok = <T>(value: T): ServiceResult<T> => ({ ok: true, value });
const fail = (error: string): ServiceResult<never> => ({ ok: false, error });
const uuid = z.uuid();
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- 新しい表は生成型に無い場合がある
const any = (db: Db) => db as any;

export interface FuelSettings {
  pricePerL: number;
  kmPerL: number;
}

export async function loadFuelSettings(db: Db): Promise<FuelSettings> {
  const { data } = await any(db).from("fuel_settings").select("price_per_l,km_per_l").maybeSingle();
  return { pricePerL: data ? Number(data.price_per_l) : DEFAULT_FUEL_PRICE_PER_L, kmPerL: data ? Number(data.km_per_l) : DEFAULT_FUEL_KM_PER_L };
}

export async function saveFuelSettings(db: Db, input: { pricePerL: number; kmPerL: number }, actor: string | null): Promise<ServiceResult<FuelSettings>> {
  const e = fuelSettingsError(input);
  if (e) return fail(e);
  const hid = await currentHouseholdId(db);
  if (!hid) return fail("世帯が見つかりません");
  const row = { household_id: hid, price_per_l: Math.round(input.pricePerL * 10) / 10, km_per_l: Math.round(input.kmPerL * 10) / 10, updated_by_profile_id: actor };
  const { error } = await any(db).from("fuel_settings").upsert(row, { onConflict: "household_id" });
  if (error) return fail(mapDbError(error));
  return ok({ pricePerL: row.price_per_l, kmPerL: row.km_per_l });
}

/** 系列＋店舗の片道距離。店舗が未設定(null)のときは「店舗なし」の距離だけを返す（別店舗の距離は使わない） */
export async function loadTripDistance(db: Db, chainId: string | null, storeId: string | null): Promise<number | null> {
  if (!chainId || !uuid.safeParse(chainId).success) return null;
  if (storeId !== null && !uuid.safeParse(storeId).success) return null;
  let q = any(db).from("store_trip_distances").select("one_way_km").eq("chain_id", chainId);
  q = storeId ? q.eq("store_id", storeId) : q.is("store_id", null);
  const { data } = await q.maybeSingle();
  return data ? Number(data.one_way_km) : null;
}

export async function saveTripDistance(db: Db, chainId: string, storeId: string | null, oneWayKm: number, actor: string | null): Promise<ServiceResult> {
  if (!uuid.safeParse(chainId).success || (storeId !== null && !uuid.safeParse(storeId).success)) return fail("リクエストが不正です");
  if (!Number.isFinite(oneWayKm) || oneWayKm <= 0 || oneWayKm > 3000) return fail("片道距離は0より大きく3000km以下で入力してください");
  const hid = await currentHouseholdId(db);
  if (!hid) return fail("世帯が見つかりません");
  const km = Math.round(oneWayKm * 10) / 10;
  const found = await loadTripRow(db, chainId, storeId);
  if (found) {
    const { error } = await any(db).from("store_trip_distances").update({ one_way_km: km, updated_by_profile_id: actor }).eq("id", found);
    return error ? fail(mapDbError(error)) : ok(undefined);
  }
  const { error } = await any(db).from("store_trip_distances").insert({ household_id: hid, chain_id: chainId, store_id: storeId, one_way_km: km, updated_by_profile_id: actor });
  // 同時保存で先に作られたときは、更新に切り替える
  if (error && (error as { code?: string }).code === "23505") {
    const again = await loadTripRow(db, chainId, storeId);
    if (again) {
      const r = await any(db).from("store_trip_distances").update({ one_way_km: km, updated_by_profile_id: actor }).eq("id", again);
      return r.error ? fail(mapDbError(r.error)) : ok(undefined);
    }
  }
  return error ? fail(mapDbError(error)) : ok(undefined);
}

async function loadTripRow(db: Db, chainId: string, storeId: string | null): Promise<string | null> {
  let q = any(db).from("store_trip_distances").select("id").eq("chain_id", chainId);
  q = storeId ? q.eq("store_id", storeId) : q.is("store_id", null);
  const { data } = await q.maybeSingle();
  return data?.id ?? null;
}
