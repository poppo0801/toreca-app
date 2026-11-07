/**
 * ガソリン代の計算（Stage 6N・純関数）。
 *  往復: 片道距離 × 2 ÷ 燃費 × ガソリン単価 / 片道: 片道距離 ÷ 燃費 × ガソリン単価。結果は円単位に四捨五入する。
 *  既定: ガソリン単価 155円/L、燃費 16.7km/L（MAZDA3 セダン 20S 2WD・型式 5BA-BPFP を基準にした初期値。実燃費に合わせて設定で変更する）。
 *  計算済みの支出金額は保存された値で、単価・燃費の設定を後から変えても書き換わらない。
 */
export const DEFAULT_FUEL_PRICE_PER_L = 155;
export const DEFAULT_FUEL_KM_PER_L = 16.7;

export interface FuelInput {
  /** 入力欄の文字列でも数値でもよい */
  oneWayKm: number | string;
  roundTrip: boolean;
  pricePerL: number | string;
  kmPerL: number | string;
}
export type FuelResult = { ok: true; yen: number } | { ok: false; error: string };

const num = (v: number | string): number => (typeof v === "number" ? v : v.trim() === "" ? NaN : Number(v));

export function calcFuelCost(i: FuelInput): FuelResult {
  const km = num(i.oneWayKm);
  const price = num(i.pricePerL);
  const eff = num(i.kmPerL);
  if (!Number.isFinite(km) || km <= 0) return { ok: false, error: "片道距離は0より大きい数値で入力してください" };
  if (km > 3000) return { ok: false, error: "片道距離は3000km以下で入力してください" };
  if (!Number.isFinite(price) || price <= 0) return { ok: false, error: "ガソリン単価は0より大きい数値で入力してください" };
  if (!Number.isFinite(eff) || eff <= 0) return { ok: false, error: "燃費が設定されていません（設定でkm/Lを入力してください）" };
  const yen = Math.round(((km * (i.roundTrip ? 2 : 1)) / eff) * price);
  return { ok: true, yen };
}

export interface FuelSettingsInput {
  pricePerL: number | string;
  kmPerL: number | string;
}
/** 設定値の検証。問題なければ null */
export function fuelSettingsError(i: FuelSettingsInput): string | null {
  const p = num(i.pricePerL);
  const k = num(i.kmPerL);
  if (!Number.isFinite(p) || p <= 0 || p > 1000) return "ガソリン単価は1〜1000円/Lで入力してください";
  if (!Number.isFinite(k) || k <= 0 || k > 100) return "燃費は0より大きく100km/L以下で入力してください";
  return null;
}

/** 経費の内容（ガソリン代モードで固定する名称） */
export const FUEL_ITEM_NAME = "ガソリン代";
