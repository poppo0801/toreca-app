"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";
import { ArrowDownAZ, ArrowDown01, Check, ChevronDown, Loader2, Plus } from "lucide-react";
import { buyZukanFromPriceAction, addZukanPriceAction, deleteZukanCardAction, deleteZukanPriceAction, loadZukanAction, saveZukanCardAction, updateZukanCardInfoAction, updateZukanPriceAction, type ZukanData } from "@/app/(app)/zukan/actions";
import { recordEventAction } from "@/app/(app)/market-memo/daily-actions";
import { useApp } from "@/components/app-provider";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { DexImage } from "@/components/dex-image";
import { useExpansionMasters } from "@/components/use-expansion-masters";
import { CardIdentityFields } from "@/components/card-identity-fields";
import { addPricesSequentially, jstToday, PriceForm, useStoreCandidates } from "@/components/price-form";
import { PriceList, type PriceRow } from "@/components/price-list";
import { Button } from "@/components/ui/button";
import { Sheet, SheetBody, SheetContent, SheetDescription, SheetTitle } from "@/components/ui/sheet";
import { cardKeyOf } from "@/lib/zukan/daily";
import { dexLabel, pokemonOf } from "@/lib/zukan/pokemon151";
import type { ZukanPriceRecord } from "@/lib/zukan/rows";
import { ACQUIRE_LABEL, completeSetFromNumber, type PriceInput, DEFAULT_RARITY, DEX_STATUS_LABEL, dexStatus, numberOptions, parseAmount, RANKS, resolveAcquire, setOptions, zukanRows, zukanStats, type AcquireMethod, type DexStatus, type KnownCard, type ZukanCard, type ZukanFilter, type ZukanSort } from "@/lib/zukan/zukan";
import { cn } from "@/lib/utils";

/**
 * 状態の見た目（文字バッジは使わない。背景色＋枠線の形で区別し、色だけに頼らない）:
 *  入手済み=白地・緑の実線枠／相場登録済み=青みの薄地・青の実線枠／対象レア未収録=紫みの薄地・紫の破線枠／未登録=薄いグレー・枠なし。
 *  未入手の3状態は画像を半透明（35%）にする。
 */
/** 詳細ヘッダーの状態バッジ（短い色分け1個。一覧のカードには文字バッジを出さない） */
const BADGE_STYLE: Record<DexStatus, string> = {
  owned: "bg-success text-white",
  market: "bg-sky-100 text-sky-900 dark:bg-sky-950 dark:text-sky-200",
  rare_missing: "bg-violet-100 text-violet-900 dark:bg-violet-950 dark:text-violet-200",
  unregistered: "bg-muted text-muted-foreground",
};

const STATUS_STYLE: Record<DexStatus, string> = {
  owned: "border-success/60 bg-white text-foreground dark:bg-card",
  market: "border-sky-500/60 bg-sky-100 text-muted-foreground dark:bg-sky-950/60",
  rare_missing: "border-dashed border-violet-500/70 bg-violet-100 text-muted-foreground dark:bg-violet-950/50",
  unregistered: "border-transparent bg-muted text-muted-foreground",
};

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

const FIELD = "mt-0.5 h-10 w-full rounded-md border bg-input px-2.5 text-sm";

/** カード名（価格フォームの最上部。図鑑のポケモン名が初期値） */
function CardNameField({ v, onChange }: { v: CardInfo; onChange: (v: CardInfo) => void }) {
  return (
    <label className="block text-sm" data-testid="price-card-info">
      <span className="text-[13px] font-medium">カード名</span>
      <input value={v.cardName} onChange={(e) => onChange({ ...v, cardName: e.target.value })} className={FIELD} maxLength={80} autoComplete="off" data-testid="price-card-name" />
    </label>
  );
}

/** 収録セット・番号・レア（任意。必須項目の下）。番号・レアは候補から選べる（先頭1文字から絞り込み・選ぶとセットとレアを補完・自由入力も可）。レアの初期値は AR */
function CardDetailFields({ v, onChange, known }: { v: CardInfo; onChange: (v: CardInfo) => void; known: KnownCard[] }) {
  const masters = useExpansionMasters();
  return <CardIdentityFields v={v} onChange={(x) => onChange({ ...v, ...x })} known={known} masters={masters} ids={{ set: "price-card-set", number: "price-card-number", rarity: "price-card-rarity", setList: "zukan-set-options" }} />;
}

/** ポケモン1匹の詳細（収集カード・価格調査） */
function PokemonSheet({ no, data, profileId, today, reload, onClose, status, rareMissing, onToggleRare, initialEditId }: { initialEditId?: string; no: number; data: ZukanData; profileId: string; today: string; reload: () => Promise<void>; onClose: () => void; status: DexStatus; rareMissing: boolean; onToggleRare: () => Promise<string | null> }) {
  const [flagError, setFlagError] = useState<string | null>(null);
  const p = pokemonOf(no)!;
  const cards = data.cards.filter((c) => c.dexNo === no);
  const prices = data.prices.filter((r) => r.dexNo === no);
  const priceRows = prices.map((r) => ({ ...r, cardKey: cardKeyOf(r), cardLabel: [r.setName, r.cardNumber, r.rarity].filter(Boolean).join(" ・ ") }));
  const [editing, setEditing] = useState<{ id: string | null; form: CardForm } | null>(null);
  const [pricing, setPricing] = useState<{ rec: ZukanPriceRecord | null } | null>(() => {
    // 日別の調査結果の「編集」から開いたとき: その価格記録の編集フォームを直接開く
    const rec = initialEditId ? data.prices.find((x) => x.id === initialEditId && x.dexNo === no) : undefined;
    return rec ? { rec } : null;
  });
  const [delCard, setDelCard] = useState<ZukanCard | null>(null);
  const [delPrice, setDelPrice] = useState<PriceRow | null>(null);
  const [buy, setBuy] = useState<PriceRow | null>(null);
  const bought = new Set(cards.map((c) => c.priceRecordId).filter((x): x is string => !!x));
  const cand = useStoreCandidates();
  const known = useMemo<KnownCard[]>(() => [...data.prices, ...data.cards].map((x) => ({ setName: x.setName, cardNumber: x.cardNumber, rarity: x.rarity, name: "cardName" in x ? x.cardName : "", usedAt: "createdAt" in x ? x.createdAt : "" })), [data.prices, data.cards]);
  const [info, setInfo] = useState<CardInfo>(() => {
    const rec = initialEditId ? data.prices.find((x) => x.id === initialEditId && x.dexNo === no) : undefined;
    return rec ? { cardName: rec.cardName, setName: rec.setName, cardNumber: rec.cardNumber, rarity: rec.rarity } : { cardName: p.name, setName: "", cardNumber: "", rarity: DEFAULT_RARITY };
  });

  /** 編集: 価格を更新し、カード情報（カード名・収録セット・番号・レア）が変わっていれば同じカードの価格記録すべてに反映する（履歴・購入との関連は変えない） */
  const saveEdited = async (rec: ZukanPriceRecord, v: PriceInput) => {
    const r = await updateZukanPriceAction(profileId, rec.id, v);
    if (!r.ok) return r;
    const same = info.cardName.trim() === rec.cardName && info.setName.trim() === rec.setName && info.cardNumber.trim() === rec.cardNumber && info.rarity.trim() === rec.rarity;
    if (same) return r;
    const c = await updateZukanCardInfoAction(profileId, rec.id, info);
    return c.ok ? r : ({ ok: false, error: `価格は更新しました。カード情報は更新できませんでした: ${c.error}` } as const);
  };
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
        <div className="flex items-center gap-3 px-4 pb-2">
          <DexImage no={no} name={p.name} className="size-14" />
          <div className="min-w-0">
            <SheetTitle>
              {dexLabel(no)} {p.name}
            </SheetTitle>
            <span className={cn("mt-0.5 inline-block rounded px-1.5 py-0.5 text-[11px] font-bold", BADGE_STYLE[status])} data-testid="zukan-status-badge" data-status={status}>
              {DEX_STATUS_LABEL[status]}
            </span>
          </div>
          <SheetDescription id="zukan-desc" className="sr-only">
            {p.name}のカードの登録と価格調査
          </SheetDescription>
        </div>
        <SheetBody className="space-y-4 border-t pt-3">
          {status !== "owned" && (
            <section aria-label="対象レア未収録" className="rounded-lg border px-2.5 py-2 text-xs">
              <label className="flex min-h-8 items-center gap-2">
                <input type="checkbox" checked={rareMissing} onChange={async () => setFlagError(await onToggleRare())} className="size-4" data-testid="rare-missing-toggle" />
                <span className="text-[13px] font-medium">対象レア未収録</span>
              </label>
              {flagError && (
                <p role="alert" className="mt-1 text-danger">
                  {flagError}
                </p>
              )}
            </section>
          )}
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
              <Button size="sm" variant="outline" className="min-h-9" onClick={() => {
                  setInfo({ cardName: p.name, setName: "", cardNumber: "", rarity: DEFAULT_RARITY });
                  setPricing({ rec: null });
                }} data-testid="price-add">
                <Plus className="size-4" aria-hidden="true" /> 価格を記録
              </Button>
            </div>
            {pricing && (
              <div className="space-y-1.5">
                <PriceForm
                  initial={pricing.rec ? { storeName: pricing.rec.storeName, chainName: pricing.rec.chainName, surveyedOn: pricing.rec.surveyedOn, condition: pricing.rec.condition as never, price: String(pricing.rec.priceYen), note: pricing.rec.note } : undefined}
                  {...cand}
                  today={today}
                  top={<CardNameField v={info} onChange={setInfo} />}
                  optional={<CardDetailFields v={info} onChange={setInfo} known={known} />}
                  submitLabel={pricing.rec ? "更新する" : "記録する"}
                  onCancel={() => setPricing(null)}
                  onSubmitBatch={async (items) => {
                    const res = await addPricesSequentially(items, (v) => addZukanPriceAction(profileId, no, { cardName: info.cardName || p.name, setName: info.setName, cardNumber: info.cardNumber, rarity: info.rarity }, v));
                    await reload();
                    if (res.error) return res.error;
                    setPricing(null);
                    return null;
                  }}
                  onSubmit={async (v) => {
                    const r = pricing.rec ? await saveEdited(pricing.rec, v) : await addZukanPriceAction(profileId, no, { cardName: info.cardName || p.name, setName: info.setName, cardNumber: info.cardNumber, rarity: info.rarity }, v);
                    if (!r.ok) return r.error;
                    setPricing(null);
                    await reload();
                    return null;
                  }}
                />
              </div>
            )}
            <PriceList
              rows={priceRows}
              today={today}
              boughtIds={bought}
              events={data.events}
              keyOf={(r) => `zukan:${r.id}`}
              onBuy={setBuy}
              onEdit={(r) => {
                const rec = prices.find((x) => x.id === r.id) ?? null;
                if (rec) setInfo({ cardName: rec.cardName, setName: rec.setName, cardNumber: rec.cardNumber, rarity: rec.rarity });
                setPricing({ rec });
              }}
              onDelete={setDelPrice}
              onConfirm={async (r) => {
                const res = await recordEventAction(profileId, [{ source: "zukan", id: r.id }], "confirmed");
                if (!res.ok) return res.error;
                await reload();
                return null;
              }}
              onSoldOut={async (r) => {
                const res = await recordEventAction(profileId, [{ source: "zukan", id: r.id }], "sold_out");
                if (!res.ok) return res.error;
                await reload();
                return null;
              }}
            />
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
          description={`${buy.storeName}で${yen(buy.priceYen)}（状態${buy.condition}）。図鑑の収集カードとして登録し、購入記録（シングルカード）・収支にも反映します（同じ日の購入は合算）。価格調査の記録は残ります。`}
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
  const { profile, now, settings, saveSettings } = useApp();
  const profileId = profile.id;
  const today = jstToday(now);
  const [data, setData] = useState<ZukanData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<ZukanFilter>("all");
  const [sort, setSort] = useState<ZukanSort>("no");
  const rareMissing = useMemo(() => new Set(settings.zukanRareMissing ?? []), [settings.zukanRareMissing]);
  const [open, setOpen] = useState<number | null>(null);
  const [detail, setDetail] = useState(false);
  // 日別の調査結果の「編集」から来たとき（?edit=<価格記録のID>）: 該当のポケモンの詳細を開き、その価格の編集フォームを直接開く
  const editParam = useSearchParams()?.get("edit") ?? null;
  const [editId, setEditId] = useState<string | null>(null);
  const editDone = useRef<string | null>(null);

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

  useEffect(() => {
    if (!editParam || !data || editDone.current === editParam) return;
    const rec = data.prices.find((x) => x.id === editParam);
    editDone.current = editParam;
    if (rec) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- 読み込み完了後に1回だけ、対象のポケモンを開く
      setEditId(rec.id);
      setOpen(rec.dexNo);
    }
  }, [editParam, data]);

  const stats = useMemo(() => (data ? zukanStats(data.cards) : null), [data]);
  const rows = useMemo(() => (data ? zukanRows(data.cards, filter, { prices: data.prices, rareMissing, sort }) : []), [data, filter, rareMissing, sort]);
  /** 対象レア未収録フラグの切替（プロフィール設定に保存。失敗時はエラーを返す） */
  const toggleRare = async (no: number): Promise<string | null> => {
    const next = new Set(rareMissing);
    if (next.has(no)) next.delete(no);
    else next.add(no);
    const r = await saveSettings({ zukanRareMissing: [...next].sort((a, b) => a - b) });
    return r.ok ? null : r.error;
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
      {/* 操作ヘッダー（絞り込み・並び替え）: スクロールしても画面上部に固定 */}
      <div className="sticky top-[var(--header-h)] z-20 -mx-3 -mt-1 flex items-center gap-1.5 border-b bg-background px-3 pb-1.5 pt-1 md:-mx-6 md:px-6" data-testid="zukan-toolbar">
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
        <Button variant="outline" size="icon" className="size-10 shrink-0" onClick={() => setSort((v) => (v === "no" ? "kana" : "no"))} aria-label={sort === "no" ? "並び順: 図鑑番号順（押すと五十音順）" : "並び順: 五十音順（押すと図鑑番号順）"} data-testid="zukan-sort" data-sort={sort}>
          {sort === "no" ? <ArrowDown01 className="size-4" aria-hidden="true" /> : <ArrowDownAZ className="size-4" aria-hidden="true" />}
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
                data-status={r.status}
                aria-label={`${dexLabel(r.no)} ${r.name} ${DEX_STATUS_LABEL[r.status]}`}
                className={cn("flex min-h-14 w-full items-center gap-1.5 rounded-lg border-2 px-1.5 py-1 text-left text-sm active:opacity-80", STATUS_STYLE[r.status])}
              >
                <DexImage no={r.no} name={r.name} className="size-10" dim={!r.collected} />
                <span className="flex min-w-0 flex-1 flex-col leading-tight">
                  <span className="text-[10px] tabular-nums text-muted-foreground">{String(r.no).padStart(3, "0")}</span>
                  <span className={cn("truncate text-[13px] font-medium", r.collected && "text-foreground")}>{r.name}</span>
                </span>
                {r.collected && <Check className="size-5 shrink-0 text-success" strokeWidth={3} aria-hidden="true" />}
              </button>
            </li>
          ))}
          {rows.length === 0 && <li className="col-span-full py-6 text-center text-sm text-muted-foreground">該当するポケモンがいません。</li>}
        </ul>
      )}
      {open !== null && data && (
        <PokemonSheet
          no={open}
          data={data}
          profileId={profileId}
          today={today}
          reload={reload}
          onClose={() => {
            setOpen(null);
            setEditId(null);
          }}
          initialEditId={editId ?? undefined}
          status={dexStatus({ owned: data.cards.some((c) => c.dexNo === open && c.quantity >= 1), hasPrice: data.prices.some((p) => p.dexNo === open), rareMissing: rareMissing.has(open) })}
          rareMissing={rareMissing.has(open)}
          onToggleRare={() => toggleRare(open)}
        />
      )}
    </div>
  );
}
