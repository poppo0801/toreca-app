/**
 * 複数商品の抽選の統合判断（Stage 9C・純関数）。楽天ブックスのように、同じ期間・同じ条件で複数商品を対象にした抽選が
 * 商品ごとの別告知として届くことがある。同一企画と言える根拠があるときだけ、既存の1枚のカードに商品を追加する（新規カードを作らない）。
 *
 * 統合しない（null）条件: 応募の単位が商品別／期間・条件が異なる／系列・店舗が違う／根拠が無い（同系列・同期間というだけ）／既に全商品が登録済み
 * 根拠（どれか1つ）: 同じ情報源URL／告知に複数商品を対象とする記載／系列の傾向（複数商品の企画がある系列。参考情報）＋期間・条件の一致
 *   ※系列の傾向だけでは決めない。期間（応募開始・締切）と応募条件が一致することが前提
 */
import type { LotteryInput } from "@/lib/lottery-input";
import type { Lottery, LotteryItem } from "@/types/domain";
import { hasTrait, type ChainKnowledge } from "@/lib/collector/knowledge/chain-knowledge";
import { flexToJstDate } from "@/lib/finance";

export interface MultiProductPlan {
  lotteryId: string;
  addItems: { productId: string; quantity: number; unit: LotteryItem["unit"] }[];
  reason: string;
  evidence: string[];
}

const PER_PRODUCT_TEXT = /商品(ごと|別|毎)(に|の)?(応募|抽選|申込|エントリー)|(各|それぞれの)商品(で|に)(応募|抽選)/;
const MULTI_PRODUCT_TEXT = /(以下|下記|次)の(商品|対象商品)(が|を|は)?.{0,6}(対象|抽選)|対象商品(は|：|:).{0,40}(、|・|\/|／)|(複数|全)商品(が|を|で)?.{0,6}(対象|抽選)|商品(を)?(それぞれ|同時)(に)?(応募|抽選)/;

const sameSet = (a: string[] = [], b: string[] = []): boolean => a.length === b.length && [...a].sort().join("|") === [...b].sort().join("|");

export function planMultiProduct(
  input: Pick<LotteryInput, "chain" | "store" | "items" | "applyStart" | "applyDeadline" | "requirementTags" | "sourceUrls">,
  lotteries: Lottery[],
  ctx: { knowledge?: ChainKnowledge | null; texts?: string[]; applyUnit?: string },
): MultiProductPlan | null {
  if (!input.chain.id || !input.store.id || input.items.length === 0) return null;
  if (input.items.some((i) => !i.product.id)) return null;
  const text = (ctx.texts ?? []).filter(Boolean).join("\n").normalize("NFKC");
  // 応募の単位が商品別なら、無理に統合しない
  if (ctx.applyUnit === "per_product" || PER_PRODUCT_TEXT.test(text)) return null;
  const myDeadline = input.applyDeadline.precision === "unknown" ? null : input.applyDeadline.date || null;
  const myStart = input.applyStart.precision === "unknown" ? null : input.applyStart.date || null;
  if (!myDeadline) return null; // 期間が確認できないものは、同じ期間とは言えない
  const myUrls = new Set(input.sourceUrls ?? []);
  const newIds = input.items.map((i) => i.product.id as string);
  let best: MultiProductPlan | null = null;
  for (const l of lotteries) {
    if (l.chainId !== input.chain.id || l.storeId !== input.store.id) continue;
    if (l.sourceKind !== "auto") continue; // 自動収集で登録した抽選だけ（手動で登録・編集した抽選に商品を足さない）
    const has = new Set(l.items.map((i) => i.productId));
    const toAdd = input.items.filter((i) => !has.has(i.product.id as string));
    if (toAdd.length === 0) continue;
    const theirDeadline = l.applyDeadline ? flexToJstDate(l.applyDeadline) : null;
    const theirStart = l.applyStart ? flexToJstDate(l.applyStart) : null;
    if (theirDeadline !== myDeadline) continue;
    if (myStart && theirStart && myStart !== theirStart) continue;
    // 応募条件が同じ（条件の分類・購入制限）。違いが読み取れるときは統合しない
    if (!sameSet(input.requirementTags as string[], l.requirementTags as string[])) continue;
    const evidence: string[] = [`同じ系列・同じ店舗・同じ応募締切（${myDeadline}）・同じ応募条件`];
    const sameUrl = l.sourceUrls.some((u) => myUrls.has(u));
    const multiText = MULTI_PRODUCT_TEXT.test(text);
    const knowsMulti = hasTrait(ctx.knowledge, "multi_product_events");
    if (sameUrl) evidence.push("同じ情報源URL");
    if (multiText) evidence.push("告知に複数商品を対象とする記載がある");
    if (knowsMulti) evidence.push("この系列は同一企画で複数商品を扱うことがある（参考情報）");
    // 根拠: 同じURL・複数商品の記載のどちらか、または系列の傾向（期間・条件の一致が前提）
    if (!sameUrl && !multiText && !knowsMulti) continue;
    const plan: MultiProductPlan = { lotteryId: l.id, addItems: toAdd.map((i) => ({ productId: i.product.id as string, quantity: i.quantity, unit: i.unit })), reason: `同一企画の複数商品として、既存の抽選に商品を追加します（${evidence.join("・")}）`, evidence };
    if (!best || plan.evidence.length > best.evidence.length) best = plan;
    void newIds;
  }
  return best;
}
