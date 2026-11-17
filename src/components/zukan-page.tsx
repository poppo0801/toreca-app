"use client";

import { MarketMemoView } from "@/components/market-memo-view";
import { PageHeading } from "@/components/page-heading";
import { ZukanView } from "@/components/zukan-view";
import { IS_SUPABASE_MODE } from "@/lib/data-source";

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
  return (
    <>
      <PageHeading navId="market-memo" className="mb-2">相場調査メモ</PageHeading>
      {IS_SUPABASE_MODE ? <MarketMemoView /> : NEEDS_LOGIN}
    </>
  );
}
