// `supabase db query` の標準出力から行（rows）を取り出す。
// Supabase CLI 3.x は、出力形式の指定が無いと「AI エージェント環境の検出時だけ JSON、通常は表形式」になる。
// `--output-format json` を付けると素の配列（[{...}]）、エージェント検出時は {"rows":[...]} 形式のことがあるため、両方を受ける。
// 秘密や個人データは出力しない（エラー文にも出力の本文は含めず、先頭の種類だけを示す）。

/** @param {string} out  `supabase db query` の標準出力 */
export function parseQueryRows(out) {
  const text = String(out ?? "").trim();
  if (!text) throw new Error("クエリの応答が空です");
  const tryParse = (s) => {
    try {
      return JSON.parse(s);
    } catch {
      return undefined;
    }
  };
  let v = tryParse(text);
  if (v === undefined) {
    // 前後に警告などが混ざる場合に備え、最初の { または [ から最後の } または ] までを試す
    const starts = [text.indexOf("{"), text.indexOf("[")].filter((i) => i >= 0);
    const ends = [text.lastIndexOf("}"), text.lastIndexOf("]")].filter((i) => i >= 0);
    if (starts.length && ends.length) v = tryParse(text.slice(Math.min(...starts), Math.max(...ends) + 1));
  }
  if (Array.isArray(v)) return v;
  if (v && Array.isArray(v.rows)) return v.rows;
  throw new Error(`クエリの応答がJSONの行データではありません（${text.startsWith("┌") || text.startsWith("|") ? "表形式の出力" : "不明な形式"}。出力形式の指定を確認）`);
}
