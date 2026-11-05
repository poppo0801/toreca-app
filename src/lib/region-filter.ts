/**
 * 地域フィルターの共通仕様（Stage 6E）。
 *  - 都道府県は複数選択。選べるのは、そのページのデータに実際に存在する都道府県だけ。
 *  - プリセット: 「関西3県」（兵庫・大阪・京都）／「関西＋関東6都府県」（＋東京・神奈川・千葉）。個別に選ぶと「カスタム」。
 *  - 選択が空 = 地域で絞らない（すべて）。通販・発送のみ・所在地が不明のものは、地域では除外しない。
 */
export const KANSAI3: readonly string[] = ["兵庫県", "大阪府", "京都府"];
export const KANSAI_KANTO6: readonly string[] = [...KANSAI3, "東京都", "神奈川県", "千葉県"];

export type RegionMode = "kansai3" | "kanto6" | "all" | "custom";
export const REGION_LABEL: Record<RegionMode, string> = { kansai3: "関西3県", kanto6: "関西＋関東6都府県", all: "すべて", custom: "カスタム" };

const sameSet = (a: readonly string[], b: readonly string[]) => a.length === b.length && a.every((x) => b.includes(x));

/** 現在の選択がどのプリセットか（データに存在する都道府県だけで比べる） */
export function regionMode(selected: readonly string[], present: readonly string[]): RegionMode {
  if (selected.length === 0) return "all";
  const sel = selected.filter((p) => present.includes(p));
  const k3 = KANSAI3.filter((p) => present.includes(p));
  const k6 = KANSAI_KANTO6.filter((p) => present.includes(p));
  if (k3.length > 0 && sameSet(sel, k3)) return "kansai3";
  if (k6.length > 0 && sameSet(sel, k6)) return "kanto6";
  return "custom";
}

/** プリセットを選択に変換（すべて = 空） */
export function presetSelection(mode: Exclude<RegionMode, "custom">): string[] {
  return mode === "kansai3" ? [...KANSAI3] : mode === "kanto6" ? [...KANSAI_KANTO6] : [];
}

/** 個別の切替。存在する都道府県がすべて選ばれたら「すべて」（空）にそろえる */
export function toggleRegion(selected: readonly string[], pref: string, present: readonly string[]): string[] {
  const base = selected.length === 0 ? [...present] : [...selected];
  const next = base.includes(pref) ? base.filter((p) => p !== pref) : [...base, pref];
  return present.every((p) => next.includes(p)) ? [] : next;
}

/**
 * 地域で表示対象か。選択が空なら常に対象。所在地が分からない・通販／発送のみのものは除外しない。
 * unlocated: 通販専用の店舗・発送のみの受取など、特定の地域に結び付かないもの
 */
export function matchRegion(selected: readonly string[], prefecture: string | null | undefined, unlocated: boolean): boolean {
  if (selected.length === 0 || unlocated || !prefecture) return true;
  return selected.includes(prefecture);
}

/** 保存値の検証（壊れた値は使わない） */
export function validateRegion(v: unknown): string[] | null {
  return Array.isArray(v) && v.every((x) => typeof x === "string") ? (v as string[]) : null;
}

const KEY = "tcg.pref.region";
/** 端末に保存した地域の選択。未保存は null（呼び出し側が関西3県を既定にする） */
export function loadRegion(): string[] | null {
  try {
    const raw = window.localStorage.getItem(KEY);
    return raw ? validateRegion(JSON.parse(raw)) : null;
  } catch {
    return null;
  }
}
export function saveRegion(sel: readonly string[]): void {
  try {
    window.localStorage.setItem(KEY, JSON.stringify(sel));
  } catch {
    /* 保存できなくても動作は継続 */
  }
}
