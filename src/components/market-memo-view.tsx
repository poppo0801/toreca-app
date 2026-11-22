"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Download, Loader2, Plus, Search } from "lucide-react";
import { addMarketPriceAction, buyMarketFromPriceAction, createMarketCardAction, deleteMarketCardAction, deleteMarketPriceAction, exportMarketAction, loadMarketAction, updateMarketCardAction, updateMarketPriceAction, type MarketData } from "@/app/(app)/market-memo/actions";
import { useApp } from "@/components/app-provider";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { DexImage } from "@/components/dex-image";
import { addPricesSequentially, jstToday, PriceForm } from "@/components/price-form";
import { PriceList, type PriceRow } from "@/components/price-list";
import { Button } from "@/components/ui/button";
import { Sheet, SheetBody, SheetContent, SheetDescription, SheetTitle } from "@/components/ui/sheet";
import { dexOfCardName } from "@/lib/zukan/pokemon151";
import type { MarketCard } from "@/lib/zukan/rows";
import { cheapestIds, commonRank, recentStores, sortPrices, type PriceInput } from "@/lib/zukan/zukan";
import { cn } from "@/lib/utils";

const yen = (v: number) => `${v.toLocaleString("ja-JP")}円`;
const cardLabel = (c: Pick<MarketCard, "setName" | "cardNumber" | "rarity">) => [c.setName, c.cardNumber, c.rarity].filter(Boolean).join(" ・ ");

/** 左スワイプで価格追加（タッチ操作）。縦スクロールとは区別する。スワイプが使えない環境でもボタンから同じ操作ができる */
function useSwipeLeft(onSwipe: () => void) {
  const start = useRef<{ x: number; y: number } | null>(null);
  return {
    onTouchStart: (e: React.TouchEvent) => {
      const t = e.touches[0];
      start.current = { x: t.clientX, y: t.clientY };
    },
    onTouchEnd: (e: React.TouchEvent) => {
      const s = start.current;
      start.current = null;
      const t = e.changedTouches[0];
      if (s && t && s.x - t.clientX > 70 && Math.abs(t.clientY - s.y) < 30) onSwipe();
    },
  };
}

interface CardFields {
  name: string;
  setName: string;
  cardNumber: string;
  rarity: string;
  note: string;
}
const emptyCard: CardFields = { name: "", setName: "", cardNumber: "", rarity: "", note: "" };

function CardFieldsForm({ v, onChange }: { v: CardFields; onChange: (v: CardFields) => void }) {
  const set = (k: keyof CardFields, val: string) => onChange({ ...v, [k]: val });
  const field = "mt-0.5 h-10 w-full rounded-md border bg-input px-2.5 text-sm";
  return (
    <div className="grid grid-cols-2 gap-2 rounded-lg border p-2.5" data-testid="market-card-fields">
      <label className="col-span-2 block text-sm">
        <span className="text-[13px] font-medium">カード名</span>
        <input value={v.name} onChange={(e) => set("name", e.target.value)} className={field} maxLength={80} autoComplete="off" data-testid="market-card-name" />
      </label>
      <label className="block text-sm">
        <span className="text-[13px] font-medium">収録セット</span>
        <input value={v.setName} onChange={(e) => set("setName", e.target.value)} className={field} maxLength={120} autoComplete="off" data-testid="market-card-set" />
      </label>
      <div className="grid grid-cols-2 gap-2">
        <label className="block text-sm">
          <span className="text-[13px] font-medium">番号</span>
          <input value={v.cardNumber} onChange={(e) => set("cardNumber", e.target.value)} className={field} maxLength={20} autoComplete="off" data-testid="market-card-number" />
        </label>
        <label className="block text-sm">
          <span className="text-[13px] font-medium">レア</span>
          <input value={v.rarity} onChange={(e) => set("rarity", e.target.value)} className={field} maxLength={10} autoComplete="off" />
        </label>
      </div>
      <label className="col-span-2 block text-sm">
        <span className="text-[13px] font-medium">補足（任意）</span>
        <input value={v.note} onChange={(e) => set("note", e.target.value)} className={field} maxLength={500} autoComplete="off" />
      </label>
    </div>
  );
}

/** カードと最初の価格を一度に登録する。同じカード（セット・番号・レアリティ）が既にあれば、そのカードに価格を追加する。曖昧なときは確認する */
function AddCardSheet({ profileId, today, stores, rank, cards, onDone, onClose }: { profileId: string; today: string; stores: string[]; rank: ReturnType<typeof commonRank>; cards: MarketCard[]; onDone: (cardId: string) => Promise<void>; onClose: () => void }) {
  const [c, setC] = useState<CardFields>(emptyCard);
  const [ambiguous, setAmbiguous] = useState<{ candidates: MarketCard[]; price: PriceInput } | null>(null);
  const [error, setError] = useState<string | null>(null);
  void cards;

  const finish = async (cardId: string, price: PriceInput): Promise<string | null> => {
    const r = await addMarketPriceAction(profileId, cardId, price);
    if (!r.ok) return r.error;
    await onDone(cardId);
    return null;
  };
  const create = async (price: PriceInput, allowAmbiguous: boolean): Promise<string | null> => {
    const r = await createMarketCardAction(profileId, { name: c.name, setName: c.setName, cardNumber: c.cardNumber, rarity: c.rarity, note: c.note }, allowAmbiguous);
    if (!r.ok) {
      if ("ambiguous" in r && r.ambiguous.length > 0) {
        setAmbiguous({ candidates: r.ambiguous, price });
        return null;
      }
      return r.error;
    }
    return finish(r.id, price);
  };

  return (
    <Sheet open onOpenChange={(o) => !o && onClose()}>
      <SheetContent data-testid="market-add-sheet" aria-describedby="market-add-desc">
        <div className="px-4 pb-2">
          <SheetTitle>カードと価格を記録</SheetTitle>
          <SheetDescription id="market-add-desc" className="sr-only">
            カードの情報と店舗の価格を記録します
          </SheetDescription>
        </div>
        <SheetBody className="space-y-2.5 border-t pt-3">
          <CardFieldsForm v={c} onChange={setC} />
          {ambiguous ? (
            <div className="space-y-2 rounded-lg border border-warn p-2.5 text-sm" data-testid="market-ambiguous">
              <p className="text-xs font-bold text-warn">同じカードか判断できません。既存のカードに追加するか、別のカードとして登録してください。</p>
              <ul className="space-y-1">
                {ambiguous.candidates.map((k) => (
                  <li key={k.id} className="flex items-center justify-between gap-2 rounded border px-2 py-1.5">
                    <span className="min-w-0 text-xs">
                      <span className="block truncate font-bold">{k.name}</span>
                      <span className="block truncate text-muted-foreground">{cardLabel(k) || "識別情報なし"}</span>
                    </span>
                    <Button size="sm" className="min-h-9 shrink-0" onClick={async () => setError(await finish(k.id, ambiguous.price))} data-testid="market-use-existing">
                      このカードに追加
                    </Button>
                  </li>
                ))}
              </ul>
              <Button variant="outline" className="min-h-10 w-full" onClick={async () => setError(await create(ambiguous.price, true))} data-testid="market-force-new">
                別のカードとして登録
              </Button>
              <Button variant="ghost" size="sm" onClick={() => setAmbiguous(null)}>
                戻って修正
              </Button>
              {error && (
                <p role="alert" className="text-xs text-danger">
                  {error}
                </p>
              )}
            </div>
          ) : (
            <PriceForm stores={stores} defaultRank={rank} today={today} onCancel={onClose} onSubmit={(price) => create(price, false)} />
          )}
        </SheetBody>
      </SheetContent>
    </Sheet>
  );
}

/** カード詳細: 店舗ごとの価格比較・価格の追加・購入・カード情報の編集と削除 */
function CardSheet({ card, data, profileId, today, stores, rank, reload, onClose }: { card: MarketCard; data: MarketData; profileId: string; today: string; stores: string[]; rank: ReturnType<typeof commonRank>; reload: () => Promise<void>; onClose: () => void }) {
  const prices = data.prices.filter((p) => p.cardId === card.id);
  const bought = new Set(data.purchases.filter((b) => b.cardId === card.id).map((b) => b.priceId));
  const [pricing, setPricing] = useState<{ rec: PriceRow | null } | null>(null);
  const [editCard, setEditCard] = useState<CardFields | null>(null);
  const [delPrice, setDelPrice] = useState<PriceRow | null>(null);
  const [buy, setBuy] = useState<PriceRow | null>(null);
  const [delCard, setDelCard] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submitPrice = async (v: PriceInput): Promise<string | null> => {
    const r = pricing?.rec ? await updateMarketPriceAction(profileId, pricing.rec.id, v) : await addMarketPriceAction(profileId, card.id, v);
    if (!r.ok) return r.error;
    setPricing(null);
    await reload();
    return null;
  };
  return (
    <Sheet open onOpenChange={(o) => !o && onClose()}>
      <SheetContent data-testid="market-sheet" aria-describedby="market-desc">
        <div className="flex items-center gap-2.5 px-4 pb-2">
          {(() => {
            const dex = dexOfCardName(card.name);
            return dex ? <DexImage no={dex.no} name={dex.name} className="size-14" /> : null;
          })()}
          <div className="min-w-0">
            <SheetTitle>{card.name}</SheetTitle>
            <SheetDescription id="market-desc" className="text-xs">
              {cardLabel(card) || "セット・番号は未入力"}
              {card.note ? ` ・ ${card.note}` : ""}
            </SheetDescription>
          </div>
        </div>
        <SheetBody className="space-y-3 border-t pt-3">
          {error && (
            <p role="alert" className="text-xs text-danger">
              {error}
            </p>
          )}
          <div className="flex flex-wrap gap-1.5">
            <Button size="sm" className="min-h-9" onClick={() => setPricing({ rec: null })} data-testid="market-price-add">
              <Plus className="size-4" aria-hidden="true" /> 価格を記録
            </Button>
            <Button size="sm" variant="outline" className="min-h-9" onClick={() => setEditCard({ name: card.name, setName: card.setName, cardNumber: card.cardNumber, rarity: card.rarity, note: card.note })}>
              カード情報を編集
            </Button>
            <Button size="sm" variant="outline" className="min-h-9" onClick={() => setDelCard(true)} data-testid="market-card-delete">
              カードを削除
            </Button>
          </div>
          {editCard && (
            <div className="space-y-2">
              <CardFieldsForm v={editCard} onChange={setEditCard} />
              <div className="flex gap-2">
                <Button variant="outline" className="min-h-10 flex-1" onClick={() => setEditCard(null)}>
                  キャンセル
                </Button>
                <Button
                  className="min-h-10 flex-1"
                  onClick={async () => {
                    const r = await updateMarketCardAction(profileId, card.id, editCard);
                    if (!r.ok) return setError(r.error);
                    setEditCard(null);
                    setError(null);
                    await reload();
                  }}
                >
                  保存
                </Button>
              </div>
            </div>
          )}
          {pricing && (
            <PriceForm
              initial={pricing.rec ? { storeName: pricing.rec.storeName, chainName: pricing.rec.chainName, surveyedOn: pricing.rec.surveyedOn, condition: pricing.rec.condition as never, price: String(pricing.rec.priceYen), note: pricing.rec.note } : undefined}
              stores={stores}
              defaultRank={rank}
              today={today}
              submitLabel={pricing.rec ? "更新する" : "記録する"}
              onCancel={() => setPricing(null)}
              onSubmit={submitPrice}
              onSubmitBatch={async (items) => {
                const res = await addPricesSequentially(items, (v) => addMarketPriceAction(profileId, card.id, v));
                await reload();
                if (res.error) return res.error;
                setPricing(null);
                return null;
              }}
            />
          )}
          <PriceList rows={prices} today={today} boughtIds={bought} onBuy={setBuy} onEdit={(r) => setPricing({ rec: r })} onDelete={setDelPrice} />
        </SheetBody>
      </SheetContent>
      {delPrice && (
        <ConfirmDialog
          testId="del-price"
          title="この価格の記録を削除しますか？"
          description={`${delPrice.storeName}（${delPrice.surveyedOn}）の記録を削除します。購入済みの記録は削除できません。`}
          confirmLabel="削除する"
          danger
          onClose={() => setDelPrice(null)}
          onConfirm={async () => {
            const r = await deleteMarketPriceAction(profileId, delPrice.id);
            if (!r.ok) return r.error;
            await reload();
            return null;
          }}
        />
      )}
      {delCard && (
        <ConfirmDialog
          testId="del-card"
          title="このカードを削除しますか？"
          description="価格の履歴があるカードは削除できません（履歴を失わないため）。"
          confirmLabel="削除する"
          danger
          onClose={() => setDelCard(false)}
          onConfirm={async () => {
            const r = await deleteMarketCardAction(profileId, card.id);
            if (!r.ok) return r.error;
            await reload();
            onClose();
            return null;
          }}
        />
      )}
      {buy && (
        <ConfirmDialog
          testId="buy"
          title="この価格で購入しますか？"
          description={`${buy.storeName}で${yen(buy.priceYen)}（状態${buy.condition}）。購入済みとして記録します。カードと価格の履歴は残ります。`}
          confirmLabel="購入して記録"
          onClose={() => setBuy(null)}
          onConfirm={async () => {
            const r = await buyMarketFromPriceAction(profileId, buy.id, today);
            if (!r.ok) return r.error;
            await reload();
            return null;
          }}
        />
      )}
    </Sheet>
  );
}

function CardRow({ card, data, today, onOpen, onAddPrice }: { card: MarketCard; data: MarketData; today: string; onOpen: () => void; onAddPrice: () => void }) {
  const prices = data.prices.filter((p) => p.cardId === card.id);
  const purchased = data.purchases.some((b) => b.cardId === card.id);
  const best = cheapestIds(prices, today);
  const top = sortPrices(prices.filter((p) => best.has(p.id)), "price")[0];
  const swipe = useSwipeLeft(onAddPrice);
  // 画像: カード名に151のポケモン名が含まれるときだけ（記録は変更しない）。入手状態によらず常に通常の不透明度
  const dex = dexOfCardName(card.name);
  return (
    <li className="flex items-center gap-1.5 rounded-xl border bg-card py-1 pl-2 pr-1" data-testid="market-card" {...swipe}>
      <button type="button" onClick={onOpen} className="flex min-w-0 flex-1 items-center gap-2 py-0.5 text-left" aria-label={`${card.name}の詳細を開く`} data-testid="market-card-open">
        {dex && <DexImage no={dex.no} name={dex.name} className="size-10" />}
        <span className="min-w-0 flex-1">
          <span className="flex items-center gap-1.5">
            <span className="min-w-0 truncate text-sm font-bold">{card.name}</span>
            {purchased && <span className="shrink-0 rounded border border-info px-1 text-[10px] text-info">購入済み</span>}
          </span>
          <span className="block truncate text-[11px] text-muted-foreground">{cardLabel(card) || "セット・番号は未入力"}</span>
        </span>
        <span className="shrink-0 text-right text-xs" data-testid="market-card-summary">
          {top ? (
            <>
              <b className="block text-sm tabular-nums text-success">{yen(top.priceYen)}</b>
              <span className="block max-w-24 truncate text-[10px] text-muted-foreground">
                {top.storeName}・{top.condition}・{prices.length}件
              </span>
            </>
          ) : prices.length > 0 ? (
            <span className="text-muted-foreground">参考価格のみ・{prices.length}件</span>
          ) : (
            <span className="text-muted-foreground">価格なし</span>
          )}
        </span>
      </button>
      <Button variant="outline" size="icon" className="size-10 shrink-0" onClick={onAddPrice} aria-label={`${card.name}に価格を記録`} data-testid="market-card-plus">
        <Plus className="size-5" aria-hidden="true" />
      </Button>
    </li>
  );
}

/** 相場調査メモ（Stage Collection-1）。ポケモンカード全般の店舗価格の記録・比較。現在のプロフィール単位。151図鑑の価格調査とは別の記録 */
export function MarketMemoView() {
  const { profile, now } = useApp();
  const profileId = profile.id;
  const today = jstToday(now);
  const [data, setData] = useState<MarketData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [q, setQ] = useState("");
  const [showBought, setShowBought] = useState(false);
  const [open, setOpen] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [quick, setQuick] = useState<string | null>(null);

  const reload = useCallback(async () => {
    const r = await loadMarketAction(profileId);
    if (r.ok) {
      setData(r.data);
      setError(null);
    } else setError(r.error);
  }, [profileId]);
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- プロフィールの切り替えで読み込み直す
    setData(null);
    void reload();
  }, [reload]);

  const stores = useMemo(() => (data ? recentStores(data.prices) : []), [data]);
  const rank = useMemo(() => (data ? commonRank(data.prices) : null), [data]);
  const cards = useMemo(() => {
    if (!data) return [];
    const boughtCards = new Set(data.purchases.map((b) => b.cardId));
    const k = q.normalize("NFKC").replace(/\s+/g, "").toLowerCase();
    return data.cards.filter((c) => (showBought || !boughtCards.has(c.id)) && (!k || `${c.name}${c.setName}${c.cardNumber}${c.rarity}`.normalize("NFKC").replace(/\s+/g, "").toLowerCase().includes(k)));
  }, [data, q, showBought]);
  const hiddenBought = data ? data.cards.filter((c) => data.purchases.some((b) => b.cardId === c.id)).length : 0;
  const card = data?.cards.find((c) => c.id === (open ?? quick));
  const exportJson = async () => {
    const r = await exportMarketAction(profileId);
    if (!r.ok) return setError(r.error);
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([r.json], { type: "application/json" }));
    a.download = `market-memo-${today}.json`;
    a.click();
    URL.revokeObjectURL(a.href);
  };

  if (error && !data)
    return (
      <p role="alert" className="text-sm text-danger">
        {error}
      </p>
    );
  return (
    <div className="space-y-2.5" data-testid="market-memo">
      <div className="flex items-center gap-1.5">
        <div className="relative min-w-0 flex-1">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" aria-hidden="true" />
          <input type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="カード名・セット・番号" aria-label="カードを検索" className="h-10 w-full rounded-md border bg-input pl-8 pr-2 text-sm" data-testid="market-search" />
        </div>
        <Button variant="outline" size="icon" className="size-10 shrink-0" onClick={() => void exportJson()} aria-label="相場調査メモをエクスポート（JSON）" data-testid="market-export">
          <Download className="size-4" aria-hidden="true" />
        </Button>
        <Button className="size-10 shrink-0 p-0" onClick={() => setAdding(true)} aria-label="カードと価格を記録" data-testid="market-add">
          <Plus className="size-5" aria-hidden="true" />
        </Button>
      </div>
      {hiddenBought > 0 && (
        <label className="flex min-h-8 items-center gap-1.5 text-xs text-muted-foreground">
          <input type="checkbox" checked={showBought} onChange={(e) => setShowBought(e.target.checked)} className="size-4" data-testid="market-show-bought" />
          購入済みのカードも表示（{hiddenBought}件）
        </label>
      )}
      {error && (
        <p role="alert" className="text-xs text-danger">
          {error}
        </p>
      )}
      {!data ? (
        <p className="py-8 text-center text-sm text-muted-foreground">
          <Loader2 className="mr-1 inline size-4 animate-spin" aria-hidden="true" />
          読み込み中…
        </p>
      ) : (
        <ul className="space-y-1.5" aria-label="カード一覧" data-testid="market-list">
          {cards.map((c) => (
            <CardRow key={c.id} card={c} data={data} today={today} onOpen={() => setOpen(c.id)} onAddPrice={() => setQuick(c.id)} />
          ))}
          {cards.length === 0 && (
            <li className={cn("rounded-lg border border-dashed p-6 text-center text-sm text-muted-foreground")}>{data.cards.length === 0 ? "まだカードがありません。右上の＋から、見つけたカードの価格を記録できます。" : "該当するカードがありません。"}</li>
          )}
        </ul>
      )}
      {adding && data && (
        <AddCardSheet
          profileId={profileId}
          today={today}
          stores={stores}
          rank={rank}
          cards={data.cards}
          onClose={() => setAdding(false)}
          onDone={async () => {
            setAdding(false);
            await reload();
          }}
        />
      )}
      {open && card && data && <CardSheet card={card} data={data} profileId={profileId} today={today} stores={stores} rank={rank} reload={reload} onClose={() => setOpen(null)} />}
      {quick && card && data && (
        // 一覧の「＋」・左スワイプ: 価格だけを素早く追加（保存したら元の一覧に戻る）
        <Sheet open onOpenChange={(o) => !o && setQuick(null)}>
          <SheetContent data-testid="market-quick-sheet" aria-describedby="market-quick-desc">
            <div className="px-4 pb-2">
              <SheetTitle>{card.name}の価格を記録</SheetTitle>
              <SheetDescription id="market-quick-desc" className="sr-only">
                店舗・状態・価格を記録します
              </SheetDescription>
            </div>
            <SheetBody className="border-t pt-3">
              <PriceForm
                stores={stores}
                defaultRank={rank}
                today={today}
                onCancel={() => setQuick(null)}
                onSubmitBatch={async (items) => {
                  const res = await addPricesSequentially(items, (v) => addMarketPriceAction(profileId, card.id, v));
                  await reload();
                  if (res.error) return res.error;
                  setQuick(null);
                  return null;
                }}
                onSubmit={async (v) => {
                  const r = await addMarketPriceAction(profileId, card.id, v);
                  if (!r.ok) return r.error;
                  setQuick(null);
                  await reload();
                  return null;
                }}
              />
            </SheetBody>
          </SheetContent>
        </Sheet>
      )}
    </div>
  );
}
