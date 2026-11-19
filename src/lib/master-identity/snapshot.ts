/**
 * マスター・抽選・抽選候補のスナップショット（scripts/export-masters-9h3s.mjs の出力）を、名寄せ・再評価の入力へ変換する（純関数）。
 * 本番の読み取り専用の書き出しを、オフラインで分析するための型と変換。
 */
import type { DupMaster } from "./duplicates";

type Row = Record<string, unknown>;
export interface Snapshot {
  exportedAt?: string;
  chains: Row[];
  chain_aliases: Row[];
  stores: Row[];
  products: Row[];
  product_aliases: Row[];
  lotteries: Row[];
  lottery_items: Row[];
  lottery_management: Row[];
  applications: Row[];
  collection_candidates: Row[];
  collection_settings: Row[];
  purchase_items?: Row[];
  sales?: Row[];
  box_lots?: Row[];
  card_masters?: Row[];
  lottery_refs?: Record<string, Record<string, number>>;
}

const s = (v: unknown): string => (typeof v === "string" ? v : "");
const bump = (m: Map<string, number>, k: unknown) => {
  if (typeof k === "string") m.set(k, (m.get(k) ?? 0) + 1);
};

/** 系列を、別名・参照件数つきのマスターへ（参照＝抽選・店舗） */
export function chainMasters(snap: Snapshot): DupMaster[] {
  const refs = new Map<string, number>();
  for (const l of snap.lotteries) bump(refs, l.chain_id);
  for (const st of snap.stores) bump(refs, st.chain_id);
  return snap.chains.map((c) => ({
    id: s(c.id),
    name: s(c.name),
    archived: !!c.archived_at,
    provisional: !!c.is_provisional,
    refs: refs.get(s(c.id)) ?? 0,
    createdAt: s(c.created_at),
    brandGroup: c.brand_group ? s(c.brand_group) : null,
    aliases: snap.chain_aliases.filter((a) => a.chain_id === c.id).map((a) => ({ text: s(a.alias), status: (a.status as "confirmed" | "inferred" | undefined) ?? "confirmed", source: s(a.source) || "legacy" })),
  }));
}

/** 商品を、別名・参照件数つきのマスターへ（参照＝抽選明細・購入明細・売却・BOX・カード） */
export function productMasters(snap: Snapshot): DupMaster[] {
  const refs = new Map<string, number>();
  for (const i of snap.lottery_items) bump(refs, i.product_id);
  for (const t of [snap.purchase_items, snap.sales, snap.box_lots, snap.card_masters]) for (const r of t ?? []) bump(refs, r.product_id);
  return snap.products.map((p) => ({
    id: s(p.id),
    name: s(p.official_name),
    archived: !!p.archived_at,
    provisional: !!p.is_provisional,
    refs: refs.get(s(p.id)) ?? 0,
    createdAt: s(p.created_at),
    code: p.product_code ? s(p.product_code) : null,
    aliases: snap.product_aliases.filter((a) => a.product_id === p.id).map((a) => ({ text: s(a.alias), status: (a.status as "confirmed" | "inferred" | undefined) ?? "confirmed", source: s(a.source) || "legacy" })),
  }));
}
