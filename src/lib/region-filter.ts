/**
 * 地域フィルターの共通仕様（Stage 6E）。
 *  - 都道府県は複数選択。選べるのは、そのページのデータに実際に存在する都道府県だけ。
 *  - プリセット: 「関西3県」（兵庫・大阪・京都）／「関西＋関東6都府県」（＋東京・神奈川・千葉）。個別に選ぶと「カスタム」。
 *  - 選択が空 = 地域で絞らない（すべて）。通販・発送のみ・所在地が不明のものは、地域では除外しない。
 */
export const KANSAI3: readonly string[] = ["兵庫県", "大阪府", "京都府"];
export const KANSAI_KANTO6: readonly string[] = [...KANSAI3, "東京都", "神奈川県", "千葉県"];

/** 全47都道府県を地域別に整理したもの（地域フィルターの選択画面用。表示用の分類で、データの有無に依存しない） */
export const REGION_GROUPS: readonly { name: string; prefectures: readonly string[] }[] = [
  { name: "北海道・東北", prefectures: ["北海道", "青森県", "岩手県", "宮城県", "秋田県", "山形県", "福島県"] },
  { name: "関東", prefectures: ["茨城県", "栃木県", "群馬県", "埼玉県", "千葉県", "東京都", "神奈川県"] },
  { name: "中部", prefectures: ["新潟県", "富山県", "石川県", "福井県", "山梨県", "長野県", "岐阜県", "静岡県", "愛知県"] },
  { name: "近畿", prefectures: ["三重県", "滋賀県", "京都府", "大阪府", "兵庫県", "奈良県", "和歌山県"] },
  { name: "中国・四国", prefectures: ["鳥取県", "島根県", "岡山県", "広島県", "山口県", "徳島県", "香川県", "愛媛県", "高知県"] },
  { name: "九州・沖縄", prefectures: ["福岡県", "佐賀県", "長崎県", "熊本県", "大分県", "宮崎県", "鹿児島県", "沖縄県"] },
];
export const ALL_PREFECTURES: readonly string[] = REGION_GROUPS.flatMap((g) => g.prefectures);

/** 「何も選ばない」状態を表す印（選択が空 = すべて、と区別するため）。どの都道府県にも一致しない */
export const NO_PREFECTURE = "__none__";

/** 選択の要約（ボタン表示用）。空 = すべて */
export function regionSummary(all: readonly string[]): string {
  const selected = all.filter((p) => p !== NO_PREFECTURE);
  if (all.length > 0 && selected.length === 0) return "未選択";
  if (selected.length === 0 || selected.length >= ALL_PREFECTURES.length) return "すべて";
  if (selected.length <= 3) return selected.join("・");
  return `${selected.length}都道府県`;
}

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
