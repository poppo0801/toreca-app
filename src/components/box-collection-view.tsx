"use client";

import { Ellipsis, FileInput, LayoutGrid, List, Percent, Search, SlidersHorizontal } from "lucide-react";
import { SummaryTriple } from "@/components/summary-triple";
import { useLatestLoader } from "@/components/use-latest-loader";
import { useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState, type Ref } from "react";
import { loadBoxCollectionAction } from "@/app/(app)/collection/box-actions";
import { useApp } from "@/components/app-provider";
import { BoxFormDialog, BoxImportDialog, BoxMultipliersDialog, BoxPriceDialog } from "@/components/box-dialogs";
import { BoxDetailSheet } from "@/components/box-detail-sheet";
import { MarketUpdateDialog } from "@/components/market-update";
import { ProductThumb } from "@/components/product-image";
import { Button } from "@/components/ui/button";
import {
  balancesOf,
  BOX_SORTS,
  BOX_STATE_LABEL,
  BOX_STATES,
  DEFAULT_BOX_FILTERS,
  filterBoxes,
  sortBoxes,
  summarizeBoxes,
  totalsOfBoxes,
  type BoxFilters,
  type BoxSortKey,
} from "@/lib/box-collection";
import type { BoxCollectionData } from "@/lib/server/box-collection-service";
import { DEFAULT_COLLECTION_PREFS, normalizeCollectionPrefs } from "@/lib/profile-settings";
import { cn } from "@/lib/utils";

const yen = (n: number) => `${n.toLocaleString("ja-JP")}円`;
const md = (d: string) => `${Number(d.slice(5, 7))}/${Number(d.slice(8, 10))}`;
const COLS_CLASS = { 3: "grid-cols-3", 4: "grid-cols-4", 5: "grid-cols-5" } as const;
const THUMB_H = { 3: "h-32", 4: "h-24", 5: "h-20" } as const;

export interface BoxPanelHandle {
  openRegister: () => void;
  openPrices: () => void;
}

/**
 * BOXコレクション（Stage 6M）。カードのコレクションと同じ基本デザイン（画像中心の一覧・1行の操作列・1行の集計）。
 * 一覧・集計・並び順・絞り込みはカードのコレクションとは独立している。初期の並びは価格の高い順。
 * 「購入」は購入時点の市場相場（なければ実購入価格）の評価額、「買取」は現在の参考買取相場。収支の支出（実際に支払った額）とは別の数字。
 */
export function BoxCollectionPanel({ ref, onSwitchKind }: { ref?: Ref<BoxPanelHandle>; /** 登録フォーム上部の「カード／BOX」でカードが選ばれた */ onSwitchKind?: () => void }) {
  const { settings, saveSettings } = useApp();
  const prefs = settings.collection ?? DEFAULT_COLLECTION_PREFS;
  const [data, setData] = useState<BoxCollectionData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [filters, setFilters] = useState<BoxFilters>(DEFAULT_BOX_FILTERS);
  const [sort, setSort] = useState<BoxSortKey>("priceDesc");
  const [showSearch, setShowSearch] = useState(false);
  const [showFilters, setShowFilters] = useState(false);
  const [showStats, setShowStats] = useState(false);
  const [showMenu, setShowMenu] = useState(false);
  const [dialog, setDialog] = useState<"form" | "prices" | "mult" | "import" | "market" | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);

  // 取得の順序を保証し、価格の更新後は取得が終わるまで集計を薄く表示する（useLatestLoader）
  const { load, refreshing } = useLatestLoader(loadBoxCollectionAction, setData, setError);
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- 外部データの取得
    void load();
  }, [load]);
  useImperativeHandle(ref, () => ({ openRegister: () => setDialog("form"), openPrices: () => setDialog("prices") }), []);

  const rows = useMemo(() => (data ? summarizeBoxes(data.products, data.lots, balancesOf(data.movements), data.prices, data.settings, data.market) : []), [data]);
  const shown = useMemo(() => sortBoxes(filterBoxes(rows, filters), sort), [rows, filters, sort]);
  const totals = useMemo(() => totalsOfBoxes(rows), [rows]);
  const opened = rows.find((r) => r.productId === openId) ?? null;
  const partial = totals.qty > 0 && (totals.purchaseMissingQty > 0 || totals.buybackMissingQty > 0);
  const activeFilters = filters.state !== "all" ? 1 : 0;
  const cols = prefs.cols;

  return (
    <div className="space-y-3" data-testid="box-collection">
      {data && (
        <section aria-label="保有状況" className="rounded-xl border bg-card text-xs" data-testid="box-summary">
          {/* 購入／買取／BOX数の3分割（カードと共通） */}
          <SummaryTriple
            testId="box-summary-line"
            refreshing={refreshing && !!data}
            expanded={showStats}
            onToggle={() => setShowStats((v) => !v)}
            cells={[
              { label: "購入", value: totals.qty === 0 || totals.purchaseMissingQty === totals.qty ? "—" : yen(totals.purchaseTotal), partial },
              { label: "買取", value: totals.qty === 0 || totals.buybackMissingQty === totals.qty ? "—" : yen(totals.buybackTotal), sub: totals.priceDate ? md(totals.priceDate) : undefined, subTestId: "box-price-date" },
              { label: "BOX", value: `${totals.qty}BOX` },
            ]}
          />
          {showStats && (
            <div className="space-y-1.5 border-t py-2" data-testid="box-stats">
              <dl className="grid grid-cols-2 gap-x-3 gap-y-1">
                <dt className="text-muted-foreground">商品の種類</dt>
                <dd className="text-right tabular-nums">{totals.kinds}種</dd>
                {BOX_STATES.map((s) => {
                  const n = rows.reduce((a, r) => a + r.byState[s], 0);
                  return n > 0 ? (
                    <div key={s} className="contents">
                      <dt className="text-muted-foreground">{BOX_STATE_LABEL[s]}</dt>
                      <dd className="text-right tabular-nums">{n}BOX</dd>
                    </div>
                  ) : null;
                })}
              </dl>
              <p className="text-[11px] text-muted-foreground">購入は購入時点の市場相場（なければ実購入価格）の評価額、買取は現在の参考買取相場です。支出の金額（実際に支払った額）は収支で確認できます。</p>
              {partial && (
                <p className="text-[11px] text-warn" data-testid="box-stats-partial">
                  一部のBOXだけの集計です: 購入時点の価格が未取得 {totals.purchaseMissingQty}BOX・買取相場が未取得 {totals.buybackMissingQty}BOX（未取得は0円とせず、計算に含めていません）。
                </p>
              )}
              {totals.marketQty > 0 && (
                <p className="text-[11px] text-muted-foreground" data-testid="box-stats-market">
                  買取のうち{totals.marketQty}BOXは、手動の相場がないため取得した相場（CSV）で評価しています。詳細で店舗数・取得日時を確認できます。
                </p>
              )}
              {totals.buybackUnconfirmedQty > 0 && <p className="text-[11px] text-warn">シュリンク状態「－」の{totals.buybackUnconfirmedQty}BOXは、基準相場のまま計算しています。</p>}
            </div>
          )}
        </section>
      )}

      <div className="flex items-center gap-1" data-testid="box-toolbar">
        <Button variant="outline" size="icon" className="size-10 shrink-0" aria-pressed={showSearch || filters.q !== ""} aria-label="検索" onClick={() => setShowSearch((v) => !v)}>
          <Search className="size-4" />
        </Button>
        <Button variant="outline" size="icon" className="relative size-10 shrink-0" aria-pressed={showFilters} aria-label="絞り込み" onClick={() => setShowFilters((v) => !v)}>
          <SlidersHorizontal className="size-4" />
          {activeFilters > 0 && <span className="absolute -right-1 -top-1 flex size-4 items-center justify-center rounded-full bg-primary text-[10px] font-bold text-primary-foreground">{activeFilters}</span>}
        </Button>
        <select aria-label="BOXの表示順" value={sort} onChange={(e) => setSort(e.target.value as BoxSortKey)} className="h-10 min-w-0 flex-1 rounded-md border bg-input px-2 text-xs" data-testid="box-sort">
          {BOX_SORTS.map((x) => (
            <option key={x.value} value={x.value}>
              {x.label}
            </option>
          ))}
        </select>
        {prefs.view === "grid" && (
          <Button variant="outline" className="h-10 shrink-0 px-2.5 text-xs" aria-label={`${cols}列表示（タップで切替）`} onClick={() => void saveSettings({ collection: { ...normalizeCollectionPrefs(prefs), cols: cols === 3 ? 4 : cols === 4 ? 5 : 3 } })}>
            {cols}列
          </Button>
        )}
        <div className="relative shrink-0">
          <Button variant="outline" size="icon" className="size-10" aria-haspopup="menu" aria-expanded={showMenu} aria-label="その他" onClick={() => setShowMenu((v) => !v)} data-testid="box-more-menu">
            <Ellipsis className="size-4" />
          </Button>
          {showMenu && (
            <div role="menu" className="absolute right-0 top-11 z-30 w-56 rounded-lg border bg-card p-1 shadow-lg" data-testid="box-more-menu-list">
              <button role="menuitem" type="button" className="flex min-h-10 w-full items-center gap-2 rounded px-2 text-left text-sm hover:bg-muted" onClick={() => (setShowMenu(false), void saveSettings({ collection: { ...normalizeCollectionPrefs(prefs), view: prefs.view === "grid" ? "list" : "grid" } }))}>
                {prefs.view === "grid" ? <List className="size-4" /> : <LayoutGrid className="size-4" />}
                {prefs.view === "grid" ? "テキスト一覧" : "画像一覧"}
              </button>
              <button role="menuitem" type="button" className="flex min-h-10 w-full items-center gap-2 rounded px-2 text-left text-sm hover:bg-muted" data-testid="box-mult-open" onClick={() => (setShowMenu(false), setDialog("mult"))}>
                <Percent className="size-4" /> シュリンク状態の評価倍率
              </button>
              <button role="menuitem" type="button" className="flex min-h-10 w-full items-center gap-2 rounded px-2 text-left text-sm hover:bg-muted" data-testid="box-import-open" onClick={() => (setShowMenu(false), setDialog("import"))}>
                <FileInput className="size-4" /> 購入記録から取り込む{data && data.importable.length > 0 ? `（${data.importable.length}）` : ""}
              </button>
            </div>
          )}
        </div>
      </div>
      {(showSearch || filters.q !== "") && (
        <div className="relative">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" aria-hidden="true" />
          <input type="search" value={filters.q} onChange={(e) => setFilters({ ...filters, q: e.target.value })} placeholder="商品名" aria-label="BOXを検索" className="h-10 w-full rounded-md border bg-input pl-8 pr-2 text-sm" />
        </div>
      )}
      {showFilters && (
        <div role="group" aria-label="絞り込み" className="grid grid-cols-2 gap-1.5 rounded-lg border p-2" data-testid="box-filters">
          <select aria-label="シュリンク状態" value={filters.state} onChange={(e) => setFilters({ ...filters, state: e.target.value as BoxFilters["state"] })} className="h-9 rounded-md border bg-input px-2 text-xs">
            <option value="all">状態: すべて</option>
            {BOX_STATES.map((s) => (
              <option key={s} value={s}>
                {BOX_STATE_LABEL[s]}
              </option>
            ))}
          </select>
          <button type="button" onClick={() => setFilters(DEFAULT_BOX_FILTERS)} className="h-9 rounded-md border text-xs">
            条件をクリア
          </button>
        </div>
      )}

      {error && (
        <p role="alert" className="text-sm text-danger">
          {error}
        </p>
      )}
      {!data && !error && <p className="text-sm text-muted-foreground">読み込み中…</p>}
      {data && shown.length === 0 && (
        <p className="rounded-lg border p-4 text-center text-sm text-muted-foreground" data-testid="box-empty">
          {rows.length === 0 ? "まだBOXが登録されていません。「登録」で手動登録するか、購入記録のBOXが自動で入ります。" : "条件に合うBOXがありません。"}
        </p>
      )}

      {prefs.view === "grid" ? (
        <ul className={cn("grid gap-2", COLS_CLASS[cols])} data-testid="box-grid" data-cols={cols}>
          {shown.map((r) => (
            <li key={r.productId} className="relative select-none" data-testid="box-tile">
              <button type="button" onClick={() => setOpenId(r.productId)} aria-label={`${r.name}の詳細を開く`} className="flex w-full flex-col items-center gap-1 rounded-lg border bg-card p-1.5 active:bg-muted/60">
                <span className="flex w-full items-center justify-center">
                  <ProductThumbById productId={r.productId} heightClass={THUMB_H[cols]} />
                </span>
                <span className="line-clamp-2 w-full text-center text-[10px] leading-tight text-muted-foreground">{r.name}</span>
              </button>
              <span className="pointer-events-none absolute right-2 top-2 rounded-full bg-black/70 px-1.5 text-[10px] font-bold leading-4 text-white" data-testid="box-tile-qty">
                ×{r.qty}
              </span>
              {r.byState.unknown > 0 && (
                <span className="pointer-events-none absolute left-2 top-2 rounded-full bg-card/90 px-1 text-[9px] leading-4 text-warn shadow-sm" data-testid="box-tile-unknown">
                  未確認
                </span>
              )}
            </li>
          ))}
        </ul>
      ) : (
        <ul className="flex flex-col gap-1.5" data-testid="box-list">
          {shown.map((r) => (
            <li key={r.productId} data-testid="box-row">
              <button type="button" onClick={() => setOpenId(r.productId)} className="flex w-full items-center gap-2.5 rounded-xl border bg-card p-2 text-left active:bg-muted/60">
                <span className="flex h-14 w-12 shrink-0 items-center justify-center">
                  <ProductThumbById productId={r.productId} heightClass="h-14" />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-bold">{r.name}</span>
                  <span className="block truncate text-xs text-muted-foreground">
                    {BOX_STATES.filter((s) => r.byState[s] > 0)
                      .map((s) => `${BOX_STATE_LABEL[s]} ${r.byState[s]}`)
                      .join(" ・ ")}
                  </span>
                  <span className="block text-xs">
                    ×{r.qty}BOX
                    <span className="ml-2 text-muted-foreground">買取 {r.buybackTotal === null ? "未取得" : yen(r.buybackTotal)}</span>
                  </span>
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}

      {dialog === "form" && <BoxFormDialog onClose={() => setDialog(null)} onSaved={() => void load()} onSwitchKind={onSwitchKind ? () => (setDialog(null), onSwitchKind()) : undefined} />}
      {dialog === "prices" && data && <BoxPriceDialog rows={sortBoxes(rows, "priceDesc")} prices={data.prices} market={data.market} onOpenMarket={() => setDialog("market")} onClose={() => setDialog(null)} onSaved={() => void load()} />}
      {dialog === "market" && data && <MarketUpdateDialog open onOpenChange={(v) => !v && setDialog(null)} cardCount={0} boxCount={data.products.length} market={[]} lastAt={data.market.reduce<string | null>((a, m) => (!a || m.fetchedAt > a ? m.fetchedAt : a), null)} lastRun={null} onDone={load} />}
      {dialog === "mult" && data && <BoxMultipliersDialog value={data.settings} onClose={() => setDialog(null)} onSaved={(s) => setData((d) => (d ? { ...d, settings: s } : d))} />}
      {dialog === "import" && data && <BoxImportDialog items={data.importable} onClose={() => setDialog(null)} onSaved={() => void load()} />}
      {opened && data && <BoxDetailSheet row={opened} prices={data.prices} market={data.market} status={data.status} settings={data.settings} movements={data.movements} onOpenChange={(v) => !v && setOpenId(null)} onChanged={() => void load()} />}
    </div>
  );
}

function ProductThumbById({ productId, heightClass }: { productId: string; heightClass: string }) {
  const { data } = useApp();
  return <ProductThumb product={data.products.find((p) => p.id === productId)} heightClass={heightClass} />;
}
