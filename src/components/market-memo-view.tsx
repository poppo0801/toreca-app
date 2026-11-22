"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ArrowUpDown, Loader2, Plus, Search, ShoppingBag } from "lucide-react";
import { RankBadge } from "@/components/rank-badge";
import { addMarketPriceAction, buyMarketFromPriceAction, createMarketCardAction, deleteMarketCardAction, deleteMarketPriceAction, loadMarketAction, updateMarketCardAction, updateMarketPriceAction, type MarketData } from "@/app/(app)/market-memo/actions";
import { useApp } from "@/components/app-provider";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { DexImage } from "@/components/dex-image";
import { addPricesSequentially, jstToday, PriceForm, usePriceCandidates } from "@/components/price-form";
import { PriceList, type PriceRow } from "@/components/price-list";
import { Button } from "@/components/ui/button";
import { Sheet, SheetBody, SheetContent, SheetDescription, SheetTitle } from "@/components/ui/sheet";
import { matchPokemonByCardName, pokemonMaster } from "@/lib/zukan/pokemon-match";
import type { MarketCard } from "@/lib/zukan/rows";
import { cheapestRecord, completeSetFromNumber, DEFAULT_RARITY, MARKET_SORT_LABEL, MARKET_SORT_ORDER, numberOptions, setOptions, sortMarketCards, type KnownCard, type MarketSort, type PriceInput } from "@/lib/zukan/zukan";
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
/** 新しいカードの初期値: レアリティは AR（利用者の確定要望） */
const emptyCard: CardFields = { name: "", setName: "", cardNumber: "", rarity: DEFAULT_RARITY, note: "" };

const FIELD = "mt-0.5 h-10 w-full rounded-md border bg-input px-2.5 text-sm";

function CardNameField({ v, onChange }: { v: CardFields; onChange: (v: CardFields) => void }) {
  return (
    <label className="block text-sm">
      <span className="text-[13px] font-medium">カード名</span>
      <input value={v.name} onChange={(e) => onChange({ ...v, name: e.target.value })} className={FIELD} maxLength={80} autoComplete="off" data-testid="market-card-name" />
    </label>
  );
}

/**
 * 収録セット・番号・レアリティ・補足（任意）。収録セットとカード番号は**相互補完**: 番号を入力するとき、その番号を持つ既知のカードのセットが1種類だけなら、空のセットに自動で入る。
 * セットを選ぶと、そのセットの既知の番号が候補に出る。レアリティの初期値は AR。既存の候補から選べ、候補が無ければ手入力。
 */
function CardDetailFields({ v, onChange, known }: { v: CardFields; onChange: (v: CardFields) => void; known: KnownCard[] }) {
  const set = (k: keyof CardFields, val: string) => onChange({ ...v, [k]: val });
  const onNumber = (val: string) => {
    const guess = !v.setName.trim() ? completeSetFromNumber(known, val) : null;
    onChange({ ...v, cardNumber: val, ...(guess ? { setName: guess } : {}) });
  };
  return (
    <div className="grid grid-cols-2 gap-2" data-testid="market-card-fields">
      <label className="block text-sm">
        <span className="text-[13px] font-medium">収録セット（任意）</span>
        <input value={v.setName} onChange={(e) => set("setName", e.target.value)} list="market-set-options" className={FIELD} maxLength={120} autoComplete="off" data-testid="market-card-set" />
        <datalist id="market-set-options">
          {setOptions(known).map((x) => (
            <option key={x} value={x} />
          ))}
        </datalist>
      </label>
      <div className="grid grid-cols-2 gap-2">
        <label className="block text-sm">
          <span className="text-[13px] font-medium">番号</span>
          <input value={v.cardNumber} onChange={(e) => onNumber(e.target.value)} list="market-number-options" className={FIELD} maxLength={20} autoComplete="off" data-testid="market-card-number" />
          <datalist id="market-number-options">
            {numberOptions(known, v.setName).map((x) => (
              <option key={x} value={x} />
            ))}
          </datalist>
        </label>
        <label className="block text-sm">
          <span className="text-[13px] font-medium">レア</span>
          <input value={v.rarity} onChange={(e) => set("rarity", e.target.value)} className={FIELD} maxLength={10} autoComplete="off" data-testid="market-card-rarity" />
        </label>
      </div>
      <label className="col-span-2 block text-sm">
        <span className="text-[13px] font-medium">補足（任意）</span>
        <input value={v.note} onChange={(e) => set("note", e.target.value)} className={FIELD} maxLength={500} autoComplete="off" />
      </label>
    </div>
  );
}

/** カード情報の編集（既存カード）。名前→詳細の順 */
function CardFieldsForm({ v, onChange, known }: { v: CardFields; onChange: (v: CardFields) => void; known: KnownCard[] }) {
  return (
    <div className="space-y-2 rounded-lg border p-2.5">
      <CardNameField v={v} onChange={onChange} />
      <CardDetailFields v={v} onChange={onChange} known={known} />
    </div>
  );
}

type Cand = ReturnType<typeof usePriceCandidates>;
const knownOf = (data: MarketData): KnownCard[] => data.cards.map((c) => ({ setName: c.setName, cardNumber: c.cardNumber, rarity: c.rarity }));

/** カードと最初の価格を一度に登録する。同じカード（セット・番号・レアリティ）が既にあれば、そのカードに価格を追加する。曖昧なときは確認する */
function AddCardSheet({ profileId, today, cand, known, onDone, onClose }: { profileId: string; today: string; cand: Cand; known: KnownCard[]; onDone: (cardId: string) => Promise<void>; onClose: () => void }) {
  const [c, setC] = useState<CardFields>(emptyCard);
  const [ambiguous, setAmbiguous] = useState<{ candidates: MarketCard[]; price: PriceInput } | null>(null);
  const [error, setError] = useState<string | null>(null);

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
          {ambiguous ? (
            <div className="space-y-2 rounded-lg border border-warn p-2.5 text-sm" data-testid="market-ambiguous">
              <CardFieldsForm v={c} onChange={setC} known={known} />
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
            // 入力順: カード名 → 系列 → 店舗 → 調査日 → 価格 → 状態 → 任意（セット・番号・レア・補足・備考）
            <PriceForm {...cand} today={today} top={<CardNameField v={c} onChange={setC} />} optional={<CardDetailFields v={c} onChange={setC} known={known} />} onCancel={onClose} onSubmit={(price) => create(price, false)} />
          )}
        </SheetBody>
      </SheetContent>
    </Sheet>
  );
}

/** カード詳細: 店舗ごとの価格比較・価格の追加・購入・カード情報の編集と削除 */
function CardSheet({ card, data, profileId, today, cand, reload, onClose }: { card: MarketCard; data: MarketData; profileId: string; today: string; cand: Cand; reload: () => Promise<void>; onClose: () => void }) {
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
            const dex = matchPokemonByCardName(card.name);
            return dex ? <DexImage no={dex.no} name={dex.name} className="size-12" /> : null;
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
              <CardFieldsForm v={editCard} onChange={setEditCard} known={knownOf(data)} />
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
              {...cand}
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

/**
 * カード一覧の1行（相場調査メモ）。画像・テキスト・価格を**横方向**に並べ、縦方向の中央で揃える（高さを抑える）:
 *   [左] ポケモン画像（カード名から特定できたときだけ。常に不透明）
 *   [中央] 1行目: カード名（太字）＋セット・番号・レア（小さめ）／ 2行目: 状態バッジ（四角い色分け）＋最安価格の系列 店舗＋記録件数（長い店名は省略せず必要最小限だけ折り返す）
 *   [右] 最安価格（大きく・右端揃え・折り返さない）
 *   カード全体のタップで詳細を開く。価格の追加は詳細から（および左スワイプ）。行に「＋」ボタンは置かない。
 */
function CardRow({ card, data, today, onOpen, onAddPrice }: { card: MarketCard; data: MarketData; today: string; onOpen: () => void; onAddPrice: () => void }) {
  const prices = data.prices.filter((p) => p.cardId === card.id);
  const purchased = data.purchases.some((b) => b.cardId === card.id);
  const top = cheapestRecord(prices, today);
  const swipe = useSwipeLeft(onAddPrice);
  const dex = matchPokemonByCardName(card.name);
  return (
    <li data-testid="market-card" {...swipe}>
      <button type="button" onClick={onOpen} className="flex w-full items-center gap-2 rounded-xl border bg-card px-2 py-1.5 text-left" aria-label={`${card.name}の詳細を開く`} data-testid="market-card-open">
        {dex && <DexImage no={dex.no} name={dex.name} className="size-9" />}
        <span className="min-w-0 flex-1" data-testid="market-card-summary" data-dex={dex?.no ?? ""}>
          <span className="flex items-baseline gap-x-1.5">
            <span className="shrink-0 text-sm font-bold" data-testid="market-card-name-text">
              {card.name}
            </span>
            {/* 表示順: カード名 → レアリティ（太字）→ 収録セット → カード番号（細い線の角丸四角・細い文字）。区切りの「・」は使わない。図鑑No（画像の元）とカード番号は別の情報 */}
            <span className="contents" data-testid="market-card-meta">
              {card.rarity && (
                <b className="shrink-0 text-[11px] font-bold text-foreground" data-testid="row-rarity">
                  {card.rarity}
                </b>
              )}
              {card.setName && <span className="min-w-0 truncate text-[11px] text-muted-foreground" title={card.setName} data-testid="row-set">{card.setName}</span>}
              {card.cardNumber && (
                <span className="shrink-0 rounded-md border border-muted-foreground/40 px-1 text-[10px] font-light leading-4 tabular-nums" data-testid="row-number">
                  {card.cardNumber}
                </span>
              )}
            </span>
            {purchased && <span className="shrink-0 rounded border border-info px-1 text-[10px] text-info">購入済み</span>}
          </span>
          {prices.length > 0 && (
            <span className="mt-0.5 flex items-start gap-1.5 text-[11px] leading-snug text-muted-foreground" data-testid="market-card-store">
              {top ? <RankBadge rank={top.condition} className="mt-px" /> : null}
              <span className="min-w-0 break-words">
                {top ? `${top.chainName && !top.storeName.includes(top.chainName) ? top.chainName + " " : ""}${top.storeName}` : "30日を超えた記録のみ"}
              </span>
            </span>
          )}
        </span>
        {top ? (
          <b className="shrink-0 whitespace-nowrap text-right text-lg font-bold tabular-nums text-success" data-testid="market-card-best">
            {yen(top.priceYen)}
          </b>
        ) : (
          <span className="shrink-0 text-right text-xs text-muted-foreground">{prices.length > 0 ? "参考のみ" : "価格なし"}</span>
        )}
      </button>
    </li>
  );
}

/** 相場調査メモ（Stage Collection-1）。ポケモンカード全般の店舗価格の記録・比較。現在のプロフィール単位。151図鑑の価格調査とは別の記録 */
export function MarketMemoView({ onSortChange }: { onSortChange?: (m: MarketSort) => void } = {}) {
  const { profile, now } = useApp();
  const profileId = profile.id;
  const today = jstToday(now);
  const [data, setData] = useState<MarketData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [q, setQ] = useState("");
  const [showBought, setShowBought] = useState(false);
  const [sort, setSort] = useState<MarketSort>("new");
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

  const cand = usePriceCandidates(data?.prices ?? []);
  const cards = useMemo(() => {
    if (!data) return [];
    const boughtCards = new Set(data.purchases.map((b) => b.cardId));
    const k = q.normalize("NFKC").replace(/\s+/g, "").toLowerCase();
    const shown = data.cards.filter((c) => (showBought || !boughtCards.has(c.id)) && (!k || `${c.name}${c.setName}${c.cardNumber}${c.rarity}`.normalize("NFKC").replace(/\s+/g, "").toLowerCase().includes(k)));
    return sortMarketCards(shown, data.prices, sort, today, (c) => {
      const p = matchPokemonByCardName(c.name);
      const mst = p ? pokemonMaster(p.no) : null;
      return mst ? { no: mst.no, reading: mst.reading } : null;
    });
  }, [data, q, showBought, sort, today]);
  const hiddenBought = data ? data.cards.filter((c) => data.purchases.some((b) => b.cardId === c.id)).length : 0;
  const card = data?.cards.find((c) => c.id === (open ?? quick));
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
        <Button
          variant="outline"
          className="h-10 w-14 shrink-0 flex-col gap-0 px-1 text-[10px] leading-tight"
          onClick={() => {
            const next = MARKET_SORT_ORDER[(MARKET_SORT_ORDER.indexOf(sort) + 1) % MARKET_SORT_ORDER.length];
            setSort(next);
            onSortChange?.(next);
          }}
          aria-label={`並び順: ${MARKET_SORT_LABEL[sort]}（押すと次の並び順）`}
          data-testid="market-sort"
          data-sort={sort}
        >
          <ArrowUpDown className="size-3.5" aria-hidden="true" />
          <span className="max-w-full truncate">{MARKET_SORT_LABEL[sort]}</span>
        </Button>
        <Button
          variant={showBought ? "default" : "outline"}
          size="icon"
          className="relative size-10 shrink-0"
          onClick={() => setShowBought((v) => !v)}
          aria-pressed={showBought}
          aria-label={showBought ? "購入済みのカードを表示中（押すと非表示）" : "購入済みのカードを非表示中（押すと表示）"}
          data-testid="market-show-bought"
        >
          <ShoppingBag className="size-4" aria-hidden="true" />
          {hiddenBought > 0 && <span className="absolute -right-1 -top-1 min-w-4 rounded-full bg-info px-1 text-[10px] font-bold leading-4 text-white">{hiddenBought}</span>}
        </Button>
        <Button className="size-10 shrink-0 p-0" onClick={() => setAdding(true)} aria-label="カードと価格を記録" data-testid="market-add">
          <Plus className="size-5" aria-hidden="true" />
        </Button>
      </div>
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
          cand={cand}
          known={knownOf(data)}
          onClose={() => setAdding(false)}
          onDone={async () => {
            setAdding(false);
            await reload();
          }}
        />
      )}
      {open && card && data && <CardSheet card={card} data={data} profileId={profileId} today={today} cand={cand} reload={reload} onClose={() => setOpen(null)} />}
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
                {...cand}
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
