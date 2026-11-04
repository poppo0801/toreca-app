/**
 * 一覧の表示から読み取れた事実を、登録済みの抽選と照合する（Stage 5X・純関数）。
 * 商品名と締切日が同じだけでは同じ抽選と断定しない（同じ商品を複数店舗が抽選販売する）。
 * 店舗・商品・締切日の3つがそろって一致したときだけ「同一」とし、一致の根拠を返す。
 */
import { jstDateString } from "@/lib/datetime";
import { normName } from "@/lib/norm";
import type { AppData } from "@/types/domain";

export interface ListFacts {
  store?: string;
  product?: string;
  /** 一覧に表示された応募締切の日付（日本時間 YYYY-MM-DD） */
  dueDate: string | null;
}

/** 括弧書き（最寄り駅など）を除いた比較用の名称 */
const key = (s: string) => normName(s.replace(/[(（][^)）]*[)）]/g, ""));

/** 名称の一致: 完全一致、または一方が他方を含む（短い方が6文字以上。短い名前での部分一致で別店舗・別商品を混同しないため） */
export function sameName(a: string, b: string): boolean {
  const x = key(a);
  const y = key(b);
  if (!x || !y) return false;
  if (x === y) return true;
  const [short, long] = x.length <= y.length ? [x, y] : [y, x];
  return short.length >= 6 && long.includes(short);
}

export interface CrossMatch {
  lotteryId: string;
  evidence: string[];
}

export function matchExistingLottery(f: ListFacts, data: AppData): CrossMatch | null {
  if (!f.store || !f.product || !f.dueDate) return null;
  const hits: CrossMatch[] = [];
  for (const l of data.lotteries) {
    const d = l.applyDeadline;
    const due = d.precision === "date_time" ? jstDateString(new Date(d.at)) : d.precision === "date_only" ? d.date : null;
    if (due !== f.dueDate) continue;
    const store = data.stores.find((s) => s.id === l.storeId);
    if (!store || !sameName(store.name, f.store)) continue;
    const prod = l.items
      .map((it) => data.products.find((p) => p.id === it.productId))
      .find((p) => p && [p.officialName, ...(p.aliases ?? [])].some((n) => sameName(n, f.product!)));
    if (!prod) continue;
    hits.push({ lotteryId: l.id, evidence: [`店舗「${store.name}」が一致`, `商品「${prod.officialName}」が一致`, `応募締切日 ${due} が一致`] });
  }
  // 複数の抽選に一致する場合は断定しない
  return hits.length === 1 ? hits[0] : null;
}
