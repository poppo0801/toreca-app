/**
 * 名称の「読み」による照合（Stage 9H-3S-3・純関数）。個別の名称に依存しない、汎用の表記揺れの吸収。
 *
 *  - kanaFold: ひらがな/カタカナ・全角半角・大小文字・記号・空白・小書き文字・長音の違いを吸収した照合用の文字列
 *  - toRomaji: かな（ひらがな/カタカナ）をヘボン式に近いローマ字へ。漢字を含む名称は null（読みを機械的に決められない。AIの調査で確認する）
 *  - readingKey: 英字表記とかな表記を同じ土俵（ローマ字）に揃えた厳密な読みの一致用キー（ポケモン⇔pokemon）
 *  - phoneticKey / phoneticSimilarity: 英語風の綴りとカタカナの近さ（ジラフル⇔GIRAFULL）。**近いだけでは同一としない**。候補の発見（AIの判定・追加調査に回す）にだけ使う
 */

/** ひらがな → カタカナ */
export function toKatakana(s: string): string {
  return (s ?? "").replace(/[ぁ-ゖ]/g, (c) => String.fromCharCode(c.charCodeAt(0) + 0x60));
}

const SYMBOLS = /[・･.．,，、。'’"“”`´\-‐–—―_/／\\|｜:：;；!！?？~〜～#＃*＊&＆+＋=＝「」『』【】[\]()（）<>＜＞]/g;

/** かな表記の違い（ひらがな/カタカナ・全角半角・記号・空白）を吸収した照合用の文字列 */
export function kanaFold(raw: string): string {
  return toKatakana((raw ?? "").normalize("NFKC").toLowerCase().replace(/株式会社|有限会社|\(株\)/g, "").replace(SYMBOLS, "").replace(/[\s　]+/g, ""));
}

// ---- かな → ローマ字
const BASE: Record<string, string> = {
  ア: "a", イ: "i", ウ: "u", エ: "e", オ: "o",
  カ: "ka", キ: "ki", ク: "ku", ケ: "ke", コ: "ko",
  サ: "sa", シ: "shi", ス: "su", セ: "se", ソ: "so",
  タ: "ta", チ: "chi", ツ: "tsu", テ: "te", ト: "to",
  ナ: "na", ニ: "ni", ヌ: "nu", ネ: "ne", ノ: "no",
  ハ: "ha", ヒ: "hi", フ: "fu", ヘ: "he", ホ: "ho",
  マ: "ma", ミ: "mi", ム: "mu", メ: "me", モ: "mo",
  ヤ: "ya", ユ: "yu", ヨ: "yo",
  ラ: "ra", リ: "ri", ル: "ru", レ: "re", ロ: "ro",
  ワ: "wa", ヰ: "i", ヱ: "e", ヲ: "o", ン: "n",
  ガ: "ga", ギ: "gi", グ: "gu", ゲ: "ge", ゴ: "go",
  ザ: "za", ジ: "ji", ズ: "zu", ゼ: "ze", ゾ: "zo",
  ダ: "da", ヂ: "ji", ヅ: "zu", デ: "de", ド: "do",
  バ: "ba", ビ: "bi", ブ: "bu", ベ: "be", ボ: "bo",
  パ: "pa", ピ: "pi", プ: "pu", ペ: "pe", ポ: "po",
  ヴ: "vu",
  ァ: "a", ィ: "i", ゥ: "u", ェ: "e", ォ: "o",
};
const SMALL_Y: Record<string, string> = { ャ: "ya", ュ: "yu", ョ: "yo" };
const SMALL_V: Record<string, string> = { ァ: "a", ィ: "i", ゥ: "u", ェ: "e", ォ: "o" };

/** かな（カタカナ化済み）をローマ字へ。かな・英数字以外（漢字など）が含まれれば null */
export function toRomaji(raw: string): string | null {
  const s = kanaFold(raw);
  if (!s) return null;
  let out = "";
  let geminate = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    const next = s[i + 1];
    if (/[a-z0-9]/.test(c)) {
      out += c;
      continue;
    }
    if (c === "ッ") {
      geminate = true;
      continue;
    }
    if (c === "ー") continue; // 長音は長さの違いとして無視（コーヒー≒コヒ）
    let syl: string | undefined = BASE[c];
    if (syl === undefined) return null; // 漢字・未対応の文字
    if (next && SMALL_Y[next] && /[キシチニヒミリギジビピ]/.test(c)) {
      const head = syl.slice(0, -1); // ki→k, shi→sh, chi→ch
      const y = SMALL_Y[next];
      syl = /^(sh|ch|j)/.test(head) || c === "ジ" ? head + y.slice(1) : head + y;
      i++;
    } else if (next && SMALL_V[next] && /[ウフヴテデツシジチ]/.test(c)) {
      // ファ・フィ・ウィ・ティ・ヴァ などの外来音
      const v = SMALL_V[next];
      const head = c === "フ" ? "f" : c === "ウ" ? "w" : c === "ヴ" ? "v" : c === "テ" ? "t" : c === "デ" ? "d" : c === "ツ" ? "ts" : c === "シ" ? "sh" : c === "ジ" ? "j" : "ch";
      syl = head + v;
      i++;
    }
    if (geminate) {
      out += syl[0] === "n" || /[aiueo]/.test(syl[0]) ? syl : syl[0] + syl;
      geminate = false;
    } else out += syl;
  }
  return out;
}

/** 厳密な読みの一致用キー（英字・かなを同じ土俵に揃える）。かな・英数字だけの名称で作れる。漢字を含む名称は null */
export function readingKey(raw: string): string | null {
  const r = toRomaji(raw);
  if (!r || r.length < 2) return null;
  // 同じ音の綴りの揺れだけを揃える（ヘボン式の範囲。英語の綴りの推測はしない）
  return r.replace(/ou/g, "o").replace(/oo/g, "o").replace(/uu/g, "u").replace(/(.)\1+/g, "$1").replace(/si/g, "shi").replace(/ti/g, "chi").replace(/tu/g, "tsu").replace(/hu/g, "fu").replace(/zi/g, "ji").replace(/n'/g, "n");
}

/** 英語風の綴りとカタカナの近さを測るための粗い音のキー。ローマ字化できない名称は null */
export function phoneticKey(raw: string): string | null {
  const r = toRomaji(raw);
  if (!r || r.length < 3) return null;
  return r
    .replace(/ph/g, "f")
    .replace(/ck/g, "k")
    .replace(/sh|ch|tsu|ts/g, (m) => (m === "sh" ? "s" : m === "ch" ? "c" : "t"))
    .replace(/gi|ji|zi|di/g, "ji")
    .replace(/[lr]/g, "r")
    .replace(/[fh]/g, "h")
    .replace(/[vb]/g, "b")
    .replace(/[kqc]/g, "k")
    .replace(/[sz]/g, "s")
    .replace(/[td]/g, "t")
    .replace(/[gj]/g, "j")
    .replace(/(.)\1+/g, "$1");
}

function lev(a: string, b: string): number {
  const dp = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array<number>(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) dp[0][j] = j;
  for (let i = 1; i <= a.length; i++) for (let j = 1; j <= b.length; j++) dp[i][j] = Math.min(dp[i - 1][j] + 1, dp[i][j - 1] + 1, dp[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
  return dp[a.length][b.length];
}

/** 2つの名称の音の近さ（0〜1）。どちらかがローマ字化できなければ 0。**候補の発見だけ**に使う（同一とは扱わない） */
export function phoneticSimilarity(a: string, b: string): number {
  const x = phoneticKey(a);
  const y = phoneticKey(b);
  if (!x || !y) return 0;
  // 母音の脱落（フル⇔full）を吸収するため、子音だけの骨格でも比較して高い方を取る
  const skel = (s: string) => s.replace(/[aiueo]/g, "");
  const full = 1 - lev(x, y) / Math.max(x.length, y.length);
  const sk = skel(x).length >= 3 && skel(y).length >= 3 ? 1 - lev(skel(x), skel(y)) / Math.max(skel(x).length, skel(y).length) : 0;
  return Math.max(full, sk * 0.95);
}

/** 音が近い候補とみなす基準（候補の発見用。確定ではない） */
export const PHONETIC_CANDIDATE_MIN = 0.8;
