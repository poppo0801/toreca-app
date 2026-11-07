"use client";

import { useMemo } from "react";
import { useApp } from "@/components/app-provider";
import { MasterCombobox, type MasterRef } from "@/components/master-combobox";
import { normName } from "@/lib/norm";

export interface ChainStoreValue {
  chain: MasterRef;
  store: MasterRef;
}

/**
 * 系列＋店舗の入力（支出登録・BOX登録で共通）。
 *  - 系列: 系列マスターから検索・選択、自由入力。入力が既存の系列名または別名と一致するときは、その系列を選んだ扱いにして重複した系列を作らない
 *  - 店舗: 選んだ系列に紐づく店舗を候補にし、検索・選択・自由入力。店舗名は任意（店舗のない系列は系列のみ）
 *  - 系列を変えたとき、別の系列の店舗が選ばれていたら外す。店舗を選んだとき、系列が違えば系列も合わせる
 */
export function ChainStoreFields({ value, onChange, chainLabel = "系列", storeLabel = "購入店舗" }: { value: ChainStoreValue; onChange: (v: ChainStoreValue) => void; chainLabel?: string; storeLabel?: string }) {
  const { data } = useApp();
  const { chain, store } = value;
  const chainOptions = useMemo(() => data.chains.filter((c) => !c.archived || c.id === chain.id).map((c) => ({ id: c.id, name: c.name })), [data.chains, chain.id]);
  const storeOptions = useMemo(
    () => data.stores.filter((s) => (!s.archived || s.id === store.id) && (!chain.id || s.chainId === chain.id)).map((s) => ({ id: s.id, name: s.name, hint: chain.id ? undefined : data.chains.find((c) => c.id === s.chainId)?.name })),
    [data.stores, data.chains, store.id, chain.id],
  );

  /** 入力された系列名が既存の系列名・別名と（表記ゆれを無視して）一致するなら、その系列にそろえる */
  const canonical = (c: MasterRef): MasterRef => {
    if (c.id || !c.name.trim()) return c;
    const key = normName(c.name);
    const hits = data.chains.filter((x) => !x.archived && [x.name, ...(x.aliases ?? [])].some((n) => normName(n) === key));
    return hits.length === 1 ? { id: hits[0].id, name: hits[0].name } : c;
  };

  const changeChain = (next: MasterRef) => {
    const c = canonical(next);
    let s = store;
    if (store.id) {
      const st = data.stores.find((x) => x.id === store.id);
      if (st && c.id && st.chainId !== c.id) s = { id: null, name: "" };
    }
    onChange({ chain: c, store: s });
  };
  const changeStore = (next: MasterRef) => {
    const st = next.id ? data.stores.find((x) => x.id === next.id) : undefined;
    const c = st && st.chainId !== chain.id ? data.chains.find((x) => x.id === st.chainId) : undefined;
    onChange({ chain: c ? { id: c.id, name: c.name } : chain, store: next });
  };

  return (
    <div className="grid grid-cols-1 gap-2 sm:grid-cols-2" data-testid="chain-store-fields">
      <div className="text-sm">
        {chainLabel}
        <MasterCombobox label={chainLabel} value={chain} options={chainOptions} onChange={changeChain} placeholder="系列を検索または入力" />
      </div>
      <div className="text-sm">
        店舗（任意）
        <MasterCombobox label={storeLabel} value={store} options={storeOptions} onChange={changeStore} placeholder="店舗を検索または入力" />
      </div>
    </div>
  );
}
