/**
 * 商品のTCG種別の判定（Stage 6H・純関数）。ポケモンカード以外の抽選を、AI解析の前後でルール処理だけで除外するために使う。
 *  - 除外するのは「他TCGの語があり、ポケモンカードの語が無い」ときだけ。複数のTCGを同時に案内する投稿（両方の語がある）は除外しない
 *  - どちらの語も無い（種別が分からない）だけでは除外しない
 */
import type { LotteryInput } from "@/lib/lottery-input";

export const POKEMON_TCG = /ポケモンカード|ポケカ|ポケモン\s*(TCG|カード)|Pok[eé]mon\s*(TCG|Card)|拡張パック|ハイクラスパック|強化拡張パック|スタートデッキ|スターターセット|exスペシャル|スペシャルセット/i;

export const OTHER_TCG =
  /遊戯王|遊★戯★王|\bOCG\b|ワンピース\s*カード|ワンピカード|ワンピースTCG|ONE\s*PIECE\s*(CARD|カード|TCG)|ONE\s*PIECE|デュエル・?マスターズ|デュエマ|ヴァイスシュヴァルツ|Weiß|MTG|マジック[：:・]?ザ・?ギャザリング|ドラゴンボール(スーパー)?カード|ドラゴンボールフュージョン|ガンダムカード|ユニオンアリーナ|バトルスピリッツ|バトスピ|ヴァンガード|ディズニー.*カード|Lorcana|ホロライブ.*カード|シャドウバース|ビルディバイド|カードファイト|アニメ.*カードゲーム|\b(OP|EB|PRB)-?\d{2}\b/i;

export type TcgCategory = "pokemon" | "other" | "mixed" | "unknown";

export function judgeTcg(texts: (string | null | undefined)[]): { category: TcgCategory; other: string } {
  const t = texts.filter((x): x is string => !!x).join("\n").normalize("NFKC");
  const pk = POKEMON_TCG.test(t);
  const om = OTHER_TCG.exec(t);
  if (om && pk) return { category: "mixed", other: om[0] };
  if (om) return { category: "other", other: om[0] };
  return { category: pk ? "pokemon" : "unknown", other: "" };
}

/** 判定に使う文字列: 候補の題名・一覧の本文・X投稿の本文・商品名（解析前後どちらでも使える） */
export function tcgTextsOf(parts: { title?: string | null; card?: string | null; context?: string | null; postText?: string | null; quotedText?: string | null; products?: string[] }): string[] {
  return [parts.title, parts.card, parts.context, parts.postText, parts.quotedText, ...(parts.products ?? [])].filter((x): x is string => !!x);
}

export const productNamesOf = (input: Pick<LotteryInput, "items">): string[] => input.items.map((i) => i.product.name).filter(Boolean);

/** 他TCGの除外理由（画面に出す文言） */
export const otherTcgReason = (hit: string) => `ポケモンカード以外のTCGの商品です（${hit.slice(0, 20)}）`;

/**
 * 複数TCGの案内で、他TCGの商品が明細に混ざっているとき、その明細の位置を返す（ポケモンカードの明細だけを残すため）。
 * ポケモンカードと判断できる明細が1つも無いときは空（取りこぼし防止。除外の判定は別に行う）。
 */
export function otherTcgItemIndexes(items: { product: { name: string } }[]): number[] {
  if (items.length < 2) return [];
  const flags = items.map((i) => {
    const n = i.product.name.normalize("NFKC");
    return OTHER_TCG.test(n) && !POKEMON_TCG.test(n);
  });
  const others = flags.flatMap((f, k) => (f ? [k] : []));
  return others.length === 0 || others.length === items.length ? [] : others;
}
