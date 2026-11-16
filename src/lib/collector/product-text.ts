/**
 * 商品名と、商品の詳細（価格・購入制限などの説明）の分離・変更の分類（Stage 9H-3I・純関数）。
 *
 * 背景: 調査AIが、ページの商品の行をそのまま商品名として報告し、購入数量・販売価格が商品名に混ざった（別の商品として台帳に加わった）。
 * 商品名・価格・購入制限は別の情報。商品名には正式な名称だけを残し、詳細は別に記録する（捨てない）。
 * 原則: 判断できないときは安全側（停止・確認）。特定の商品・系列に合わせた例外は作らない（詳細を示す語だけで判定する）。
 */
import { productKey } from "@/lib/lottery-match";

/** 商品の詳細（商品名ではない説明。価格・購入制限・数量・入数の表記）の開始を示す語。数量の表記（1BOX・30パック入）は商品名の一部ではない（9H-3J）。商品名の途中にこれらが現れたら、そこから後ろは詳細として分ける */
const DETAIL_START = /(購入可能数|購入可能個数|購入制限|購入上限|購入数量|購入数|販売価格|販売金額|価格|税込|税抜|お一人様|お1人様|一人様|1人様|\d[\d,]*\s*円|※|\(?\d+\s*(?:box|ボックス|箱)\b|\(?\d+\s*(?:パック|個|枚)入り?)/i;

export interface ProductSplit {
  /** 商品名（詳細を除いたもの） */
  name: string;
  /** 分けた詳細（価格・購入制限など）。商品名の別の情報として残す */
  details: string[];
}

export function splitProductDetail(value: string): ProductSplit {
  const v = value.normalize("NFKC").replace(/\s+/g, " ").trim();
  const m = DETAIL_START.exec(v);
  if (!m || m.index === 0) return m && m.index === 0 ? { name: "", details: [v] } : { name: v, details: [] };
  const name = v.slice(0, m.index).replace(/[\s:：・、,\-—]+$/, "").trim();
  const rest = v.slice(m.index).trim();
  return { name, details: rest ? [rest] : [] };
}

/** ゲーム名・ブランド名（ポケモンカードゲーム・Pokemon など）は、どの商品にも付くので、商品の同一性の比較からは除く */
const BRAND = /ポケモンカードゲーム|ポケモンカード|ポケカ|ポケモン|pok[eé]mon/gi;
const isSame = (a: string, b: string): boolean => {
  const x = productKey(a.replace(BRAND, " "));
  const y = productKey(b.replace(BRAND, " "));
  if (!x || !y) return false;
  if (x === y) return true;
  // 一方が他方を含むときも同じ商品とみなすが、短い方が長い方の7割以上のときだけ（「30th CELEBRATION」と「30th CELEBRATION カードセット」のような別商品を同じとしない。安全側）
  const [short, long] = x.length <= y.length ? [x, y] : [y, x];
  return short.length >= 4 && long.includes(short) && short.length / long.length >= 0.7;
};

export type ItemsChangeKind =
  /** 商品名が同じ（表記揺れ・装飾だけの違い） */
  | "same"
  /** 同じ商品に、価格・購入制限などの詳細が付いただけ（商品名は同じ） */
  | "detail_only"
  /** 異なる商品が増えた */
  | "added_different"
  /** 異なる商品に置き換わった（元の商品が無くなった） */
  | "replaced"
  /** 判断できない（商品名が不明など） */
  | "undetermined";

export interface ItemsChange {
  kind: ItemsChangeKind;
  reason: string;
  /** 比較に使った、詳細を除いた商品名 */
  before: string[];
  after: string[];
}

/**
 * 商品の一覧の変更を分類する。before/after は商品名の配列（詳細つきでもよい。詳細は除いて比べる）。
 * 停止の判定: added_different / replaced / undetermined は安全停止の対象。same / detail_only は停止しない。
 */
export function classifyItemsChange(before: string[], after: string[]): ItemsChange {
  const b = before.map((x) => splitProductDetail(x));
  const a = after.map((x) => splitProductDetail(x));
  const bn = b.map((x) => x.name).filter(Boolean);
  const an = a.map((x) => x.name).filter(Boolean);
  if (before.length > 0 && bn.length === 0) return { kind: "undetermined", reason: "変更前の商品名を判断できない", before: bn, after: an };
  if (after.length > 0 && an.length === 0) return { kind: "undetermined", reason: "変更後の商品名を判断できない（説明だけで商品名が無い）", before: bn, after: an };
  if (bn.length === 0 && an.length === 0) return { kind: "same", reason: "どちらも商品名なし", before: bn, after: an };
  if (bn.length === 0) return { kind: "added_different", reason: "商品名が無い状態から商品が加わった", before: bn, after: an };
  // 変更後の各商品が、変更前のどれかと同じ商品か
  const extra = an.filter((n) => !bn.some((o) => isSame(n, o)));
  const lost = bn.filter((o) => !an.some((n) => isSame(n, o)));
  if (extra.length === 0 && lost.length === 0) {
    const detailOnly = a.some((x) => x.details.length > 0) || b.some((x) => x.details.length > 0) || an.length !== bn.length || an.some((n, i) => n !== bn[i]);
    return { kind: detailOnly ? "detail_only" : "same", reason: detailOnly ? "同じ商品。商品名の表記・詳細（価格・購入制限など）の違いだけ" : "同じ商品名", before: bn, after: an };
  }
  if (lost.length > 0 && extra.length > 0) return { kind: "replaced", reason: `別の商品に置き換わった（${lost.join("・")} → ${extra.join("・")}）`, before: bn, after: an };
  if (extra.length > 0) return { kind: "added_different", reason: `異なる商品が増えた（${extra.join("・")}）`, before: bn, after: an };
  return { kind: "replaced", reason: `元の商品が無くなった（${lost.join("・")}）`, before: bn, after: an };
}

/** 停止の対象か。同じ商品の詳細の追加・表記揺れは停止しない。別商品・置き換え・判断不能は停止する */
export const isItemsChangeUnsafe = (c: ItemsChange): boolean => c.kind === "added_different" || c.kind === "replaced" || c.kind === "undetermined";

/** 商品の値（" / " 区切りの複数商品）から、各商品の詳細を除き、同じ商品を1つにまとめる（保存済みの調査結果を、修正後の規則で整えるために使う） */
export function sanitizeItemsValue(value: string): string {
  const out: string[] = [];
  for (const part of value.split(" / ")) {
    const n = splitProductDetail(part).name;
    if (n && !out.some((o) => isSame(o, n))) out.push(n);
  }
  return out.join(" / ");
}
