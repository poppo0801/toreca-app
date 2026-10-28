import { DEFAULT_DISTANCE_BANDS_KM, distanceBand, haversineKm, isValidLatLng, validBands, type DistanceBand } from "@/lib/geo";
import type { AppData, Store } from "@/types/domain";

export interface StoreDistance {
  km: number;
  band: DistanceBand;
}

/**
 * 自宅から店舗までの直線距離と区分。自宅・店舗のどちらかの位置が未設定なら null（推測しない）。
 * 道路距離ではない。
 */
export function storeDistance(data: Pick<AppData, "settings">, store: Pick<Store, "lat" | "lng"> | undefined): StoreDistance | null {
  const s = data.settings;
  if (!s || !store) return null;
  const home = { lat: s.homeLat, lng: s.homeLng };
  const there = { lat: store.lat, lng: store.lng };
  if (!isValidLatLng(home) || !isValidLatLng(there)) return null;
  const km = haversineKm(home, there);
  const bands = validBands(s.distanceBandsKm) ? s.distanceBandsKm : DEFAULT_DISTANCE_BANDS_KM;
  return { km, band: distanceBand(km, bands) };
}
