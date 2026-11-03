import { PREFECTURE_LIST } from "@/lib/geo";

/**
 * 店舗住所のジオコーディング判定（純関数）。外部APIの結果から、別の場所の座標を推測で採用しないための規則を持つ。
 */
export interface GeoHit {
  title: string;
  lat: number;
  lng: number;
}

/** 漢数字（一〜九十九）を算用数字に。国土地理院の結果は「八丁目」「一丁目」のように漢数字で返るため、住所側と同じ形にそろえる */
function kanjiToDigits(s: string): string {
  const d: Record<string, number> = { 〇: 0, 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };
  return s.replace(/[〇一二三四五六七八九十]+/g, (m) => {
    if (m.includes("十")) {
      const [h, l] = m.split("十");
      return String((h ? (d[h] ?? 1) : 1) * 10 + (l ? (d[l] ?? 0) : 0));
    }
    return [...m].map((c) => d[c]).join("");
  });
}

/** 比較用の正規化: 全角→半角、漢数字→算用数字、空白除去、丁目・番地・号を「-」に揃える */
export function normalizeForMatch(s: string): string {
  return kanjiToDigits(s.normalize("NFKC"))
    .replace(/[\s　]+/g, "")
    .replace(/[‐‑–—―−ー－]/g, "-")
    .replace(/丁目|番地|番/g, "-")
    .replace(/号/g, "")
    .replace(/-+/g, "-")
    .replace(/-$/, "");
}

/** 検索に使う住所。住所に都道府県が無ければ、店舗の都道府県を先頭に足す（推測ではなく登録済みの値） */
export function buildQuery(address: string, prefecture: string | null | undefined): string {
  const a = address.normalize("NFKC").trim();
  const pref = (prefecture ?? "").trim();
  if (!a) return "";
  if (PREFECTURE_LIST.some((p) => a.startsWith(p))) return a;
  return pref && PREFECTURE_LIST.includes(pref) ? `${pref}${a}` : a;
}

/** 住所が取得に足りるか: 都道府県で始まり、市区町村（郡）を含み、番地などの手がかりが十分にある */
export function isCompleteAddress(query: string): boolean {
  const q = normalizeForMatch(query);
  if (q.length < 9) return false;
  if (!PREFECTURE_LIST.some((p) => q.startsWith(p))) return false;
  return /[市区町村郡]/.test(q.slice(2));
}

export type PickResult = { kind: "ok"; hit: GeoHit } | { kind: "no_match" } | { kind: "ambiguous" };

/**
 * 候補から採用するものを決める。候補の住所（正規化）が検索住所の先頭と一致するものだけを対象にし、
 * 最も細かい（長い）一致を採る。一致が市区町村止まり（町名・番地まで届かない）の場合や、同じ細かさで離れた別の場所が複数ある場合は採用しない。
 */
export function pickCandidate(query: string, hits: GeoHit[]): PickResult {
  const q = normalizeForMatch(query);
  const matched = hits
    .map((h) => ({ h, t: normalizeForMatch(h.title) }))
    .filter((x) => x.t.length > 0 && q.startsWith(x.t));
  if (matched.length === 0) return { kind: "no_match" };
  const longest = Math.max(...matched.map((x) => x.t.length));
  const best = matched.filter((x) => x.t.length === longest);
  // 町名・丁目まで届いているか（市区町村止まりは別店舗の座標になりうる）
  const afterCity = best[0].t.replace(/^.{2,4}?[都道府県]/, "");
  if (!/[町村字丁]|\d/.test(afterCity) || longest < 10) return { kind: "ambiguous" };
  const far = best.some((x) => distanceKmApprox(best[0].h, x.h) > 1);
  if (far) return { kind: "ambiguous" };
  return { kind: "ok", hit: best[0].h };
}

function distanceKmApprox(a: { lat: number; lng: number }, b: { lat: number; lng: number }): number {
  const dy = (a.lat - b.lat) * 111;
  const dx = (a.lng - b.lng) * 111 * Math.cos((a.lat * Math.PI) / 180);
  return Math.hypot(dx, dy);
}

/** 取得待ちに戻して再試行する上限（一時的なエラーのとき）。超えたら「取得失敗」 */
export const MAX_GEO_ATTEMPTS = 3;
