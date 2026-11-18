/**
 * 自律探索の発見を、既存の登録経路（URLの再解析）へ渡すときの整合確認（Stage 9H-3Q・純関数）。
 * AIの報告をそのまま登録せず、既存の解析がURLを再解析した結果と照合する。食い違うときは、別の抽選として誤登録しないよう登録を見送り、理由を記録する。
 *   系列: 同じ系列であること（表記違いは共通の正規化で同一視）
 *   店舗: 店舗固有の発見は、再解析でも同じ店舗であること（店舗が読み取れない場合は一致と見なさない＝別店舗の告知の取り込みを防ぐ）。店舗選択式は、再解析でも店舗選択式であること
 *   商品: 双方に商品があるとき、少なくとも1つが一致すること
 */
import { sameChainName } from "@/lib/chain-normalize";

export interface IntakeHint {
  chain: string;
  store?: string;
  selectMode: boolean;
  products: string[];
}
export interface ReanalysisView {
  chainName: string;
  storeName: string;
  products: string[];
  /** 再解析が店舗選択式と判断したか（storeName が「応募時に店舗を選択」のとき） */
  selectMode: boolean;
}

const nk = (s: string) => s.normalize("NFKC").replace(/\s+/g, "").toLowerCase();
const storeKey = (s: string) => nk(s).replace(/店$/, "");
const productKey = (s: string) => nk(s).replace(/[【\[（(][^】\]）)]*[】\]）)]/g, "");

export function checkReanalysis(h: IntakeHint, r: ReanalysisView): { ok: true } | { ok: false; reason: string } {
  if (h.chain && r.chainName && !sameChainName(h.chain, r.chainName)) return { ok: false, reason: `再解析の系列（${r.chainName}）がAIの報告（${h.chain}）と一致しません` };
  if (h.selectMode) {
    if (!r.selectMode) return { ok: false, reason: "AIは店舗選択式と報告しましたが、再解析では店舗選択式と確認できません" };
  } else if (h.store) {
    if (r.selectMode || !r.storeName) return { ok: false, reason: "再解析で店舗を確認できません（別店舗の告知の取り込みを防ぐため登録しません）" };
    if (storeKey(h.store) !== storeKey(r.storeName)) return { ok: false, reason: `再解析の店舗（${r.storeName}）がAIの報告（${h.store}）と一致しません` };
  }
  if (h.products.length > 0 && r.products.length > 0 && !h.products.some((a) => r.products.some((b) => productKey(a) && productKey(b) && (productKey(a).includes(productKey(b)) || productKey(b).includes(productKey(a)))))) return { ok: false, reason: "再解析の商品がAIの報告と一致しません" };
  return { ok: true };
}
