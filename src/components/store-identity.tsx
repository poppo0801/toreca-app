"use client";

import { useMemo } from "react";
import { useApp } from "@/components/app-provider";
import { ChainLogo } from "@/components/chain-logo";
import { normStore } from "@/lib/zukan/zukan";
import { cn } from "@/lib/utils";

/** 系列名 → ロゴURL（マスター管理の系列ロゴ。別表記も照合）。未登録は null */
export function useChainLogos(): (chainName: string) => string | null {
  let app: { data?: { chains?: { name: string; aliases?: string[]; logoSrc?: string | null; archived?: boolean }[] } } = {};
  try {
    // 毎回同じ順序で呼ばれる（例外はアプリの外のときだけ）。アプリの外ではロゴなしで表示する
    // eslint-disable-next-line react-hooks/rules-of-hooks
    app = useApp() as typeof app;
  } catch {
    /* アプリの外（単体表示・テスト）ではロゴなしで表示する */
  }
  const chains = app.data?.chains;
  const map = useMemo(() => {
    const m = new Map<string, string>();
    for (const c of chains ?? []) {
      if (!c.logoSrc) continue;
      for (const n of [c.name, ...(c.aliases ?? [])]) m.set(normStore(n), c.logoSrc);
    }
    return m;
  }, [chains]);
  return (name) => (name ? (map.get(normStore(name)) ?? null) : null);
}

/**
 * 相場の販売情報の「系列・店舗」表示（相場比較表・各カードの価格一覧で共通）。
 * 系列名（ロゴつき・店舗名より少し太く）の下に店舗名。ロゴが無い系列は、系列名の頭文字の小さなタイルで代替する（レイアウトを揃えるため）。系列が無いときは店舗名だけ。
 */
export function StoreIdentity({ chainName, storeName, className }: { chainName: string; storeName: string; className?: string }) {
  const logoOf = useChainLogos();
  const logo = logoOf(chainName);
  // 店舗名が「系列名＋店舗名」の形なら、系列名の重複を省く
  const c = chainName.trim();
  const store = c && storeName.startsWith(c) && storeName.trim().length > c.length ? storeName.slice(c.length).trim() : storeName;
  return (
    <span className={cn("block min-w-0 text-xs leading-tight", className)} data-testid="store-identity">
      {chainName && (
        <span className="flex min-w-0 items-center gap-1" data-testid="store-chain">
          {logo ? (
            <ChainLogo src={logo} name={chainName} className="!m-0 size-3.5 rounded-[3px]" />
          ) : (
            <span aria-hidden="true" className="flex size-3.5 shrink-0 items-center justify-center rounded-[3px] bg-muted text-[8px] font-bold leading-none text-muted-foreground" data-testid="chain-fallback">
              {[...chainName.trim()][0] ?? ""}
            </span>
          )}
          <span className="min-w-0 truncate text-[11px] font-bold">{chainName}</span>
        </span>
      )}
      <span className="block truncate font-normal">{store}</span>
    </span>
  );
}
