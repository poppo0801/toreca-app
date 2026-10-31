"use client";

import { ArrowDown, ArrowUp, ChartColumn, Ellipsis, LayoutGrid, List, Search, SlidersHorizontal, Sparkles, Star } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";
import { loadCollectionAction, reorderFavoritesAction, setFavoriteAction, type CollectionData } from "@/app/(app)/collection/actions";
import { useApp } from "@/components/app-provider";
import { CardBulkDialog, BULK_MAX_IMAGES } from "@/components/card-bulk";
import { CardDetailSheet } from "@/components/card-detail-sheet";
import { CardFormDialog, type CardFormMode } from "@/components/card-form";
import { Button } from "@/components/ui/button";
import { breakdown, DEFAULT_FILTERS, filterCards, isShine, sortCards, summarizeCards, totalsOf, type CardSummaryRow, type CollectionFilters, type SortKey } from "@/lib/collection";
import { DEFAULT_COLLECTION_PREFS, normalizeCollectionPrefs } from "@/lib/profile-settings";
import { IS_SUPABASE_MODE } from "@/lib/data-source";
import { cn } from "@/lib/utils";

const SORTS: { value: SortKey; label: string }[] = [
  { value: "default", label: "標準（お気に入り→価値の高い順）" },
  { value: "fav", label: "お気に入り順" },
  { value: "valueDesc", label: "参考価値の高い順" },
  { value: "valueAsc", label: "参考価値の低い順" },
  { value: "qty", label: "所持枚数順" },
  { value: "acquired", label: "購入日順" },
  { value: "created", label: "登録日順" },
  { value: "name", label: "カード名順" },
];
const COLS_CLASS = { 3: "grid-cols-3", 4: "grid-cols-4", 5: "grid-cols-5" } as const;
const yen = (n: number) => `${n.toLocaleString("ja-JP")}円`;
const signed = (n: number) => `${n > 0 ? "+" : ""}${n.toLocaleString("ja-JP")}円`;
const PAGE = 60;

/**
 * コレクション（所有カード）。既定は画像グリッド（3〜5列・初期4列）、テキスト一覧にも切り替えられる。
 * 表示（列数・形式・演出）とお気に入りはプロフィールごと。画像はサムネイルを遅延読み込みし、一覧は60件ずつ描画する。
 */
export function CollectionView() {
  const { profile, settings, saveSettings } = useApp();
  const prefs = settings.collection ?? DEFAULT_COLLECTION_PREFS;
  const params = useSearchParams();
  const [data, setData] = useState<CollectionData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [filters, setFilters] = useState<CollectionFilters>(DEFAULT_FILTERS);
  const [sort, setSort] = useState<SortKey>("default");
  const [showFilters, setShowFilters] = useState(false);
  const [showStats, setShowStats] = useState(false);
  const [showSearch, setShowSearch] = useState(false);
  const [showMenu, setShowMenu] = useState(false);
  const [openId, setOpenId] = useState<string | null>(null);
  const [form, setForm] = useState<CardFormMode | null>(null);
  const [bulk, setBulk] = useState<File[] | null>(null);
  const [reorder, setReorder] = useState(false);
  const [limit, setLimit] = useState(PAGE);
  const sentinel = useRef<HTMLDivElement>(null);

  const load = useCallback(async () => {
    const r = await loadCollectionAction();
    if (r.ok) setData(r.data);
    else setError(r.error);
  }, []);
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- 外部データの取得
    void load();
  }, [load]);
  // 表示形式・列数・並びが変わったときだけ、順にフェードインし直す（key が変わると一覧が作り直される）
  const animKey = `${prefs.view}-${prefs.cols}-${filters.favOnly}-${sort}`;

  // 購入記録から「コレクションに追加」で来たとき: 購入情報を引き継いで登録フォームを開く
  const prefilled = useRef(false);
  useEffect(() => {
    if (prefilled.current || params.get("add") !== "1" || !data) return;
    prefilled.current = true;
    const price = Number(params.get("price"));
    const qty = Number(params.get("qty"));
    setForm({
      kind: "new",
      prefill: {
        name: params.get("name") ?? "",
        quantity: Number.isInteger(qty) && qty > 0 ? qty : 1,
        unitPrice: Number.isFinite(price) && params.get("price") ? price : null,
        acquiredOn: /^\d{4}-\d{2}-\d{2}$/.test(params.get("date") ?? "") ? (params.get("date") as string) : "",
        source: params.get("source") ?? "",
        purchaseId: /^[0-9a-f-]{36}$/.test(params.get("purchase") ?? "") ? params.get("purchase") : null,
      },
    });
  }, [params, data]);

  const rows = useMemo(() => (data ? summarizeCards(data.cards, data.holdings, data.prices, data.favorites, profile.id) : []), [data, profile.id]);
  const shown = useMemo(() => sortCards(filterCards(rows, filters), sort), [rows, filters, sort]);
  const totals = useMemo(() => totalsOf(rows), [rows]);
  const rarities = useMemo(() => [...new Set(rows.map((r) => r.rarity).filter(Boolean))].sort(), [rows]);
  const products = useMemo(() => [...new Set(rows.map((r) => r.productName).filter(Boolean))].sort(), [rows]);
  const visible = shown.slice(0, limit);
  const activeFilters = [filters.rarity, filters.product, filters.qty !== "all", filters.priced !== "all", filters.image !== "all"].filter(Boolean).length;

  // 続きを読み込む（一覧の末尾が見えたら60件ずつ増やす）
  useEffect(() => {
    const el = sentinel.current;
    if (!el || visible.length >= shown.length) return;
    const io = new IntersectionObserver((e) => e[0].isIntersecting && setLimit((n) => n + PAGE), { rootMargin: "400px" });
    io.observe(el);
    return () => io.disconnect();
  }, [visible.length, shown.length]);
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- 条件が変わったら先頭から
    setLimit(PAGE);
  }, [filters, sort]);

  const toggleFav = async (id: string, on: boolean) => {
    setData((d) => (d ? { ...d, favorites: on ? [...d.favorites, { profileId: profile.id, cardId: id, rank: 9999 }] : d.favorites.filter((f) => !(f.profileId === profile.id && f.cardId === id)) } : d));
    const r = await setFavoriteAction(profile.id, id, on);
    if (!r.ok) setError(r.error);
    void load();
  };

  const opened = rows.find((r) => r.id === openId) ?? null;
  const favs = shown.filter((r) => r.favRank !== null);
  const moveFav = async (id: string, dir: -1 | 1) => {
    const ids = favs.map((f) => f.id);
    const i = ids.indexOf(id);
    const j = i + dir;
    if (i < 0 || j < 0 || j >= ids.length) return;
    [ids[i], ids[j]] = [ids[j], ids[i]];
    setData((d) => (d ? { ...d, favorites: d.favorites.map((f) => (f.profileId === profile.id && ids.includes(f.cardId) ? { ...f, rank: ids.indexOf(f.cardId) } : f)) } : d));
    await reorderFavoritesAction(profile.id, ids);
    void load();
  };

  if (!IS_SUPABASE_MODE) return <p className="text-sm text-muted-foreground">コレクションはSupabaseモード（ログイン後）でのみ利用できます。</p>;
  const sel = "h-9 rounded-md border bg-input px-2 text-xs";

  return (
    <div className="space-y-3" data-testid="collection">
      <div className="flex items-center gap-2">
        <h1 className="mr-auto text-lg font-bold">コレクション</h1>
        <Button size="sm" onClick={() => setForm({ kind: "new" })} data-testid="add-card">
          ＋カード登録
        </Button>
      </div>

      {data && (
        <section aria-label="保有状況" className="rounded-xl border bg-card px-2.5 text-xs" data-testid="collection-summary">
          <button type="button" onClick={() => setShowStats((v) => !v)} aria-expanded={showStats} className="flex min-h-9 w-full items-center gap-x-2 text-left" data-testid="summary-line">
            <span className="min-w-0 flex-1 truncate font-medium tabular-nums">
              {totals.kinds}種・{totals.qty}枚｜購入額 {totals.qty === 0 ? "—" : yen(totals.costTotal)}｜参考買取 {totals.buybackTotal > 0 || totals.buybackMissingKinds < totals.kinds ? yen(totals.buybackTotal) : "—"}
            </span>
            {(totals.saleMissingKinds > 0 || totals.buybackMissingKinds > 0 || totals.costUnknownQty > 0) && totals.kinds > 0 && <span className="shrink-0 rounded-full border border-warn px-1.5 text-[10px] text-warn">一部のみ</span>}
            <ChartColumn className="size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
          </button>
          {showStats && (
            <div className="space-y-2 border-t py-2" data-testid="collection-stats">
              <dl className="grid grid-cols-2 gap-x-3 gap-y-1">
                <Row k="参考価値（販売）" v={totals.saleTotal > 0 || totals.saleMissingKinds < totals.kinds ? yen(totals.saleTotal) : "—"} />
                <Row k="販売参考との差額" v={totals.saleDiffKinds > 0 ? signed(totals.saleDiff) : "—"} />
                <Row k="買取参考との差額" v={totals.buybackDiffKinds > 0 ? signed(totals.buybackDiff) : "—"} />
              </dl>
              {(totals.saleMissingKinds > 0 || totals.buybackMissingKinds > 0 || totals.costUnknownQty > 0) && (
                <p className="text-[11px] text-warn" data-testid="stats-partial">
                  一部のカードだけの集計です: 販売参考が未設定 {totals.saleMissingKinds}種・買取参考が未設定 {totals.buybackMissingKinds}種・購入金額が未入力 {totals.costUnknownQty}枚（未設定は0円とせず、計算に含めていません）。
                </p>
              )}
              <Breakdown title="レアリティ別" items={breakdown(rows, "rarity")} />
              <Breakdown title="収録商品別" items={breakdown(rows, "productName")} />
            </div>
          )}
        </section>
      )}

      {/* 操作は1行: 検索・絞り込み・並び順・列数・お気に入り・その他（表示形式・演出・並び替え） */}
      <div className="flex items-center gap-1" data-testid="collection-toolbar">
        <Button variant="outline" size="icon" className="size-10 shrink-0" aria-pressed={showSearch || filters.q !== ""} aria-label="検索" onClick={() => setShowSearch((v) => !v)} data-testid="search-toggle">
          <Search className="size-4" />
        </Button>
        <Button variant="outline" size="icon" className="relative size-10 shrink-0" aria-pressed={showFilters} aria-label="絞り込み" onClick={() => setShowFilters((v) => !v)} data-testid="filter-toggle">
          <SlidersHorizontal className="size-4" />
          {activeFilters > 0 && <span className="absolute -right-1 -top-1 flex size-4 items-center justify-center rounded-full bg-primary text-[10px] font-bold text-primary-foreground">{activeFilters}</span>}
        </Button>
        <select aria-label="並び順" value={sort} onChange={(e) => setSort(e.target.value as SortKey)} className="h-10 min-w-0 flex-1 rounded-md border bg-input px-2 text-xs">
          {SORTS.map((x) => (
            <option key={x.value} value={x.value}>
              {x.label}
            </option>
          ))}
        </select>
        {prefs.view === "grid" && (
          <Button variant="outline" className="h-10 shrink-0 px-2.5 text-xs" aria-label={`${prefs.cols}列表示（タップで切替）`} data-testid="cols" data-cols-value={prefs.cols} onClick={() => void saveSettings({ collection: { ...normalizeCollectionPrefs(prefs), cols: prefs.cols === 3 ? 4 : prefs.cols === 4 ? 5 : 3 } })}>
            {prefs.cols}列
          </Button>
        )}
        <Button variant="outline" size="icon" className="size-10 shrink-0" aria-pressed={filters.favOnly} aria-label="お気に入りのみ" onClick={() => setFilters({ ...filters, favOnly: !filters.favOnly })} data-testid="fav-filter">
          <Star className={cn("size-4", filters.favOnly && "fill-primary stroke-primary-ink")} />
        </Button>
        <div className="relative shrink-0">
          <Button variant="outline" size="icon" className="size-10" aria-haspopup="menu" aria-expanded={showMenu} aria-label="その他" onClick={() => setShowMenu((v) => !v)} data-testid="more-menu">
            <Ellipsis className="size-4" />
          </Button>
          {showMenu && (
            <div role="menu" className="absolute right-0 top-11 z-30 w-44 rounded-lg border bg-card p-1 shadow-lg" data-testid="more-menu-list">
              <button role="menuitem" type="button" className="flex min-h-10 w-full items-center gap-2 rounded px-2 text-left text-sm hover:bg-muted" data-testid="view-toggle" onClick={() => (setShowMenu(false), void saveSettings({ collection: { ...normalizeCollectionPrefs(prefs), view: prefs.view === "grid" ? "list" : "grid" } }))}>
                {prefs.view === "grid" ? <List className="size-4" /> : <LayoutGrid className="size-4" />}
                {prefs.view === "grid" ? "テキスト一覧" : "画像一覧"}
              </button>
              <button role="menuitem" type="button" className="flex min-h-10 w-full items-center gap-2 rounded px-2 text-left text-sm hover:bg-muted" data-testid="fx-toggle" onClick={() => (setShowMenu(false), void saveSettings({ collection: { ...normalizeCollectionPrefs(prefs), fx: !prefs.fx } }))}>
                <Sparkles className="size-4" /> 演出 {prefs.fx ? "ON" : "OFF"}
              </button>
              {filters.favOnly && favs.length > 1 && (
                <button role="menuitem" type="button" className="flex min-h-10 w-full items-center gap-2 rounded px-2 text-left text-sm hover:bg-muted" data-testid="reorder-toggle" onClick={() => (setShowMenu(false), setReorder((v) => !v))}>
                  <ArrowUp className="size-4" /> {reorder ? "並び替えを終える" : "お気に入りを並び替え"}
                </button>
              )}
            </div>
          )}
        </div>
      </div>
      {(showSearch || filters.q !== "") && (
        <div className="relative">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" aria-hidden="true" />
          <input type="search" autoFocus={showSearch} value={filters.q} onChange={(e) => setFilters({ ...filters, q: e.target.value })} placeholder="カード名・番号・商品・レアリティ" aria-label="コレクションを検索" className="h-10 w-full rounded-md border bg-input pl-8 pr-2 text-sm" />
        </div>
      )}

      {showFilters && (
        <div role="group" aria-label="絞り込み" className="grid grid-cols-2 gap-1.5 rounded-lg border p-2" data-testid="collection-filters">
          <select aria-label="レアリティ" value={filters.rarity} onChange={(e) => setFilters({ ...filters, rarity: e.target.value })} className={sel}>
            <option value="">レアリティ: すべて</option>
            {rarities.map((r) => (
              <option key={r}>{r}</option>
            ))}
          </select>
          <select aria-label="収録パック" value={filters.product} onChange={(e) => setFilters({ ...filters, product: e.target.value })} className={sel}>
            <option value="">収録パック: すべて</option>
            {products.map((r) => (
              <option key={r}>{r}</option>
            ))}
          </select>
          <select aria-label="所持枚数" value={filters.qty} onChange={(e) => setFilters({ ...filters, qty: e.target.value as CollectionFilters["qty"] })} className={sel}>
            <option value="all">所持枚数: すべて</option>
            <option value="multi">2枚以上</option>
          </select>
          <select aria-label="価格設定" value={filters.priced} onChange={(e) => setFilters({ ...filters, priced: e.target.value as CollectionFilters["priced"] })} className={sel}>
            <option value="all">価格設定: すべて</option>
            <option value="yes">相場あり</option>
            <option value="no">相場なし</option>
          </select>
          <select aria-label="画像設定" value={filters.image} onChange={(e) => setFilters({ ...filters, image: e.target.value as CollectionFilters["image"] })} className={sel}>
            <option value="all">画像設定: すべて</option>
            <option value="yes">画像あり</option>
            <option value="no">画像なし</option>
          </select>
          <button type="button" onClick={() => setFilters(DEFAULT_FILTERS)} className="h-9 rounded-md border text-xs">
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
        <p className="rounded-lg border p-4 text-center text-sm text-muted-foreground" data-testid="collection-empty">
          {rows.length === 0 ? "まだカードが登録されていません。「画像から追加」または「手入力」で登録できます。" : "条件に合うカードがありません。"}
        </p>
      )}

      {reorder && filters.favOnly ? (
        <ul className="divide-y rounded-lg border bg-card" data-testid="reorder-list">
          {favs.map((r, i) => (
            <li key={r.id} className="flex min-h-12 items-center gap-2 px-2">
              <Thumb r={r} url={data?.thumbUrls[r.thumbPath ?? ""] ?? null} size="h-10 w-7" />
              <span className="min-w-0 flex-1 truncate text-sm">{r.name}</span>
              <Button variant="ghost" size="icon" className="size-10" disabled={i === 0} onClick={() => void moveFav(r.id, -1)} aria-label={`${r.name}を上へ`}>
                <ArrowUp className="size-4" />
              </Button>
              <Button variant="ghost" size="icon" className="size-10" disabled={i === favs.length - 1} onClick={() => void moveFav(r.id, 1)} aria-label={`${r.name}を下へ`}>
                <ArrowDown className="size-4" />
              </Button>
            </li>
          ))}
        </ul>
      ) : prefs.view === "grid" ? (
        <ul key={animKey} className={cn("grid gap-2", COLS_CLASS[prefs.cols])} data-testid="card-grid" data-cols={prefs.cols}>
          {visible.map((r, i) => (
            <li key={r.id} className={cn("relative [contain-intrinsic-size:auto_9rem] [content-visibility:auto]", prefs.fx && i < 24 && "card-fade")} style={{ ["--i" as string]: Math.min(i, 24) }} data-testid="card-tile">
              <button type="button" onClick={() => setOpenId(r.id)} aria-label={`${r.name} ${r.rarity}の詳細を開く`} className={cn("relative block w-full overflow-hidden rounded-lg", prefs.fx && isShine(r.rarity) && "card-shine")}>
                <Thumb r={r} url={data?.thumbUrls[r.thumbPath ?? ""] ?? null} size="aspect-[5/7] w-full" />
              </button>
              <button type="button" onClick={() => void toggleFav(r.id, r.favRank === null)} aria-pressed={r.favRank !== null} aria-label={r.favRank !== null ? `${r.name}のお気に入りを外す` : `${r.name}をお気に入りにする`} className="absolute left-0 top-0 flex size-8 items-center justify-center" data-testid="tile-fav">
                <span className="flex size-5 items-center justify-center rounded-full bg-card/85 shadow-sm">
                  <Star className={cn("size-3.5", r.favRank !== null ? "fill-primary stroke-primary-ink" : "stroke-muted-foreground")} aria-hidden="true" />
                </span>
              </button>
              {r.qty > 0 && (
                <span className="pointer-events-none absolute bottom-1 right-1 rounded-full bg-black/70 px-1.5 text-[10px] font-bold leading-4 text-white" data-testid="tile-qty">
                  ×{r.qty}
                </span>
              )}
            </li>
          ))}
        </ul>
      ) : (
        <ul key={animKey} className="space-y-1.5" data-testid="card-list">
          {visible.map((r, i) => (
            <li key={r.id} className={cn("relative [contain-intrinsic-size:auto_4.5rem] [content-visibility:auto]", prefs.fx && i < 24 && "card-fade")} style={{ ["--i" as string]: Math.min(i, 24) }} data-testid="card-row">
              <button type="button" onClick={() => setOpenId(r.id)} className="flex w-full items-center gap-2.5 rounded-xl border bg-card p-2 pr-10 text-left active:bg-muted/60">
                <Thumb r={r} url={data?.thumbUrls[r.thumbPath ?? ""] ?? null} size="h-14 w-10" />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-bold">{r.name}</span>
                  <span className="block truncate text-xs text-muted-foreground">{[r.rarity, r.cardNumber, r.productName].filter(Boolean).join(" ・ ")}</span>
                  <span className="block text-xs">
                    ×{r.qty}
                    <span className="ml-2 text-muted-foreground">買取参考 {r.buyback ? yen(r.buyback.amountYen) : "未設定"}</span>
                  </span>
                </span>
              </button>
              <button type="button" onClick={() => void toggleFav(r.id, r.favRank === null)} aria-pressed={r.favRank !== null} aria-label={r.favRank !== null ? `${r.name}のお気に入りを外す` : `${r.name}をお気に入りにする`} className="absolute right-0 top-0 flex size-11 items-center justify-center">
                <Star className={cn("size-5", r.favRank !== null ? "fill-primary stroke-primary-ink" : "stroke-muted-foreground")} aria-hidden="true" />
              </button>
            </li>
          ))}
        </ul>
      )}
      <div ref={sentinel} aria-hidden="true" />
      {visible.length < shown.length && (
        <Button variant="outline" className="w-full" onClick={() => setLimit((n) => n + PAGE)}>
          もっと見る（{visible.length}/{shown.length}）
        </Button>
      )}

      {opened && data && (
        <CardDetailSheet
          card={opened}
          prices={data.prices}
          allCards={data.cards}
          thumbUrl={data.thumbUrls[opened.thumbPath ?? ""] ?? null}
          favorite={opened.favRank !== null}
          fx={prefs.fx}
          actor={profile.id}
          onOpenChange={(v) => !v && setOpenId(null)}
          onToggleFavorite={() => void toggleFav(opened.id, opened.favRank === null)}
          onChanged={() => void load()}
        />
      )}
      {form && data && <CardFormDialog open onOpenChange={(v) => !v && setForm(null)} mode={form} cards={data.cards} actor={profile.id} onSaved={() => void load()} onBulk={(files) => (setForm(null), setBulk(files.slice(0, BULK_MAX_IMAGES)))} />}
      {bulk && data && <CardBulkDialog open onOpenChange={(v) => !v && setBulk(null)} files={bulk} cards={data.cards} actor={profile.id} onSaved={() => void load()} />}
    </div>
  );
}

function Row({ k, v }: { k: string; v: string }) {
  return (
    <>
      <dt className="text-muted-foreground">{k}</dt>
      <dd className="text-right tabular-nums">{v}</dd>
    </>
  );
}

function Breakdown({ title, items }: { title: string; items: { key: string; kinds: number; qty: number }[] }) {
  if (items.length === 0) return null;
  return (
    <div>
      <p className="text-[11px] font-medium">{title}</p>
      <ul className="flex flex-wrap gap-1 pt-0.5">
        {items.slice(0, 12).map((i) => (
          <li key={i.key} className="rounded-full border px-2 py-0.5 text-[11px]">
            {i.key} {i.qty}枚
          </li>
        ))}
      </ul>
    </div>
  );
}

/** カード画像（縦横比を維持して全体を表示。切り抜かない）。画像が無いときは名前入りのプレースホルダー */
function Thumb({ r, url, size }: { r: CardSummaryRow; url: string | null; size: string }) {
  return (
    <span className={cn("flex items-center justify-center overflow-hidden rounded-lg bg-muted", size)} data-testid="card-thumb">
      {url ? (
        // eslint-disable-next-line @next/next/no-img-element -- 期限つきURLのサムネイル
        <img src={url} alt={r.name} loading="lazy" decoding="async" className="h-full w-full object-contain" />
      ) : (
        <span className="line-clamp-4 px-1 text-center text-[10px] leading-tight text-muted-foreground">{r.name}</span>
      )}
    </span>
  );
}
