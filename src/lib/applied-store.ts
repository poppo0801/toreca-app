import type { AppData, Lottery } from "@/types/domain";

/** 応募時に店舗を選ぶ抽選の、仮の店舗名（抽選の店舗欄に入る。応募店舗の選択肢には出さない） */
export const SELECT_STORE_PLACEHOLDER = "応募時に店舗選択";

export interface StoreChoice {
  id: string | null;
  name: string;
  prefecture: string;
}

/**
 * 応募時に選べる店舗の候補（Stage 6N）。抽選に店舗一覧が取得済みならそれを、無ければ同じ系列の店舗マスターを候補にする。
 * どちらも無ければ空（手動入力）。仮の店舗は含めない。マスターにある名前は id と都道府県を補う。
 */
export function storeChoices(data: Pick<AppData, "stores">, lottery: Pick<Lottery, "chainId" | "selectableStores">): StoreChoice[] {
  const master = data.stores.filter((s) => s.chainId === lottery.chainId && !s.archived && s.name !== SELECT_STORE_PLACEHOLDER);
  const listed = lottery.selectableStores ?? [];
  if (listed.length > 0) {
    return listed.map((x) => {
      const m = master.find((s) => s.name === x.name);
      return { id: m?.id ?? null, name: x.name, prefecture: x.prefecture || m?.prefecture || "" };
    });
  }
  return master.map((s) => ({ id: s.id, name: s.name, prefecture: s.prefecture }));
}

/** 応募店舗の表示名。未設定は null */
export function appliedStoreLabel(s: { name: string; prefecture: string } | null | undefined): string | null {
  if (!s || !s.name) return null;
  return s.prefecture ? `${s.name}（${s.prefecture}）` : s.name;
}
