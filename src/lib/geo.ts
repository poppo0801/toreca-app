/**
 * 位置・距離（直線距離のみ）。道路距離・所要時間は外部のルート検索が必要なので扱わない（Stage 6）。
 * 緯度経度は内部情報で、画面には数値を出さない。
 */

const EARTH_RADIUS_KM = 6371.0088;

export interface LatLng {
  lat: number;
  lng: number;
}

const rad = (d: number) => (d * Math.PI) / 180;

export function isValidLatLng(p: { lat: number | null | undefined; lng: number | null | undefined }): p is LatLng {
  return typeof p.lat === "number" && typeof p.lng === "number" && Number.isFinite(p.lat) && Number.isFinite(p.lng) && Math.abs(p.lat) <= 90 && Math.abs(p.lng) <= 180;
}

/** Haversine式による2点間の大圏距離（km） */
export function haversineKm(a: LatLng, b: LatLng): number {
  const dLat = rad(b.lat - a.lat);
  const dLng = rad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_KM * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** 距離の区分の上限（km）。既定: 5/15/30/60 → 5段階（5未満・〜15・〜30・〜60・60以上） */
export const DEFAULT_DISTANCE_BANDS_KM = [5, 15, 30, 60] as const;

export type DistanceBand = 0 | 1 | 2 | 3 | 4;

/** 段階（0=最も近い）。境界値ちょうどは遠い側（5km → 5〜15km） */
export function distanceBand(km: number, bands: readonly number[] = DEFAULT_DISTANCE_BANDS_KM): DistanceBand {
  let i = 0;
  while (i < bands.length && km >= bands[i]) i++;
  return Math.min(i, 4) as DistanceBand;
}

/** 区分ごとの色（緑・青・黄・オレンジ・赤）。色だけに頼らず距離の数値も併記する */
export const BAND_CLASS: Record<DistanceBand, string> = {
  0: "border-success text-success",
  1: "border-p-blue text-p-blue",
  2: "border-warn text-warn",
  3: "border-primary text-primary",
  4: "border-danger text-danger",
};

export function bandLabel(band: DistanceBand, bands: readonly number[] = DEFAULT_DISTANCE_BANDS_KM): string {
  const b = bands;
  return [`${b[0]}km未満`, `${b[0]}〜${b[1]}km`, `${b[1]}〜${b[2]}km`, `${b[2]}〜${b[3]}km`, `${b[3]}km以上`][band];
}

/** 表示用: 10km未満は小数1桁、それ以上は整数 */
export function formatKm(km: number): string {
  return km < 10 ? `${(Math.round(km * 10) / 10).toFixed(1)}km` : `${Math.round(km)}km`;
}

/** 閾値が昇順の正の数4つか（設定値の検証） */
export function validBands(v: unknown): v is number[] {
  return Array.isArray(v) && v.length === 4 && v.every((n) => typeof n === "number" && Number.isFinite(n) && n > 0) && v.every((n, i) => i === 0 || n > v[i - 1]);
}

const PREFECTURES = [
  "北海道", "青森県", "岩手県", "宮城県", "秋田県", "山形県", "福島県", "茨城県", "栃木県", "群馬県", "埼玉県", "千葉県", "東京都", "神奈川県",
  "新潟県", "富山県", "石川県", "福井県", "山梨県", "長野県", "岐阜県", "静岡県", "愛知県", "三重県", "滋賀県", "京都府", "大阪府", "兵庫県",
  "奈良県", "和歌山県", "鳥取県", "島根県", "岡山県", "広島県", "山口県", "徳島県", "香川県", "愛媛県", "高知県", "福岡県", "佐賀県", "長崎県",
  "熊本県", "大分県", "宮崎県", "鹿児島県", "沖縄県",
] as const;
export const PREFECTURE_LIST: readonly string[] = PREFECTURES;

/** 住所の先頭から都道府県を取り出す（見つからなければ null。推測しない） */
export function prefectureOf(address: string): string | null {
  const a = address.normalize("NFKC").trim();
  return PREFECTURES.find((p) => a.startsWith(p)) ?? null;
}
