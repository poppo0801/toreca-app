/**
 * 名称の分解（Stage 9H-3S・純関数）。系列・商品の名寄せの土台。個別の系列名・商品名に依存しない（記号・括弧・区切り・販売チャネル語の扱いだけ）。
 *
 * 複合名称（「A・B」「A（B）」「A／B」）は、各部分（segment）に分けて、それぞれがマスターの正式名・別名に当たるかを調べる。
 * 「全部の部分が同じマスターに当たる」ときだけ、その複合名称を同じマスターとして扱う（部分的な一致では寄せない）。
 */

export type MasterKind = "chain" | "product";

/** 名称の区切り・装飾の記号（長音「ー」は語の一部なので残す） */
const SYMBOLS = /[・･.．,，、。'’"“”`´\-‐–—―_/／\\|｜:：;；!！?？~〜～#＃*＊&＆+＋=＝「」『』【】[\]()（）<>＜＞]/g;

/** 全角半角・大小文字・空白・記号・法人格を除いた照合用の文字列 */
export function foldName(raw: string): string {
  return (raw ?? "")
    .normalize("NFKC")
    .toLowerCase()
    .replace(/株式会社|有限会社|\(株\)/g, "")
    .replace(SYMBOLS, "")
    .replace(/[\s　]+/g, "");
}

/** 販売チャネル・一般的な付記だけの部分（系列・商品の同一性を決めない） */
const GENERIC_SEGMENT = /^(ネット通販|通販|通販サイト|オンライン|オンラインストア|オンラインショップ|公式|公式サイト|公式ストア|公式ショップ|ストア|ショップ|web|ウェブ|本店|店舗|店)$/;

/** 括弧の中身と外側を分け、区切り記号で複合名称を部分に分ける。照合用に fold した部分を返す（重複・空・一般語のみの部分は除く） */
export function nameSegments(raw: string): string[] {
  const nk = (raw ?? "").normalize("NFKC");
  const inner: string[] = [];
  const outer = nk.replace(/[（(［[【〈<「『]([^）)］\]】〉>」』]*)[）)］\]】〉>」』]/g, (_m, g: string) => {
    if (g.trim()) inner.push(g);
    return " ";
  });
  // 空白でも分ける（「A B」「A オンラインストア」）。全ての部分が同じマスターに当たるときだけ寄せるため、分けすぎても誤統合にはならない
  const pieces = [outer, ...inner].flatMap((p) => p.split(/[・･/／|｜,，、&＆+＋]|[\s　]+/));
  const out: string[] = [];
  for (const p of pieces) {
    const f = foldName(p);
    if (!f || GENERIC_SEGMENT.test(f) || out.includes(f)) continue;
    out.push(f);
  }
  return out;
}

/** 名称に使われている「部分」が複数あるか（複合名称か） */
export const isComposite = (raw: string): boolean => nameSegments(raw).length >= 2;
