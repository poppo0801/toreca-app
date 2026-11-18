/**
 * 商品の同一性判定（Stage 9H-3S・純関数）。名称の類似だけで同一とせず、管理上区別すべき違い（型番・数字・版・BOXとパック）が食い違うときは同一にしない。
 *
 * 同一にしてよい違い（装飾）: ゲーム名・シリーズ名・商品区分の語（productKey が除く）、「購入券・抽選・シュリンク」などの購入形態の語、記号・全半角
 * 同一にしない違い: 型番の不一致／数字（30th・9種・100 など）の不一致／版を表す語（限定・特別・デラックス・通常など）の不一致／BOXとパック単品の不一致
 * 発売時と再販時は、商品としては同一でも抽選は別（再販を示す語は商品の同一性からは除き、`resale` として別に返す。抽選の統合では別扱いにする）。
 */
import { productKey } from "@/lib/lottery-match";

const BRAND = /ポケモンカードゲーム|ポケモンカード|ポケカ|ポケモン|pok[eé]mon/gi;
/** 購入形態・販売状態の語（商品そのものの違いではない） */
const PURCHASE_WORDS = /(購入券|購入権|抽選券|抽選販売|抽選|予約|受付|販売|入荷|再入荷)/g;
const RESALE = /(再販分?|再販売|再録)/;
/** 版・仕様を表す語（食い違えば別商品として扱う） */
const EDITION_WORDS = ["限定", "特別", "スペシャル", "プレミアム", "デラックス", "コンプリート", "通常版", "初回", "特装", "ポケモンセンター", "ポケセン", "セブンイレブン", "コラボ"];
const CODE_RE = /(?<![A-Za-z0-9])([A-Z]{1,5}\d{1,3}[A-Z]?(?:-[A-Z0-9]{1,4})?)(?![A-Za-z0-9])/g;

export interface ProductSignature {
  /** 装飾を除いた照合キー */
  key: string;
  /** 型番（M7・SV11W-D など。大文字・数字の並び） */
  codes: string[];
  /** 名称中の数字（30th・9種・100 など。型番の中の数字は除く） */
  numbers: string[];
  editions: string[];
  form: "box" | "pack" | null;
  /** 再販を示す語がある（抽選は別。商品の同一性には使わない） */
  resale: boolean;
}

export function productSignature(raw: string): ProductSignature {
  const nk = (raw ?? "").normalize("NFKC");
  const codes = [...nk.matchAll(CODE_RE)].map((m) => m[1].toUpperCase());
  const noCodes = codes.reduce((s, c) => s.replace(c, " "), nk);
  // 数量・入数（1BOX・30パック入り・2個 など）は商品の識別ではないので、数字の比較から除く（「9種」「30th」「100」は識別）
  const noQty = noCodes.replace(/\d+\s*(?:パック|box|ボックス|個|枚|本|箱|点)/gi, " ");
  const numbers = [...new Set([...noQty.replace(/\d{4}[/.年]\d{1,2}[/.月]\d{1,2}日?/g, " ").matchAll(/\d+/g)].map((m) => m[0]))].sort();
  const editions = EDITION_WORDS.filter((w) => nk.includes(w));
  const hasBox = /box|ボックス/i.test(nk);
  const hasPack = /(1|１)パック|パック単品|バラパック|単品パック/.test(nk);
  const cleaned = nk.replace(BRAND, " ").replace(PURCHASE_WORDS, " ").replace(RESALE, " ");
  return {
    key: productKey(cleaned),
    codes: [...new Set(codes)].sort(),
    numbers,
    editions,
    form: hasBox && !hasPack ? "box" : hasPack && !hasBox ? "pack" : null,
    resale: RESALE.test(nk),
  };
}

const sameSet = (a: string[], b: string[]) => a.length === b.length && a.every((x, i) => x === b[i]);

/** 識別の食い違い（あれば、名称が似ていても同一にしない）。なければ null */
export function productConflict(a: ProductSignature, b: ProductSignature, o: { lenient?: boolean } = {}): string | null {
  if (a.codes.length && b.codes.length && !sameSet(a.codes, b.codes)) return `型番が異なる（${a.codes.join("/")} と ${b.codes.join("/")}）`;
  if (!sameSet(a.numbers, b.numbers)) return `数字が異なる（${a.numbers.join("/") || "なし"} と ${b.numbers.join("/") || "なし"}）`;
  const ea = [...a.editions].sort();
  const eb = [...b.editions].sort();
  // 候補の検出（lenient）では、一方に版の語が無いだけ（商品区分の一部＝「プレミアムデッキセット」を省いた表記など）は食い違いとしない
  if (!sameSet(ea, eb) && !(o.lenient && (ea.length === 0 || eb.length === 0))) return `版・仕様の語が異なる（${ea.join("/") || "なし"} と ${eb.join("/") || "なし"}）`;
  if (a.form && b.form && a.form !== b.form) return "BOXとパック単品で異なる";
  return null;
}

/** 2つの商品名が同一の商品か（根拠が十分なときだけ true）。部分一致は、短い方が長い方の7割以上のときだけ */
export function sameProductName(a: string, b: string): boolean {
  const x = productSignature(a);
  const y = productSignature(b);
  if (!x.key || !y.key) return false;
  if (productConflict(x, y)) return false;
  if (x.key === y.key) return true;
  const [short, long] = x.key.length <= y.key.length ? [x.key, y.key] : [y.key, x.key];
  return short.length >= 4 && long.includes(short) && short.length / long.length >= 0.7;
}

function longestCommonSubstring(a: string, b: string): number {
  let best = 0;
  let prev = new Array<number>(b.length + 1).fill(0);
  for (let i = 1; i <= a.length; i++) {
    const cur = new Array<number>(b.length + 1).fill(0);
    for (let j = 1; j <= b.length; j++) {
      if (a[i - 1] === b[j - 1]) {
        cur[j] = prev[j - 1] + 1;
        if (cur[j] > best) best = cur[j];
      }
    }
    prev = cur;
  }
  return best;
}

/** 名称が近い（同一とは言えないが、同じ商品かもしれない）か。型番・数字・版が食い違うものは含めない */
export function similarProductName(a: string, b: string): { similar: boolean; reason: string } {
  const x = productSignature(a);
  const y = productSignature(b);
  if (!x.key || !y.key) return { similar: false, reason: "" };
  const conflict = productConflict(x, y, { lenient: true });
  if (conflict) return { similar: false, reason: conflict };
  if (x.key === y.key) return { similar: true, reason: "名称が一致" };
  const [short, long] = x.key.length <= y.key.length ? [x.key, y.key] : [y.key, x.key];
  if (short.length >= 4 && long.includes(short)) return { similar: true, reason: "一方の名称が他方に含まれる" };
  // 共通する最長の連続部分（キャラクター名・サブタイトルなど固有の語）が十分に長く、短い方の半分以上を占める
  const lcs = longestCommonSubstring(x.key, y.key);
  if (lcs >= 6 && lcs / short.length >= 0.5) return { similar: true, reason: `固有の語が共通（${lcs}文字）` };
  const grams = (s: string) => new Set(Array.from({ length: Math.max(0, s.length - 1) }, (_, i) => s.slice(i, i + 2)));
  const ga = grams(x.key);
  const gb = grams(y.key);
  let inter = 0;
  for (const g of ga) if (gb.has(g)) inter++;
  const dice = ga.size + gb.size ? (2 * inter) / (ga.size + gb.size) : 0;
  return dice >= 0.6 ? { similar: true, reason: `名称が近い（類似度 ${dice.toFixed(2)}）` } : { similar: false, reason: "" };
}
