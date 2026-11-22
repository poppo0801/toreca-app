/**
 * 項目と応募先URLの対応（Stage 10S・純関数）。**「リンクが取得できた」ことと「その応募機会のリンクだと証明できた」ことを分ける**。
 *  - リンクの出所（origin）を追跡する: item_entity（項目自身のリンクで、Xの投稿データの展開済みURLと対応づけられた）／item_text_short_unexpanded（項目内の短縮URLで展開結果が無い＝**robots に反して追跡しない**）／parent_card（親投稿のカードに付いたリンク）／parent_shared（親投稿の全項目に共通のリンク）。
 *  - 対応の判定は、店舗名の一致だけを絶対条件にせず、**複数の証拠（支持）と反証**を記録して 確定／候補／不一致／不明 を返す（数値の加点ではなく、証拠の組み合わせ）:
 *      確定: 項目自身のリンクで反証が無い（ページに店舗名が出なくても正当）／ページが項目の店舗を名指し／共通フォームが項目の店舗を選択肢に含む。
 *      不一致: ページが**別の店舗**を名指しし項目の店舗を含まない／別の商品・別の系列・別の開催回を示す。
 *      候補: リンクの出所は項目だが、ページが未確認（取得できていない）など。
 *      不明: 親投稿共通のリンクで、ページが項目の対象範囲を示さない（**無根拠の一括流用は禁止**）／短縮URLの未展開／ページ未取得で出所も不明。
 *  - **他店舗のURLを流用しない**。AIの推測やURL文字列の類似だけでは確定しない（この関数はURLの文字列を比べない）。
 */
import { productCoreKey } from "./product-master";

export type LinkOrigin = "item_entity" | "item_text_short_unexpanded" | "parent_card" | "parent_shared";
export interface ItemLink {
  /** 展開済みのURL（item_text_short_unexpanded のときは短縮URLのまま。追跡しない） */
  url: string;
  origin: LinkOrigin;
  /** 展開に使った元の短縮URL（あれば）。保存・表示ではホストのみ */
  shortUrl?: string;
  /** リンクの出所の記録日時（収集の取得日時） */
  recordedAt: string | null;
}

export type ScopeVerdictKind = "confirmed" | "candidate" | "mismatch" | "unknown";
export interface ScopeVerdict {
  verdict: ScopeVerdictKind;
  supports: string[];
  refutes: string[];
  unknowns: string[];
}

export interface PageForScope {
  head: string;
  lines: string[];
}
export interface ScopeInput {
  link: Pick<ItemLink, "origin">;
  item: { chain: string | null; store: string | null; products: string[]; round?: string | null };
  /** 取得できたページ。null=未取得（取得できなかった・追跡しなかった） */
  page: PageForScope | null;
  /** 同じ親投稿の他の項目の店舗・同じ系列の既知の店舗（別の店舗を名指ししているかの反証用。項目自身の店舗は含めない） */
  otherStores: string[];
  /** 同じ親投稿の他の項目の商品（別の商品のページかの反証用） */
  otherProducts: string[];
  /** 他の系列の名前（別の系列のページかの反証用） */
  otherChains?: string[];
  /** この同じURLが割り当てられている項目の数（共有リンクの検証用） */
  sameUrlItems: number;
}

const norm = (x: string): string => x.normalize("NFKC").toLowerCase().replace(/[ \t\r\n　（）()【】『』「」・\-]/g, "");
/** 名前の一致: 正規化した名前（末尾の「店」つき）か、「店」を除いた3文字以上の名前がページに現れる */
const hasName = (body: string, name: string | null | undefined): boolean => {
  const n = norm(name ?? "");
  const k = n.replace(/店$/, "");
  return n.length >= 3 && (body.includes(n) || (k.length >= 3 && body.includes(k)));
};
const has = (body: string, key: string, min = 3): boolean => key.length >= min && body.includes(key);
const roundOf = (s: string): string | null => /第([0-9０-９一二三四五]+)回/.exec(s.normalize("NFKC"))?.[1] ?? null;

export function judgeLinkScope(i: ScopeInput): ScopeVerdict {
  const supports: string[] = [];
  const refutes: string[] = [];
  const unknowns: string[] = [];
  const o = i.link.origin;
  if (o === "item_text_short_unexpanded") {
    return { verdict: "unknown", supports, refutes, unknowns: ["short_url_not_expanded_not_followed"] };
  }
  const itemScope = o === "item_entity";
  if (itemScope) supports.push("origin_item_scope");
  if (!i.page) {
    unknowns.push("page_not_fetched");
    return { verdict: itemScope ? "candidate" : "unknown", supports, refutes, unknowns: itemScope ? unknowns : [...unknowns, "shared_link_scope_unverified"] };
  }
  const body = norm([i.page.head, ...i.page.lines].join("\n"));
  const st = norm(i.item.store ?? "");
  const storeHit = hasName(body, i.item.store);
  const otherHits = [...new Set(i.otherStores.filter((n) => norm(n) !== st && hasName(body, n)).map((n) => norm(n)))];
  // ---- 反証
  if (!storeHit && otherHits.length > 0) refutes.push("page_names_other_store");
  const chain = norm(i.item.chain ?? "");
  const otherChainHit = (i.otherChains ?? []).map(norm).some((c) => c.length >= 3 && c !== chain && body.includes(c) && !has(body, chain));
  if (otherChainHit) refutes.push("page_names_other_chain");
  const prod = i.item.products.map(productCoreKey).filter((k) => k.length >= 3);
  const prodHit = prod.some((k) => body.includes(k));
  const otherProd = i.otherProducts.map(productCoreKey).filter((k) => k.length >= 3 && !prod.includes(k)).some((k) => body.includes(k));
  if (otherProd && !prodHit && prod.length) refutes.push("page_names_other_product");
  const pr = roundOf(i.page.head + " " + i.page.lines.join(" "));
  if (i.item.round && pr && roundOf(i.item.round) && roundOf(i.item.round) !== pr) refutes.push("page_shows_other_round");
  // ---- 支持
  if (storeHit) supports.push("page_names_item_store");
  if (storeHit && otherHits.length > 0) supports.push("page_lists_item_store_among_options"); // 共通フォームが項目の店舗を含む
  if (prodHit) supports.push("page_names_item_product");
  if (has(body, chain)) supports.push("page_names_item_chain");
  if (!storeHit && otherHits.length === 0 && st.length >= 2) unknowns.push("page_does_not_name_any_store");
  // ---- 判定
  if (refutes.length) return { verdict: "mismatch", supports, refutes, unknowns };
  if (storeHit) return { verdict: "confirmed", supports, refutes, unknowns };
  if (itemScope) return { verdict: "confirmed", supports, refutes, unknowns }; // 店舗名がページに出ない正当なケース（項目自身のリンクで反証なし）
  // 親投稿共通のリンク: ページが項目の対象範囲を示さない限り流用しない
  if (i.sameUrlItems >= 2) return { verdict: "unknown", supports, refutes, unknowns: [...unknowns, "shared_link_scope_unverified"] };
  // 親投稿に1リンクだけで、項目が1つだけ・系列がページに現れる: 候補（確定ではない）
  if (supports.includes("page_names_item_chain")) return { verdict: "candidate", supports, refutes, unknowns };
  return { verdict: "unknown", supports, refutes, unknowns: [...unknowns, "shared_link_scope_unverified"] };
}
