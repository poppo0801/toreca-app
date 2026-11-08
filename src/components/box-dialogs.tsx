"use client";

import { useMemo, useRef, useState } from "react";
import {
  addBoxPricesAction,
  addManualBoxAction,
  importPurchaseItemAction,
  saveBoxSettingsAction,
} from "@/app/(app)/collection/box-actions";
import { useApp } from "@/components/app-provider";
import { ChainStoreFields, type ChainStoreValue } from "@/components/chain-store-fields";
import { CountInput } from "@/components/count-input";
import { MasterCombobox, type MasterRef } from "@/components/master-combobox";
import { ProductThumb } from "@/components/product-image";
import { Button } from "@/components/ui/button";
import { RegisterKindSwitch } from "@/components/register-kind-switch";
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { Sheet, SheetBody, SheetContent, SheetDescription, SheetTitle } from "@/components/ui/sheet";
import { BOX_STATE_LABEL, BOX_STATES, DEFAULT_BOX_SETTINGS, indexMarket, jstDateOf, latestPrices, marketKey, type BoxMarketRow, type BoxPriceRow, type BoxSettings, type BoxSummaryRow } from "@/lib/box-collection";
import type { ImportableItem } from "@/lib/server/box-collection-service";
import { jstToday } from "@/lib/ai/extraction";
import type { ShrinkState } from "@/types/domain";

const field = "mt-1 min-h-11 w-full rounded-md border bg-input px-3 text-sm";
const yen = (n: number) => `${n.toLocaleString("ja-JP")}円`;
/** 空欄はnull、数字だけ許可（円）。不正な値は undefined */
function parseYenInput(s: string): number | null | undefined {
  const t = s.trim().replace(/,/g, "");
  if (t === "") return null;
  if (!/^\d{1,9}$/.test(t)) return undefined;
  return Number(t);
}
const newOp = () => crypto.randomUUID();

/** ダイアログ共通の下段（キャンセル／決定） */
function Footer({ busy, onSave, label = "保存", disabled }: { busy: boolean; onSave: () => void; label?: string; disabled?: boolean }) {
  return (
    <div className="mt-4 flex justify-end gap-2">
      <DialogClose asChild>
        <Button type="button" variant="outline" disabled={busy}>
          キャンセル
        </Button>
      </DialogClose>
      <Button type="button" onClick={onSave} disabled={busy || disabled} data-testid="box-dialog-save">
        {busy ? "保存中…" : label}
      </Button>
    </div>
  );
}

const err = (e: string | null) =>
  e ? (
    <p role="alert" className="mt-2 text-sm text-danger" data-testid="box-dialog-error">
      {e}
    </p>
  ) : null;

// ---------------------------------------------------------------- 手動登録

/**
 * BOXの手動登録。既存の商品マスターから選ぶ（商品情報を二重に持たない）。購入時点の市場相場は、取得元と基準日をセットで入力する
 * （出所の分からない価格を履歴にしない）。分からなければ空欄のままでよく、実購入価格で評価する。
 */
export function BoxFormDialog({ onClose, onSaved, onSwitchKind }: { onClose: () => void; onSaved: () => void; /** 上部の「カード／BOX」でカードが選ばれた */ onSwitchKind?: () => void }) {
  const { data, profile } = useApp();
  const [product, setProduct] = useState<MasterRef>({ id: null, name: "" });
  // 新規登録のシュリンク状態は「シュリンクあり」が初期値（既存BOXの状態は変えない）
  const [state, setState] = useState<ShrinkState>("shrink");
  const [qty, setQty] = useState(1);
  const [date, setDate] = useState(() => jstToday(new Date()));
  const [cs, setCs] = useState<ChainStoreValue>({ chain: { id: null, name: "" }, store: { id: null, name: "" } });
  const store = [cs.chain.name.trim(), cs.store.name.trim()].filter(Boolean).join(" ").slice(0, 80);
  /** 定価から自動入力した購入価格（利用者が書き換えた後は上書きしない） */
  const autoPrice = useRef<string | null>(null);
  const [actual, setActual] = useState("");
  const chooseProduct = (ref: MasterRef) => {
    setProduct(ref);
    if (!ref.id) return;
    const list = data.products.find((p) => p.id === ref.id)?.listPriceBox;
    const untouched = actual.trim() === "" || actual === autoPrice.current;
    if (!untouched) return; // 手入力した購入価格は上書きしない
    if (list != null && list > 0) {
      autoPrice.current = String(list);
      setActual(String(list));
    } else if (actual === autoPrice.current) {
      autoPrice.current = null;
      setActual(""); // 定価が不明な商品に変えたときは、前の商品の定価を残さない
    }
  };
  const [market, setMarket] = useState("");
  const [marketSource, setMarketSource] = useState("");
  const [marketDate, setMarketDate] = useState("");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // 画面を開いた時点の操作ID（多重タップ・再送で二重登録しない）
  const [opId] = useState(newOp);

  const options = useMemo(
    () => data.products.filter((p) => !p.archived).map((p) => ({ id: p.id, name: p.officialName, hint: p.code || undefined, thumb: <ProductThumb product={p} heightClass="h-9" /> })),
    [data.products],
  );
  // 購入記録（BOX）がある商品は、購入記録の側で自動的に反映される。手動登録との二重登録に注意を促す
  const hasPurchase = !!product.id && data.purchases.some((p) => p.items.some((i) => i.productId === product.id && i.unit === "box"));

  const save = async () => {
    setError(null);
    if (!product.id) return setError("商品を選択してください（商品マスターにある商品から選びます）");
    const a = parseYenInput(actual);
    const m = parseYenInput(market);
    if (a === undefined || m === undefined) return setError("金額は数字（円）で入力してください");
    if (qty < 1) return setError("数量は1以上にしてください");
    if (m !== null && (marketSource.trim() === "" || marketDate === "")) return setError("購入時点の市場相場には、取得元と基準日を入力してください");
    setBusy(true);
    const r = await addManualBoxAction(
      { productId: product.id, state, quantity: qty, acquiredOn: date || null, storeLabel: store, actualUnitPrice: a, marketUnitPrice: m, marketPriceSource: marketSource, marketPriceDate: m === null ? null : marketDate, note, opId },
      profile.id,
    );
    setBusy(false);
    if (!r.ok) return setError(r.error);
    onSaved();
    onClose();
  };

  return (
    <Sheet open onOpenChange={(o) => !o && onClose()}>
      <SheetContent aria-describedby="box-form-desc" data-testid="box-form" onOpenAutoFocus={(e) => e.preventDefault()}>
        <div className="px-4 pb-2">
          {onSwitchKind && <RegisterKindSwitch value="box" onChange={onSwitchKind} />}
          <SheetTitle>BOXを登録</SheetTitle>
          <SheetDescription id="box-form-desc" className="sr-only">
            所有しているBOXを手動で登録します
          </SheetDescription>
        </div>
        <div className="flex min-h-0 flex-1 flex-col">
        <SheetBody className="space-y-2.5 border-t pt-3">
        <div className="space-y-2.5">
          <div className="text-sm">
            商品
            <MasterCombobox label="BOXの商品" value={product} options={options} onChange={chooseProduct} />
            {hasPurchase && (
              <p className="mt-1 text-[11px] text-warn" role="status" data-testid="box-dup-hint">
                この商品のBOXの購入記録があります。購入記録の分は自動で反映されるため、同じBOXを手動で登録すると二重になります（過去の購入記録は、一覧のメニュー「購入記録から取り込む」から）。
              </p>
            )}
          </div>
          <div className="grid grid-cols-[1fr_5rem] gap-2">
            <label className="text-sm">
              シュリンク状態
              <select aria-label="シュリンク状態" value={state} onChange={(e) => setState(e.target.value as ShrinkState)} className={field}>
                {BOX_STATES.map((s) => (
                  <option key={s} value={s}>
                    {BOX_STATE_LABEL[s]}
                  </option>
                ))}
              </select>
            </label>
            <label className="text-sm">
              数量
              <CountInput aria-label="BOXの数量" emptyValue={0} value={qty} onChange={setQty} className={`${field} text-center`} />
            </label>
          </div>
          <label className="block text-sm">
            購入日
            <input type="date" aria-label="購入日" value={date} onChange={(e) => setDate(e.target.value)} className={field} />
          </label>
          <ChainStoreFields value={cs} onChange={setCs} chainLabel="購入元の系列" storeLabel="購入元の店舗" />
          <label className="block text-sm">
            実際の購入価格（1BOXあたり・円）
            <input type="text" inputMode="numeric" aria-label="実際の購入価格" placeholder="不明は空欄" value={actual} onChange={(e) => setActual(e.target.value)} className={field} />
          </label>
          <details className="rounded-md border px-2.5 py-1.5 text-sm">
            <summary className="cursor-pointer text-[13px]">購入時点の市場相場（任意）</summary>
            <div className="mt-1.5 space-y-2 pb-1">
              <label className="block text-sm">
                市場相場（1BOXあたり・円）
                <input type="text" inputMode="numeric" aria-label="購入時点の市場相場" value={market} onChange={(e) => setMarket(e.target.value)} className={field} />
              </label>
              <div className="grid grid-cols-2 gap-2">
                <label className="text-sm">
                  取得元
                  <input type="text" aria-label="市場相場の取得元" maxLength={60} placeholder="例: 〇〇の相場表" value={marketSource} onChange={(e) => setMarketSource(e.target.value)} className={field} />
                </label>
                <label className="text-sm">
                  基準日
                  <input type="date" aria-label="市場相場の基準日" value={marketDate} onChange={(e) => setMarketDate(e.target.value)} className={field} />
                </label>
              </div>
            </div>
          </details>
          <label className="block text-sm">
            メモ
            <input type="text" aria-label="メモ" maxLength={500} value={note} onChange={(e) => setNote(e.target.value)} className={field} />
          </label>
        </div>
        {err(error)}
        </SheetBody>
        <div className="flex items-center justify-end gap-2 border-t bg-card px-4 py-2 pb-[calc(0.5rem+env(safe-area-inset-bottom))]">
          <Button type="button" variant="outline" onClick={onClose} disabled={busy}>
            閉じる
          </Button>
          <Button type="button" onClick={() => void save()} disabled={busy} data-testid="box-dialog-save">
            {busy ? "保存中…" : "登録"}
          </Button>
        </div>
        </div>
      </SheetContent>
    </Sheet>
  );
}

// ---------------------------------------------------------------- 相場の一括更新（手動）

/**
 * 参考買取相場の更新。所有している商品ごとに基準相場を入力する（無料で使える取得元がないため手動）。
 * 追記方式で過去の値は残る。空欄の商品は変更しない。状態別の実際の相場は、商品の詳細から入力する。
 */
export function BoxPriceDialog({ rows, prices, market = [], onOpenMarket, onClose, onSaved }: { rows: BoxSummaryRow[]; prices: BoxPriceRow[]; market?: BoxMarketRow[]; onOpenMarket?: () => void; onClose: () => void; onSaved: () => void }) {
  const { profile } = useApp();
  const latest = useMemo(() => latestPrices(prices), [prices]);
  const marketIdx = useMemo(() => indexMarket(market), [market]);
  const [values, setValues] = useState<Record<string, string>>({});
  const [date, setDate] = useState(() => jstToday(new Date()));
  const [source, setSource] = useState("手動");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const save = async () => {
    setError(null);
    const list: { productId: string; state: null; amountYen: number; confirmedOn: string; source: string }[] = [];
    for (const r of rows) {
      const v = parseYenInput(values[r.productId] ?? "");
      if (v === undefined) return setError(`${r.name}: 金額は数字（円）で入力してください`);
      if (v !== null) list.push({ productId: r.productId, state: null, amountYen: v, confirmedOn: date, source: source.trim() || "手動" });
    }
    if (list.length === 0) return setError("更新する金額を入力してください");
    setBusy(true);
    const r = await addBoxPricesAction(list, profile.id);
    setBusy(false);
    if (!r.ok) return setError(r.error);
    onSaved();
    onClose();
  };

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent data-testid="box-price-dialog" aria-describedby="box-price-desc">
        <DialogTitle>BOXの相場を更新</DialogTitle>
        <DialogDescription id="box-price-desc">1BOXあたりの参考買取相場（円）。入力した商品だけ更新します。</DialogDescription>
        {onOpenMarket && (
          <Button type="button" variant="outline" size="sm" className="mt-2 w-full" onClick={onOpenMarket} data-testid="box-open-market">
            ポケカ価格比較から取得
          </Button>
        )}
        <div className="mt-2 grid grid-cols-2 gap-2">
          <label className="text-sm">
            基準日
            <input type="date" aria-label="相場の基準日" value={date} onChange={(e) => setDate(e.target.value)} className={field} />
          </label>
          <label className="text-sm">
            取得元
            <input type="text" aria-label="相場の取得元" maxLength={60} value={source} onChange={(e) => setSource(e.target.value)} className={field} />
          </label>
        </div>
        <ul className="mt-2 max-h-[45dvh] space-y-1.5 overflow-y-auto">
          {rows.map((r) => {
            const cur = latest.get(`${r.productId}|`);
            const mk = marketIdx.get(marketKey(r.productId, "buyback", "base"));
            return (
              <li key={r.productId} className="flex items-center gap-2 text-sm" data-testid="box-price-row">
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[13px]">{r.name}</span>
                  <span className="block text-[11px] text-muted-foreground">{cur ? `現在 ${yen(cur.amountYen)}（${cur.confirmedOn.slice(5).replace("-", "/")}）` : mk ? `取得 ${yen(mk.medianYen)}（${jstDateOf(mk.fetchedAt).slice(5).replace("-", "/")}・${mk.sampleCount === 1 ? "1店舗のみ" : `${mk.sampleCount}店舗`}）` : "相場 未取得"}</span>
                </span>
                <input
                  type="text"
                  inputMode="numeric"
                  aria-label={`${r.name}の相場`}
                  placeholder="円"
                  value={values[r.productId] ?? ""}
                  onChange={(e) => setValues((v) => ({ ...v, [r.productId]: e.target.value }))}
                  className="h-11 w-28 rounded-md border bg-input px-2 text-right text-sm"
                />
              </li>
            );
          })}
        </ul>
        {err(error)}
        <Footer busy={busy} onSave={() => void save()} label="更新" />
      </DialogContent>
    </Dialog>
  );
}

// ---------------------------------------------------------------- 状態別の評価倍率

export function BoxMultipliersDialog({ value, onClose, onSaved }: { value: BoxSettings; onClose: () => void; onSaved: (s: BoxSettings) => void }) {
  const { profile } = useApp();
  const [shrink, setShrink] = useState(String(value.shrinkPct));
  const [noShrink, setNoShrink] = useState(String(value.noShrinkPct));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const save = async () => {
    const a = Number(shrink);
    const b = Number(noShrink);
    if (!Number.isInteger(a) || !Number.isInteger(b) || a < 1 || a > 200 || b < 1 || b > 200) return setError("倍率は1〜200の整数（%）で入力してください");
    setBusy(true);
    const r = await saveBoxSettingsAction({ shrinkPct: a, noShrinkPct: b }, profile.id);
    setBusy(false);
    if (!r.ok) return setError(r.error);
    onSaved({ shrinkPct: a, noShrinkPct: b });
    onClose();
  };

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent data-testid="box-multipliers" aria-describedby="box-mult-desc">
        <DialogTitle>シュリンク状態の評価倍率</DialogTitle>
        <DialogDescription id="box-mult-desc">基準の買取相場に掛けて評価額を出します。状態別の実際の相場があるBOXは、その相場を使います。参考評価であり、買取の保証額ではありません。</DialogDescription>
        <ul className="mt-3 space-y-2">
          {[
            { label: "シュリンクあり", v: shrink, set: setShrink, test: "mult-shrink" },
            { label: "シュリンクなし", v: noShrink, set: setNoShrink, test: "mult-no-shrink" },
          ].map((x) => (
            <li key={x.label} className="flex items-center gap-2 text-sm">
              <span className="min-w-0 flex-1">{x.label}</span>
              <CountInput aria-label={`${x.label}の倍率（%）`} max={200} emptyValue={0} value={Number(x.v) || 0} onChange={(n) => x.set(String(n))} className="h-11 w-24 rounded-md border bg-input px-3 text-right text-sm" data-testid={x.test} />
              <span>%</span>
            </li>
          ))}
          <li className="text-[11px] text-muted-foreground">シュリンク状態「－」は、あり・なしのどちらとも推測せず基準相場で評価します。</li>
        </ul>
        {err(error)}
        <div className="mt-3 flex items-center justify-between gap-2">
          <Button type="button" variant="outline" size="sm" onClick={() => (setShrink(String(DEFAULT_BOX_SETTINGS.shrinkPct)), setNoShrink(String(DEFAULT_BOX_SETTINGS.noShrinkPct)))}>
            初期値に戻す
          </Button>
          <div className="flex gap-2">
            <DialogClose asChild>
              <Button type="button" variant="outline">
                キャンセル
              </Button>
            </DialogClose>
            <Button type="button" onClick={() => void save()} disabled={busy} data-testid="box-dialog-save">
              {busy ? "保存中…" : "保存"}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

// ---------------------------------------------------------------- 購入記録から取り込む

/**
 * 過去の購入記録（BOX）を手動でコレクションに取り込む。売却・開封済みの可能性があるため、自動では取り込まない。
 * 取り込むと、受取の記録があればその状態、なければ状態未確認で入る。取り込んだ分は購入記録と連動する。
 */
export function BoxImportDialog({ items, onClose, onSaved }: { items: ImportableItem[]; onClose: () => void; onSaved: () => void }) {
  const { profile } = useApp();
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const toggle = (id: string) => setPicked((s) => (new Set(s).has(id) ? new Set([...s].filter((x) => x !== id)) : new Set([...s, id])));

  const save = async () => {
    setBusy(true);
    setError(null);
    for (const id of picked) {
      const r = await importPurchaseItemAction(id, profile.id);
      if (!r.ok) {
        setError(r.error);
        setBusy(false);
        onSaved(); // 取り込めた分は反映する
        return;
      }
    }
    setBusy(false);
    onSaved();
    onClose();
  };

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent data-testid="box-import" aria-describedby="box-import-desc">
        <DialogTitle>購入記録から取り込む</DialogTitle>
        <DialogDescription id="box-import-desc">現在も所有しているBOXだけを選んでください（売却・開封済みのものは取り込まないでください）。</DialogDescription>
        {items.length === 0 ? (
          <p className="mt-3 text-sm text-muted-foreground">取り込めるBOXの購入記録はありません。</p>
        ) : (
          <ul className="mt-2 max-h-[50dvh] divide-y overflow-y-auto rounded-md border">
            {items.map((it) => (
              <li key={it.purchaseItemId}>
                <label className="flex min-h-12 items-center gap-2.5 px-2.5 py-1.5 text-sm">
                  <input type="checkbox" className="size-5" checked={picked.has(it.purchaseItemId)} onChange={() => toggle(it.purchaseItemId)} aria-label={`${it.productName} ${it.quantity}BOXを取り込む`} />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[13px] font-medium">{it.productName}</span>
                    <span className="block text-[11px] text-muted-foreground">
                      {[it.purchasedOn?.replaceAll("-", "/"), it.storeLabel, `${it.quantity}BOX`, it.amountPaid === null ? "金額未入力" : yen(it.amountPaid)].filter(Boolean).join(" ・ ")}
                    </span>
                  </span>
                </label>
              </li>
            ))}
          </ul>
        )}
        {err(error)}
        <Footer busy={busy} onSave={() => void save()} label={`取り込む（${picked.size}件）`} disabled={picked.size === 0} />
      </DialogContent>
    </Dialog>
  );
}
