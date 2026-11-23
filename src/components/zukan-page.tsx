"use client";

import { Suspense, useState } from "react";
import Link from "next/link";
import { MarketDailyView } from "@/components/market-daily-view";
import { MarketMemoView } from "@/components/market-memo-view";
import { PageHeading } from "@/components/page-heading";
import { ZukanView } from "@/components/zukan-view";
import { IS_SUPABASE_MODE } from "@/lib/data-source";
import { marketSortHeading, type MarketSort } from "@/lib/zukan/zukan";

/** 151図鑑・相場調査メモのページ本体。保存先のあるモード（Supabase）でだけ使える */
/** 日別の調査結果（151図鑑・相場調査メモの記録を統合）への入口。両方の画面の見出しの右側に、コンパクトに置く */
function DailyLink() {
  return (
    <Link href="/market-memo/daily" className="inline-flex min-h-8 shrink-0 items-center whitespace-nowrap text-xs font-medium text-info" data-testid="daily-link">
      本日の調査結果 ›
    </Link>
  );
}

export function MarketDailyPage() {
  return IS_SUPABASE_MODE ? <MarketDailyView /> : NEEDS_LOGIN;
}

const NEEDS_LOGIN = <p className="text-sm text-muted-foreground">この機能はSupabaseモード（ログイン後）でのみ利用できます。</p>;

export function ZukanPage() {
  return (
    <>
      <div className="mb-1 flex items-center justify-between gap-2">
        <PageHeading navId="zukan">151図鑑</PageHeading>
        {IS_SUPABASE_MODE && <DailyLink />}
      </div>
      {/* ?edit=（日別の調査結果からの編集）を読むため、Suspense で包む */}
      {IS_SUPABASE_MODE ? (
        <Suspense fallback={null}>
          <ZukanView />
        </Suspense>
      ) : (
        NEEDS_LOGIN
      )}
    </>
  );
}

export function MarketMemoPage() {
  const [sort, setSort] = useState<MarketSort>("new");
  return (
    <>
      {/* 見出しの右に、現在の並び順を小さく表示（並び替えのたびに即時更新） */}
      <div className="mb-1 flex items-center justify-between gap-2">
        <PageHeading navId="market-memo">相場調査メモ</PageHeading>
        {IS_SUPABASE_MODE && (
          <span className="flex min-w-0 items-center gap-2">
            <span className="shrink-0 text-[11px] text-muted-foreground" data-testid="market-sort-heading" aria-live="polite">
              {marketSortHeading(sort)}
            </span>
            <DailyLink />
          </span>
        )}
      </div>
      {IS_SUPABASE_MODE ? (
        <Suspense fallback={null}>
          <MarketMemoView onSortChange={setSort} />
        </Suspense>
      ) : (
        NEEDS_LOGIN
      )}
    </>
  );
}
