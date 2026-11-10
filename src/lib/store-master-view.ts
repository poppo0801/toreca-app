/**
 * 店舗マスターの系列別一覧（Stage 7N・純関数）。
 *  - 系列は五十音順。店舗は 未確認 → 距離が近い順 → 距離不明（通販を含む） の順
 *  - 検索は 系列名・店舗名・都道府県。系列名に一致したときはその系列の店舗すべてが対象。該当した系列は自動で展開する
 */
import { isMailOrderStore } from "@/lib/store-name";
import { normName } from "@/lib/norm";

export interface MasterStoreRow {
  id: string;
  chain_id: string;
  name: string;
  prefecture: string | null;
  is_provisional: boolean;
  archived_at: string | null;
  sales_kind: string | null;
}
export interface MasterChainRow {
  id: string;
  name: string;
  archived_at: string | null;
}
export interface StoreGroup<S extends MasterStoreRow = MasterStoreRow, C extends MasterChainRow = MasterChainRow> {
  chain: C;
  /** 一覧に出す店舗（検索中は該当した店舗だけ。並び替え済み） */
  stores: S[];
  /** 系列の登録店舗数（検索・非表示の絞り込み前の、表示対象の店舗数） */
  total: number;
  /** 未確認の店舗数 */
  unconfirmed: number;
}

/** 応募時に店舗を選ぶ抽選の仮の店舗（実在の店舗ではない）。店舗マスターの一覧には出さない */
const PLACEHOLDER = "応募時に店舗選択";

export function groupStores<S extends MasterStoreRow, C extends MasterChainRow>(
  chains: C[],
  stores: S[],
  opts: { q: string; showRetired: boolean; distanceKm: (s: S) => number | null; aliases?: Map<string, string[]> },
): StoreGroup<S, C>[] {
  const nq = normName(opts.q);
  const out: StoreGroup<S, C>[] = [];
  const sortedChains = [...chains].filter((c) => opts.showRetired || !c.archived_at).sort((a, b) => a.name.localeCompare(b.name, "ja"));
  for (const chain of sortedChains) {
    const own = stores.filter((s) => s.chain_id === chain.id && s.name !== PLACEHOLDER && (opts.showRetired || !s.archived_at));
    const chainHit = !!nq && [chain.name, ...(opts.aliases?.get(chain.id) ?? [])].some((t) => normName(t).includes(nq));
    const shown = !nq || chainHit ? own : own.filter((s) => normName(s.name).includes(nq) || normName(s.prefecture ?? "").includes(nq));
    if (nq && !chainHit && shown.length === 0) continue;
    out.push({ chain, stores: sortStores(shown, opts.distanceKm), total: own.length, unconfirmed: own.filter((s) => s.is_provisional).length });
  }
  return out;
}

export function sortStores<S extends MasterStoreRow>(list: S[], distanceKm: (s: S) => number | null): S[] {
  const dist = (s: S) => (isMailOrderStore(s.name, s.sales_kind) ? null : distanceKm(s));
  return [...list].sort((a, b) => {
    if (a.is_provisional !== b.is_provisional) return a.is_provisional ? -1 : 1;
    const da = dist(a);
    const db = dist(b);
    if (da !== null && db !== null) return da - db || a.name.localeCompare(b.name, "ja");
    if (da !== null) return -1;
    if (db !== null) return 1;
    return a.name.localeCompare(b.name, "ja");
  });
}
