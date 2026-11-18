"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Check, ChevronDown, Download, Loader2, Plus } from "lucide-react";
import { buyZukanFromPriceAction, addZukanPriceAction, deleteZukanCardAction, deleteZukanPriceAction, exportZukanAction, loadZukanAction, saveZukanCardAction, updateZukanPriceAction, type ZukanData } from "@/app/(app)/zukan/actions";
import { useApp } from "@/components/app-provider";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { jstToday, PriceForm } from "@/components/price-form";
import { PriceList, type PriceRow } from "@/components/price-list";
import { Button } from "@/components/ui/button";
import { Sheet, SheetBody, SheetContent, SheetDescription, SheetTitle } from "@/components/ui/sheet";
import { dexLabel, pokemonOf } from "@/lib/zukan/pokemon151";
import type { ZukanPriceRecord } from "@/lib/zukan/rows";
import { ACQUIRE_LABEL, commonRank, parseAmount, RANKS, recentStores, resolveAcquire, zukanRows, zukanStats, type AcquireMethod, type ZukanCard, type ZukanFilter } from "@/lib/zukan/zukan";
import { cn } from "@/lib/utils";

const yen = (v: number) => `${v.toLocaleString("ja-JP")}円`;

interface CardForm {
  cardName: string;
  setName: string;
  cardNumber: string;
  rarity: string;
  quantity: string;
  acquiredOn: string;
  method: AcquireMethod | "";
  amount: string;
  storeName: string;
  condition: string;
  memo: string;
}

/** 収集カードの入力。購入金額が空欄ならパック開封、入力があれば単品購入（明示した入手方法と矛盾するときは保存前に止める）。未入力は0円にしない */
function CardEditor({ initial, pokemonName, today, onSubmit, onCancel }: { initial: CardForm; pokemonName: string; today: string; onSubmit: (f: CardForm) => Promise<string | null>; onCancel: () => void }) {
  const [f, setF] = useState<CardForm>(initial);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const set = <K extends keyof CardForm>(k: K, v: CardForm[K]) => setF((c) => ({ ...c, [k]: v }));
  const field = "mt-0.5 h-10 w-full rounded-md border bg-input px-2.5 text-sm";
  const amount = parseAmount(f.amount);
  // 入手方法の表示: 明示的な選択がなければ、金額から決まる方法を示す
  const shown = f.method || (amount === null ? "pack_opening" : amount === "invalid" ? "" : "single_purchase");

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (busy) return;
    if (amount === "invalid") return setError("購入金額は0以上の整数で入力してください（空欄＝パック開封）");
    const r = resolveAcquire(amount, f.method || null);
    if (!r.ok) return setError(r.error);
    setBusy(true);
    setError(null);
    const err = await onSubmit({ ...f, method: r.method });
    setBusy(false);
    if (err) setError(err);
  };
  return (
    <form onSubmit={submit} noValidate className="space-y-2.5 rounded-lg border bg-card p-3" data-testid="card-form">
      <p className="text-xs text-muted-foreground">{pokemonName}のカードを登録します。</p>
      <label className="block text-sm">
        <span className="text-[13px] font-medium">カード名</span>
        <input value={f.cardName} onChange={(e) => set("cardName", e.target.value)} className={field} maxLength={80} autoComplete="off" data-testid="card-name" />
      </label>
      <label className="block text-sm">
        <span className="text-[13px] font-medium">収録商品・カードセット</span>
        <input value={f.setName} onChange={(e) => set("setName", e.target.value)} className={field} maxLength={120} autoComplete="off" />
      </label>
      <div className="grid grid-cols-3 gap-2">
        <label className="col-span-2 block text-sm">
          <span className="text-[13px] font-medium">カード番号</span>
          <input value={f.cardNumber} onChange={(e) => set("cardNumber", e.target.value)} className={field} maxLength={20} autoComplete="off" />
        </label>
        <label className="block text-sm">
          <span className="text-[13px] font-medium">レアリティ</span>
          <input value={f.rarity} onChange={(e) => set("rarity", e.target.value)} className={field} maxLength={10} autoComplete="off" />
        </label>
      </div>
      <div className="grid grid-cols-2 gap-2">
        <label className="block text-sm">
          <span className="text-[13px] font-medium">入手日</span>
          <input type="date" value={f.acquiredOn} onChange={(e) => set("acquiredOn", e.target.value)} className={field} max={today} />
        </label>
        <label className="block text-sm">
          <span className="text-[13px] font-medium">枚数</span>
          <input value={f.quantity} onChange={(e) => set("quantity", e.target.value)} inputMode="numeric" className={field} data-testid="card-qty" />
        </label>
      </div>
      <div className="text-sm">
        <span className="text-[13px] font-medium">入手方法</span>
        <div role="radiogroup" aria-label="入手方法" className="mt-0.5 grid grid-cols-2 gap-1" data-testid="card-method">
          {(["single_purchase", "pack_opening"] as const).map((m) => (
            <button key={m} type="button" role="radio" aria-checked={shown === m} onClick={() => set("method", m)} className={cn("min-h-10 rounded-md border text-sm", shown === m ? "border-primary bg-primary text-primary-foreground" : "text-muted-foreground")}>
              {ACQUIRE_LABEL[m]}
            </button>
          ))}
        </div>
      </div>
      <label className="block text-sm">
        <span className="text-[13px] font-medium">購入金額（1枚あたり・円）</span>
        <input value={f.amount} onChange={(e) => set("amount", e.target.value)} inputMode="numeric" className={field} placeholder="空欄＝パック開封（0円ではありません）" data-testid="card-amount" />
      </label>
      <div className="grid grid-cols-2 gap-2">
        <label className="block text-sm">
          <span className="text-[13px] font-medium">購入店舗（任意）</span>
          <input value={f.storeName} onChange={(e) => set("storeName", e.target.value)} className={field} maxLength={80} autoComplete="off" />
        </label>
        <label className="block text-sm">
          <span className="text-[13px] font-medium">状態（任意）</span>
          <select value={f.condition} onChange={(e) => set("condition", e.target.value)} className={field}>
            <option value="">未設定</option>
            {RANKS.map((r) => (
              <option key={r}>{r}</option>
            ))}
          </select>
        </label>
      </div>
      <label className="block text-sm">
        <span className="text-[13px] font-medium">メモ</span>
        <input value={f.memo} onChange={(e) => set("memo", e.target.value)} className={field} maxLength={500} autoComplete="off" />
      </label>
      {error && (
        <p role="alert" className="text-xs text-danger" data-testid="card-error">
          {error}
        </p>
      )}
      <div className="flex gap-2">
        <Button type="button" variant="outline" className="min-h-10 flex-1" onClick={onCancel} disabled={busy}>
          キャンセル
        </Button>
        <Button type="submit" className="min-h-10 flex-1" disabled={busy} data-testid="card-submit">
          {busy && <Loader2 className="size-4 animate-spin" aria-hidden="true" />} 保存
        </Button>
      </div>
    </form>
  );
}

const emptyForm = (today: string, name = ""): CardForm => ({ cardName: name, setName: "", cardNumber: "", rarity: "", quantity: "1", acquiredOn: today, method: "", amount: "", storeName: "", condition: "", memo: "" });
const formOf = (c: ZukanCard): CardForm => ({ cardName: c.cardName, setName: c.setName, cardNumber: c.cardNumber, rarity: c.rarity, quantity: String(c.quantity), acquiredOn: c.acquiredOn ?? "", method: c.acquireMethod, amount: c.purchaseAmountYen === null ? "" : String(c.purchaseAmountYen), storeName: c.storeName, condition: c.condition, memo: c.memo });

interface CardInfo {
  cardName: string;
  setName: string;
  cardNumber: string;
  rarity: string;
}

/** 価格調査の対象カードの情報（カード名・収録セット・カード番号・レアリティ） */
function CardInfoFields({ v, onChange }: { v: CardInfo; onChange: (v: CardInfo) => void }) {
  const set = (k: keyof CardInfo, val: string) => onChange({ ...v, [k]: val });
  const field = "mt-0.5 h-10 w-full rounded-md border bg-input px-2.5 text-sm";
  return (
    <div className="grid grid-cols-2 gap-2 rounded-lg border p-2" data-testid="price-card-info">
      <label className="col-span-2 block text-sm">
        <span className="text-[13px] font-medium">カード名</span>
        <input value={v.cardName} onChange={(e) => set("cardName", e.target.value)} className={field} maxLength={80} autoComplete="off" />
      </label>
      <label className="block text-sm">
        <span className="text-[13px] font-medium">収録セット</span>
        <input value={v.setName} onChange={(e) => set("setName", e.target.value)} className={field} maxLength={120} autoComplete="off" />
      </label>
      <div className="grid grid-cols-2 gap-2">
        <label className="block text-sm">
          <span className="text-[13px] font-medium">番号</span>
          <input value={v.cardNumber} onChange={(e) => set("cardNumber", e.target.value)} className={field} maxLength={20} autoComplete="off" />
        </label>
        <label className="block text-sm">
          <span className="text-[13px] font-medium">レア</span>
          <input value={v.rarity} onChange={(e) => set("rarity", e.target.value)} className={field} maxLength={10} autoComplete="off" />
        </label>
      </div>
    </div>
  );
}

/** ポケモン1匹の詳細（収集カード・価格調査） */
function PokemonSheet({ no, data, profileId, today, reload, onClose }: { no: number; data: ZukanData; profileId: string; today: string; reload: () => Promise<void>; onClose: () => void }) {
  const p = pokemonOf(no)!;
  const cards = data.cards.filter((c) => c.dexNo === no);
  const prices = data.prices.filter((r) => r.dexNo === no);
  const [editing, setEditing] = useState<{ id: string | null; form: CardForm } | null>(null);
  const [pricing, setPricing] = useState<{ rec: ZukanPriceRecord | null } | null>(null);
  const [delCard, setDelCard] = useState<ZukanCard | null>(null);
  const [delPrice, setDelPrice] = useState<PriceRow | null>(null);
  const [buy, setBuy] = useState<PriceRow | null>(null);
  const bought = new Set(cards.map((c) => c.priceRecordId).filter((x): x is string => !!x));
  const stores = useMemo(() => recentStores(data.prices), [data.prices]);
  const rank = useMemo(() => commonRank(data.prices), [data.prices]);
  const [info, setInfo] = useState<CardInfo>({ cardName: p.name, setName: "", cardNumber: "", rarity: "" });

  const saveCard = async (f: CardForm): Promise<string | null> => {
    const amount = parseAmount(f.amount);
    const r = await saveZukanCardAction(profileId, editing?.id ?? null, {
      dexNo: no,
      cardName: f.cardName,
      setName: f.setName,
      cardNumber: f.cardNumber,
      rarity: f.rarity,
      quantity: Number(f.quantity.normalize("NFKC")) || 0,
      acquiredOn: f.acquiredOn,
      acquireMethod: (f.method || (amount === null ? "pack_opening" : "single_purchase")) as AcquireMethod,
      purchaseAmountYen: amount === "invalid" ? null : amount,
      storeName: f.storeName,
      condition: f.condition as never,
      memo: f.memo,
    });
    if (!r.ok) return r.error;
    setEditing(null);
    await reload();
    return null;
  };

  return (
    <Sheet open onOpenChange={(o) => !o && onClose()}>
      <SheetContent data-testid="zukan-sheet" aria-describedby="zukan-desc">
        <div className="px-4 pb-2">
          <SheetTitle>
            {dexLabel(no)} {p.name}
          </SheetTitle>
          <SheetDescription id="zukan-desc" className="sr-only">
            {p.name}のカードの登録と価格調査
          </SheetDescription>
        </div>
        <SheetBody className="space-y-4 border-t pt-3">
          <section aria-label="収集カード" className="space-y-1.5">
            <div className="flex items-center justify-between">
              <h3 className="text-sm font-bold">収集カード（{cards.reduce((a, c) => a + c.quantity, 0)}枚）</h3>
              <Button size="sm" className="min-h-9" onClick={() => setEditing({ id: null, form: emptyForm(today, p.name) })} data-testid="card-add">
                <Plus className="size-4" aria-hidden="true" /> カードを登録
              </Button>
            </div>
            {editing && <CardEditor initial={editing.form} pokemonName={p.name} today={today} onSubmit={saveCard} onCancel={() => setEditing(null)} />}
            <ul className="space-y-1.5">
              {cards.map((c) => (
                <li key={c.id} className="rounded-lg border px-2.5 py-2 text-sm" data-testid="zukan-card">
                  <div className="flex flex-wrap items-center gap-x-2">
                    <span className="font-bold">{c.cardName}</span>
                    <span className="text-xs text-muted-foreground">{[c.setName, c.cardNumber, c.rarity].filter(Boolean).join(" ・ ")}</span>
                  </div>
                  <p className="text-xs text-muted-foreground" data-testid="zukan-card-meta">
                    {c.quantity}枚 ・ {ACQUIRE_LABEL[c.acquireMethod]}
                    {c.purchaseAmountYen !== null ? ` ${yen(c.purchaseAmountYen)}/枚` : ""}
                    {c.acquiredOn ? ` ・ ${c.acquiredOn}` : ""}
                    {c.storeName ? ` ・ ${c.storeName}` : ""}
                    {c.condition ? ` ・ ${c.condition}` : ""}
                    {c.memo ? ` ・ ${c.memo}` : ""}
                  </p>
                  <div className="mt-1 flex gap-1.5">
                    <Button size="sm" variant="outline" className="min-h-9" onClick={() => setEditing({ id: c.id, form: formOf(c) })}>
                      編集
                    </Button>
                    <Button size="sm" variant="outline" className="min-h-9" onClick={() => setDelCard(c)} data-testid="card-delete">
                      削除
                    </Button>
                  </div>
                </li>
              ))}
              {cards.length === 0 && !editing && <li className="text-xs text-muted-foreground">まだ登録がありません。</li>}
            </ul>
          </section>

          <section aria-label="価格調査" className="space-y-1.5">
            <div className="flex items-center justify-between">
              <h3 className="text-sm font-bold">価格調査</h3>
              <Button size="sm" variant="outline" className="min-h-9" onClick={() => setPricing({ rec: null })} data-testid="price-add">
                <Plus className="size-4" aria-hidden="true" /> 価格を記録
              </Button>
            </div>
            {pricing && (
              <div className="space-y-1.5">
                {!pricing.rec && <CardInfoFields v={info} onChange={setInfo} />}
                <PriceForm
                  initial={pricing.rec ? { storeName: pricing.rec.storeName, chainName: pricing.rec.chainName, surveyedOn: pricing.rec.surveyedOn, condition: pricing.rec.condition as never, price: String(pricing.rec.priceYen), note: pricing.rec.note } : undefined}
                  stores={stores}
                  defaultRank={rank}
                  today={today}
                  submitLabel={pricing.rec ? "更新する" : "記録する"}
                  onCancel={() => setPricing(null)}
                  onSubmit={async (v) => {
                    const r = pricing.rec ? await updateZukanPriceAction(profileId, pricing.rec.id, v) : await addZukanPriceAction(profileId, no, { cardName: info.cardName || p.name, setName: info.setName, cardNumber: info.cardNumber, rarity: info.rarity }, v);
                    if (!r.ok) return r.error;
                    setPricing(null);
                    await reload();
                    return null;
                  }}
                />
              </div>
            )}
            <PriceList rows={prices} today={today} boughtIds={bought} onBuy={setBuy} onEdit={(r) => setPricing({ rec: prices.find((x) => x.id === r.id) ?? null })} onDelete={setDelPrice} />
          </section>
        </SheetBody>
      </SheetContent>
      {delCard && (
        <ConfirmDialog
          testId="del-card"
          title="このカードを削除しますか？"
          description={`「${delCard.cardName}」の登録（${delCard.quantity}枚）を削除します。図鑑の収集カードだけが削除され、価格調査の履歴・他の購入記録には影響しません。`}
          confirmLabel="削除する"
          danger
          onClose={() => setDelCard(null)}
          onConfirm={async () => {
            const r = await deleteZukanCardAction(profileId, delCard.id);
            if (!r.ok) return r.error;
            await reload();
            return null;
          }}
        />
      )}
      {delPrice && (
        <ConfirmDialog
          testId="del-price"
          title="この価格の記録を削除しますか？"
          description={`${delPrice.storeName}（${delPrice.surveyedOn}）の記録を削除します。購入済みのカードは残ります。`}
          confirmLabel="削除する"
          danger
          onClose={() => setDelPrice(null)}
          onConfirm={async () => {
            const r = await deleteZukanPriceAction(profileId, delPrice.id);
            if (!r.ok) return r.error;
            await reload();
            return null;
          }}
        />
      )}
      {buy && (
        <ConfirmDialog
          testId="buy"
          title="この価格で購入しますか？"
          description={`${buy.storeName}で${yen(buy.priceYen)}（状態${buy.condition}）。図鑑の収集カードとして登録し、単品購入金額に加わります。価格調査の記録は残ります。`}
          confirmLabel="購入して登録"
          onClose={() => setBuy(null)}
          onConfirm={async () => {
            const r = await buyZukanFromPriceAction(profileId, buy.id, today);
            if (!r.ok) return r.error;
            await reload();
            return null;
          }}
        />
      )}
    </Sheet>
  );
}

/** 151図鑑（Stage Collection-1）。全国図鑑No.001〜151の一覧・収集状況・カード登録・価格調査。現在のプロフィール単位 */
export function ZukanView() {
  const { profile, now } = useApp();
  const profileId = profile.id;
  const today = jstToday(now);
  const [data, setData] = useState<ZukanData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<ZukanFilter>("all");
  const [open, setOpen] = useState<number | null>(null);
  const [detail, setDetail] = useState(false);

  const reload = useCallback(async () => {
    const r = await loadZukanAction(profileId);
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

  const stats = useMemo(() => (data ? zukanStats(data.cards) : null), [data]);
  const rows = useMemo(() => (data ? zukanRows(data.cards, filter) : []), [data, filter]);
  const exportJson = async () => {
    const r = await exportZukanAction(profileId);
    if (!r.ok) return setError(r.error);
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([r.json], { type: "application/json" }));
    a.download = `zukan-${today}.json`;
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
    <div className="space-y-3" data-testid="zukan">
      <section aria-label="収集状況" className="rounded-xl border bg-card text-xs" data-testid="zukan-summary">
        <button type="button" onClick={() => setDetail((v) => !v)} aria-expanded={detail} className="flex min-h-12 w-full items-center justify-between gap-2 px-3 text-left" data-testid="zukan-summary-toggle">
          <span className="flex items-baseline gap-2">
            <span className="text-lg font-bold tabular-nums" data-testid="zukan-count">
              {stats ? `${stats.collected} / ${stats.total}` : "— / 151"}
            </span>
            <span className="text-muted-foreground" data-testid="zukan-rate">
              {stats ? `${stats.ratePercent.toFixed(1)}%` : ""}
            </span>
            <span className="text-muted-foreground" data-testid="zukan-uncollected">
              {stats ? `未収集 ${stats.uncollected}` : ""}
            </span>
          </span>
          <ChevronDown className={cn("size-4 text-muted-foreground transition-transform", detail && "rotate-180")} aria-hidden="true" />
        </button>
        {detail && stats && (
          <dl className="grid grid-cols-2 gap-2 border-t px-3 py-2 text-[13px]" data-testid="zukan-detail">
            <div>
              <dt className="text-[11px] text-muted-foreground">登録カード枚数</dt>
              <dd className="font-bold" data-testid="zukan-cards">
                {stats.cardCount}枚
              </dd>
            </div>
            <div>
              <dt className="text-[11px] text-muted-foreground">単品購入金額の合計</dt>
              <dd className="font-bold" data-testid="zukan-total">
                {yen(stats.singlePurchaseTotalYen)}
              </dd>
            </div>
          </dl>
        )}
      </section>
      <div className="flex items-center gap-1.5">
        <div role="radiogroup" aria-label="絞り込み" className="inline-flex flex-1 rounded-md border p-0.5 text-xs" data-testid="zukan-filter">
          {(
            [
              ["all", "すべて"],
              ["collected", "収集済み"],
              ["uncollected", "未収集"],
            ] as const
          ).map(([v, t]) => (
            <button key={v} type="button" role="radio" aria-checked={filter === v} onClick={() => setFilter(v)} className={cn("min-h-9 flex-1 rounded px-2", filter === v ? "bg-primary text-primary-foreground" : "text-muted-foreground")}>
              {t}
            </button>
          ))}
        </div>
        <Button variant="outline" size="icon" className="size-10 shrink-0" onClick={() => void exportJson()} aria-label="図鑑データをエクスポート（JSON）" data-testid="zukan-export">
          <Download className="size-4" aria-hidden="true" />
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
        <ul className="grid grid-cols-2 gap-1.5 sm:grid-cols-3 md:grid-cols-4" aria-label="ポケモン一覧" data-testid="zukan-list">
          {rows.map((r) => (
            <li key={r.no}>
              <button
                type="button"
                onClick={() => setOpen(r.no)}
                data-testid="zukan-item"
                data-no={r.no}
                data-collected={r.collected ? "true" : "false"}
                aria-label={`${dexLabel(r.no)} ${r.name} ${r.collected ? "収集済み" : "未収集"}`}
                className={cn("flex min-h-12 w-full items-center gap-1.5 rounded-lg border px-2 text-left text-sm active:opacity-80", r.collected ? "border-success/50 bg-success/15" : "bg-card text-muted-foreground")}
              >
                <span className="w-9 shrink-0 text-[11px] tabular-nums text-muted-foreground">{String(r.no).padStart(3, "0")}</span>
                <span className="min-w-0 flex-1 truncate font-medium">{r.name}</span>
                {r.collected && <Check className="size-4 shrink-0 text-success" strokeWidth={3} aria-hidden="true" />}
              </button>
            </li>
          ))}
          {rows.length === 0 && <li className="col-span-full py-6 text-center text-sm text-muted-foreground">該当するポケモンがいません。</li>}
        </ul>
      )}
      {open !== null && data && <PokemonSheet no={open} data={data} profileId={profileId} today={today} reload={reload} onClose={() => setOpen(null)} />}
    </div>
  );
}
