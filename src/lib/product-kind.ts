import type { BoxShrinkHint, Chain, ItemUnit, Lottery, Product, ProductKind, ShrinkState } from "@/types/domain";

/**
 * 商品区分ごとの数量の単位と、BOXのシュリンク状態の表記（純関数）。
 *  - 拡張パック: パック／BOX / 構築済みデッキ・プレミアムセット・その他: 個
 *  - 未分類の商品は、従来どおりパック／BOX から選べる（推測で区分を決めない。販売形態が単品・セットと分かっているものは「個」）
 *  - 既存の抽選・購入の単位は変換しない。保存済みの単位が選択肢にないときは、その単位を選択肢に残す（旧データのセットなど）
 */

export const PRODUCT_KIND_LABEL: Record<ProductKind, string> = {
  expansion_pack: "拡張パック",
  deck: "構築済みデッキ",
  premium_set: "プレミアムセット",
  other: "その他",
};
export const PRODUCT_KIND_OPTIONS = (Object.keys(PRODUCT_KIND_LABEL) as ProductKind[]).map((value) => ({ value, label: PRODUCT_KIND_LABEL[value] }));

export const UNIT_NAME: Record<ItemUnit, string> = { box: "BOX", pack: "パック", set: "セット", piece: "個" };

type ProductLike = Pick<Product, "productKind" | "salesForm"> | null | undefined;

/** 区分を決められるときの区分（未分類・商品未選択は null） */
export function kindOf(p: ProductLike): ProductKind | null {
  if (!p) return null;
  if (p.productKind) return p.productKind;
  return p.salesForm === "single_set" ? "other" : null;
}

/** 拡張パックとして扱うか（パック／BOX を選べる商品）。未分類・商品未選択も従来どおり含める */
export function isPackProduct(p: ProductLike): boolean {
  const k = kindOf(p);
  return k === null || k === "expansion_pack";
}

/** 選べる単位。current が選択肢にない旧データ（セットなど）は、変換せず選択肢の末尾に残す */
export function unitOptions(p: ProductLike, current?: ItemUnit): { value: ItemUnit; label: string }[] {
  // 商品が未選択のうちは区分が分からないので、BOX・パック・個のどれも選べる（区分を推測しない）
  const base: ItemUnit[] = !p ? ["box", "pack", "piece"] : isPackProduct(p) ? ["box", "pack"] : ["piece"];
  const list = current && !base.includes(current) ? [...base, current] : base;
  return list.map((value) => ({ value, label: UNIT_NAME[value] }));
}

/** 商品を変えたとき（または新規の行）の単位。いまの単位がその商品で使えるなら維持する */
export function unitForProduct(p: ProductLike, current: ItemUnit): ItemUnit {
  if (isPackProduct(p)) return current === "box" || current === "pack" ? current : "box";
  return "piece";
}

// ---------------------------------------------------------------- BOX販売形態の目安

export const BOX_HINT_LABEL: Record<BoxShrinkHint, string> = {
  shrink: "シュリンクあり",
  no_shrink: "シュリンクなし",
  pack_only: "パックのみ",
  unknown: "不明・未設定",
};
export const BOX_HINT_OPTIONS = (Object.keys(BOX_HINT_LABEL) as BoxShrinkHint[]).map((value) => ({ value, label: BOX_HINT_LABEL[value] }));

/**
 * 抽選カードに出すBOX販売形態の目安。抽選ごとの確定値があればそちらを優先し、なければ系列の目安。
 * 不明・未設定は表示しない（空で返す）。BOX商品のカード詳細だけで使い、実際の受取状態とは別。
 */
export function boxHintOf(lottery: Pick<Lottery, "boxShrinkHint">, chain: Pick<Chain, "boxShrinkHint"> | undefined): { hint: BoxShrinkHint; fromLottery: boolean } | null {
  const own = lottery.boxShrinkHint;
  if (own && own !== "unknown") return { hint: own, fromLottery: true };
  const c = chain?.boxShrinkHint;
  if (c && c !== "unknown") return { hint: c, fromLottery: false };
  return null;
}

export function boxHintLabel(h: { hint: BoxShrinkHint; fromLottery: boolean }): string {
  return `${BOX_HINT_LABEL[h.hint]}${h.fromLottery ? "" : "（目安）"}`;
}

// ---------------------------------------------------------------- 受取時の実際の状態

export const SHRINK_LABEL: Record<ShrinkState, string> = { shrink: "シュリンクあり", no_shrink: "シュリンクなし", unknown: "－" };
export const SHRINK_STATES: ShrinkState[] = ["shrink", "no_shrink", "unknown"];

export interface ReceiptState {
  state: ShrinkState;
  quantity: number;
}

/** 状態ごとの数量の検証。合計が購入数量を超えない・各数量は1以上の整数。問題なければ null */
export function receiptError(states: ReceiptState[], purchased: number): string | null {
  const seen = new Set<string>();
  let total = 0;
  for (const s of states) {
    if (!SHRINK_STATES.includes(s.state)) return "状態が正しくありません";
    if (seen.has(s.state)) return "同じ状態が重複しています";
    seen.add(s.state);
    if (!Number.isInteger(s.quantity) || s.quantity < 1) return "数量は1以上の整数にしてください";
    total += s.quantity;
  }
  if (total > purchased) return `合計が購入数量（${purchased}BOX）を超えています`;
  return null;
}
