"use client";

import { useState } from "react";
import { MarketMemoView } from "@/components/market-memo-view";
import { PageHeading } from "@/components/page-heading";
import { ZukanView } from "@/components/zukan-view";
import { IS_SUPABASE_MODE } from "@/lib/data-source";
import { marketSortHeading, type MarketSort } from "@/lib/zukan/zukan";

/** 151図鑑・相場調査メモのページ本体。保存先のあるモード（Supabase）でだけ使える */
const NEEDS_LOGIN = <p className="text-sm text-muted-foreground">この機能はSupabaseモード（ログイン後）でのみ利用できます。</p>;

export function ZukanPage() {
  return (
    <>
      <PageHeading navId="zukan" className="mb-2">151図鑑</PageHeading>
      {IS_SUPABASE_MODE ? <ZukanView /> : NEEDS_LOGIN}
    </>
  );
}

export function MarketMemoPage() {
  const [sort, setSort] = useState<MarketSort>("new");
  return (
    <>
      {/* 見出しの右に、現在の並び順を小さく表示（並び替えのたびに即時更新） */}
      <div className="mb-2 flex items-baseline justify-between gap-2">
        <PageHeading navId="market-memo">相場調査メモ</PageHeading>
        {IS_SUPABASE_MODE && (
          <span className="shrink-0 text-[11px] text-muted-foreground" data-testid="market-sort-heading" aria-live="polite">
            {marketSortHeading(sort)}
          </span>
        )}
      </div>
      {IS_SUPABASE_MODE ? <MarketMemoView onSortChange={setSort} /> : NEEDS_LOGIN}
    </>
  );
}
