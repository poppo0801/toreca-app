/**
 * 保存・送信する文字列の安全な切り詰め（Stage 6B）。
 * 絵文字などはサロゲートペア（2要素）なので、`slice` で途中を切ると不正な文字列（孤立サロゲート）になり、
 * JSON として DB へ送ると「バッチ全体が失敗」する（X投稿は絵文字が多く、97件の一括保存が1件のために全滅していた）。
 */
const NUL = String.fromCharCode(0);

/** 孤立サロゲートと NUL 文字を取り除く（DB に保存できる文字列にする） */
export function wellFormed(s: string): string {
  let out = "";
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c === 0) continue;
    if (c >= 0xd800 && c <= 0xdbff) {
      const n = s.charCodeAt(i + 1);
      if (n >= 0xdc00 && n <= 0xdfff) {
        out += s[i] + s[i + 1];
        i++;
      }
      continue; // 対になっていない上位サロゲートは捨てる
    }
    if (c >= 0xdc00 && c <= 0xdfff) continue; // 対になっていない下位サロゲート
    out += s[i];
  }
  return out;
}

/** 文字の途中（サロゲートペアの間）で切らずに、先頭 n 要素までを返す */
export function safeSlice(s: string, n: number): string {
  if (s.length <= n) return wellFormed(s);
  let end = n;
  const c = s.charCodeAt(end - 1);
  if (c >= 0xd800 && c <= 0xdbff) end -= 1;
  return wellFormed(s.slice(0, end));
}

/** 末尾 n 要素を、文字の途中で切らずに返す */
export function safeSliceEnd(s: string, n: number): string {
  if (s.length <= n) return wellFormed(s);
  let start = s.length - n;
  const c = s.charCodeAt(start);
  if (c >= 0xdc00 && c <= 0xdfff) start += 1;
  return wellFormed(s.slice(start));
}

export const hasNul = (s: string) => s.includes(NUL);

/** オブジェクト・配列の中の文字列をすべて保存できる形にする（DBへ送る行の最終防御） */
export function deepClean<T>(v: T): T {
  if (typeof v === "string") return wellFormed(v) as unknown as T;
  if (Array.isArray(v)) return v.map((x) => deepClean(x)) as unknown as T;
  if (v && typeof v === "object") {
    const o: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v as Record<string, unknown>)) o[k] = deepClean(x);
    return o as T;
  }
  return v;
}
