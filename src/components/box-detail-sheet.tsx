"use client";

import { useMemo, useState } from "react";
import { addBoxPricesAction, adjustBoxAction, openBoxesAction, revertBoxOpAction, updateBoxLotAction } from "@/app/(app)/collection/box-actions";
import { useApp } from "@/components/app-provider";
import { CountInput } from "@/components/count-input";
import { ProductThumb } from "@/components/product-image";
import { Button } from "@/components/ui/button";
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { Sheet, SheetBody, SheetContent, SheetDescription, SheetTitle } from "@/components/ui/sheet";
import {
  availableStates,
  BOX_STATE_LABEL,
  BOX_STATES,
  latestPrices,
  lotUnitValue,
  unitBuyback,
  type BoxLotRow,
  type BoxMovementRow,
  type BoxPriceRow,
  type BoxSettings,
  type BoxSummaryRow,
  type StateCounts,
} from "@/lib/box-collection";
import { jstToday } from "@/lib/ai/extraction";
import type { ShrinkState } from "@/types/domain";

const field = "mt-1 min-h-11 w-full rounded-md border bg-input px-3 text-sm";
const yen = (n: number | null) => (n === null ? "未取得" : `${n.toLocaleString("ja-JP")}円`);
const md = (d: string | null) => (d ? d.slice(5).replace("-", "/") : "—");
const BASIS: Record<string, string> = { actual: "状態別の相場", adjusted: "基準相場×補正", base: "基準相場（状態未確認）", none: "相場未取得" };
const KIND: Record<BoxMovementRow["kind"], string> = { purchase: "購入", receive: "受取", sale: "売却", open: "開封", adjust: "調整" };
const err = (e: string | null) =>
  e ? (
    <p role="alert" className="mt-2 text-sm text-danger" data-testid="box-dialog-error">
      {e}
    </p>
  ) : null;
const parseYen = (s: string): number | null | undefined => {
  const t = s.trim().replace(/,/g, "");
  if (t === "") return null;
  return /^\d{1,9}$/.test(t) ? Number(t) : undefined;
};

type Sub = "open" | "adjust" | "price" | { lot: BoxLotRow } | null;

/**
 * BOXの詳細（下から開くパネル）。状態別の数量と評価、購入ロット（実購入価格・購入時点の市場相場）、在庫の履歴。
 * 開封・数量調整・相場の入力・ロットの編集はここから。売却は収支の売却記録（BOX・状態を選ぶと所有数が減る）で行う。
 */
export function BoxDetailSheet({
  row,
  prices,
  settings,
  movements,
  onOpenChange,
  onChanged,
}: {
  row: BoxSummaryRow;
  prices: BoxPriceRow[];
  settings: BoxSettings;
  movements: BoxMovementRow[];
  onOpenChange: (v: boolean) => void;
  onChanged: () => void;
}) {
  const { data } = useApp();
  const product = data.products.find((p) => p.id === row.productId);
  const latest = useMemo(() => latestPrices(prices), [prices]);
  const [sub, setSub] = useState<Sub>(null);
  const [error, setError] = useState<string | null>(null);
  const lotIds = new Set(row.lots.map((l) => l.lot.id));
  const history = movements.filter((m) => lotIds.has(m.lotId)).slice(0, 40);
  const reverted = new Set(movements.map((m) => m.revertsOp).filter(Boolean) as string[]);
  const changed = () => (onChanged(), setSub(null));

  const undo = async (opId: string) => {
    setError(null);
    const r = await revertBoxOpAction(opId, null);
    if (r.ok) onChanged();
    else setError(r.error);
  };

  return (
    <>
      <Sheet open onOpenChange={onOpenChange}>
        <SheetContent aria-describedby="box-detail-desc" data-testid="box-detail" onOpenAutoFocus={(e) => e.preventDefault()}>
          <div className="flex items-start gap-3 px-4 pb-2 pt-1">
            <div className="flex h-20 w-16 shrink-0 items-center justify-center">
              <ProductThumb product={product} heightClass="h-20" />
            </div>
            <div className="min-w-0 flex-1">
              <SheetTitle className="text-sm">{row.name}</SheetTitle>
              <SheetDescription id="box-detail-desc">
                {row.qty}BOX{row.releaseDate ? ` ・ 発売 ${row.releaseDate.replaceAll("-", "/")}` : ""}
              </SheetDescription>
            </div>
          </div>
          <SheetBody className="space-y-4 border-t pt-3">
            <section aria-label="状態別" data-testid="box-states">
              <table className="w-full text-xs">
                <thead className="text-muted-foreground">
                  <tr>
                    <th className="py-1 text-left font-normal">状態</th>
                    <th className="py-1 text-right font-normal">数量</th>
                    <th className="py-1 text-right font-normal">買取（1BOX）</th>
                    <th className="py-1 text-right font-normal">買取（計）</th>
                  </tr>
                </thead>
                <tbody>
                  {BOX_STATES.filter((s) => row.byState[s] > 0).map((s) => {
                    const b = unitBuyback(row.productId, s, latest, settings);
                    return (
                      <tr key={s} className="border-t" data-testid={`state-${s}`}>
                        <td className="py-1.5">
                          {BOX_STATE_LABEL[s]}
                          <span className="block text-[10px] text-muted-foreground">{BASIS[b.basis]}</span>
                        </td>
                        <td className="py-1.5 text-right tabular-nums">{row.byState[s]}BOX</td>
                        <td className="py-1.5 text-right tabular-nums">{yen(b.amount)}</td>
                        <td className="py-1.5 text-right tabular-nums">{b.amount === null ? "未取得" : yen(b.amount * row.byState[s])}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
              <p className="mt-1 text-[11px] text-muted-foreground">
                購入（評価額）{yen(row.purchaseTotal)}
                {row.purchaseMissingQty > 0 && `（${row.purchaseMissingQty}BOXは価格未取得）`} ／ 買取 {yen(row.buybackTotal)}
                {row.buybackMissingQty > 0 && `（${row.buybackMissingQty}BOXは相場未取得）`}。参考評価で、買取の保証額ではありません。
              </p>
              {row.buybackUnconfirmedQty > 0 && <p className="text-[11px] text-warn">状態未確認の{row.buybackUnconfirmedQty}BOXは、基準相場のまま計算しています。</p>}
            </section>

            <div className="flex flex-wrap gap-2" data-testid="box-ops">
              <Button size="sm" onClick={() => setSub("open")} data-testid="box-open-btn">
                開封済みにする
              </Button>
              <Button size="sm" variant="outline" onClick={() => setSub("price")} data-testid="box-price-btn">
                相場を入力
              </Button>
              <Button size="sm" variant="outline" onClick={() => setSub("adjust")} data-testid="box-adjust-btn">
                数量を調整
              </Button>
            </div>
            {error && (
              <p role="alert" className="text-sm text-danger">
                {error}
              </p>
            )}

            <section aria-label="購入ロット" className="space-y-1.5" data-testid="box-lots">
              <h3 className="text-xs font-bold">購入ロット</h3>
              <ul className="space-y-1.5">
                {row.lots.map(({ lot, counts }) => {
                  const v = lotUnitValue(lot);
                  return (
                    <li key={lot.id} className="rounded-md border px-2.5 py-1.5 text-xs" data-testid="box-lot">
                      <div className="flex flex-wrap items-center gap-x-2">
                        <span className="font-medium">{lot.acquiredOn?.replaceAll("-", "/") ?? "購入日不明"}</span>
                        <span className="text-muted-foreground">{lot.storeLabel || "購入元不明"}</span>
                        <span className="rounded border px-1 text-[10px] text-muted-foreground">{lot.sourceKind === "purchase" ? "購入記録と連動" : "手動登録"}</span>
                        <button type="button" className="ml-auto text-info underline" onClick={() => setSub({ lot })} data-testid="lot-edit">
                          編集
                        </button>
                      </div>
                      <div className="mt-0.5">
                        {BOX_STATES.filter((s) => counts[s] > 0)
                          .map((s) => `${BOX_STATE_LABEL[s]} ${counts[s]}BOX`)
                          .join(" ・ ")}
                      </div>
                      <div className="mt-0.5 text-muted-foreground">
                        実購入 {yen(lot.actualUnitPrice)} ／ 購入時の市場相場 {yen(lot.marketUnitPrice)}
                        {lot.marketUnitPrice !== null && lot.marketPriceSource ? `（${lot.marketPriceSource} ${lot.marketPriceDate?.replaceAll("-", "/") ?? ""}）` : ""}
                      </div>
                      <div className="text-muted-foreground">評価に使う購入価格: {v.basis === "market" ? "購入時点の市場相場" : v.basis === "actual" ? "実購入価格（市場相場なし）" : "未取得"}</div>
                    </li>
                  );
                })}
              </ul>
            </section>

            <section aria-label="履歴" data-testid="box-history">
              <h3 className="text-xs font-bold">在庫の履歴</h3>
              <ul className="mt-1 divide-y rounded-md border text-xs">
                {history.length === 0 && <li className="px-2.5 py-2 text-muted-foreground">履歴はありません</li>}
                {history.map((m) => (
                  <li key={m.id} className="flex items-center gap-2 px-2.5 py-1.5">
                    <span className="w-12 shrink-0 text-muted-foreground">{md(m.occurredAt.slice(0, 10))}</span>
                    <span className="w-9 shrink-0">{m.revertsOp ? "取消" : KIND[m.kind]}</span>
                    <span className="min-w-0 flex-1 truncate">{BOX_STATE_LABEL[m.state]}</span>
                    <span className="shrink-0 tabular-nums">{m.qty > 0 ? `+${m.qty}` : m.qty}</span>
                    {(m.kind === "open" || m.kind === "adjust") && m.opId && !m.revertsOp && !reverted.has(m.opId) ? (
                      <button type="button" className="shrink-0 text-info underline" onClick={() => void undo(m.opId as string)} data-testid="undo-op">
                        取り消し
                      </button>
                    ) : (
                      <span className="w-12 shrink-0" />
                    )}
                  </li>
                ))}
              </ul>
            </section>
          </SheetBody>
        </SheetContent>
      </Sheet>

      {sub === "open" && <OpenDialog row={row} onClose={() => setSub(null)} onDone={changed} />}
      {sub === "adjust" && <AdjustDialog row={row} onClose={() => setSub(null)} onDone={changed} />}
      {sub === "price" && <ProductPriceDialog row={row} latest={latest} onClose={() => setSub(null)} onDone={changed} />}
      {sub && typeof sub === "object" && <LotDialog lot={sub.lot} onClose={() => setSub(null)} onDone={changed} />}
    </>
  );
}

function Shell({ title, desc, testid, children, onClose }: { title: string; desc?: string; testid: string; children: React.ReactNode; onClose: () => void }) {
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent data-testid={testid} aria-describedby={desc ? `${testid}-desc` : undefined}>
        <DialogTitle>{title}</DialogTitle>
        {desc && <DialogDescription id={`${testid}-desc`}>{desc}</DialogDescription>}
        {children}
      </DialogContent>
    </Dialog>
  );
}

function Actions({ busy, onSave, label, disabled }: { busy: boolean; onSave: () => void; label: string; disabled?: boolean }) {
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

/** 開封済みにする（売却とは別の在庫移動）。開封したBOXをカードへ自動変換はしない。誤操作は履歴の「取り消し」で戻せる */
function OpenDialog({ row, onClose, onDone }: { row: BoxSummaryRow; onClose: () => void; onDone: () => void }) {
  const { profile } = useApp();
  const states = availableStates(row.byState);
  const [state, setState] = useState<ShrinkState>(states[0] ?? "unknown");
  const [qty, setQty] = useState(1);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [opId] = useState(() => crypto.randomUUID());
  const max = row.byState[state];

  const save = async () => {
    if (qty < 1) return setError("数量は1以上にしてください");
    if (qty > max) return setError(`所有数（${max}BOX）を超えています`);
    setBusy(true);
    const r = await openBoxesAction({ productId: row.productId, state, quantity: qty, opId }, profile.id);
    setBusy(false);
    if (!r.ok) return setError(r.error);
    onDone();
  };
  return (
    <Shell title="開封済みにする" desc="開封したBOXは所有数から減ります。" testid="box-open-dialog" onClose={onClose}>
      <div className="mt-2 grid grid-cols-[1fr_5rem] gap-2">
        <label className="text-sm">
          状態
          <select aria-label="開封するBOXの状態" value={state} onChange={(e) => (setState(e.target.value as ShrinkState), setQty(1))} className={field}>
            {states.map((s) => (
              <option key={s} value={s}>
                {BOX_STATE_LABEL[s]}（{row.byState[s]}BOX）
              </option>
            ))}
          </select>
        </label>
        <label className="text-sm">
          数量
          <CountInput aria-label="開封する数量" max={max} emptyValue={0} value={qty} onChange={setQty} className={`${field} text-center`} />
        </label>
      </div>
      {err(error)}
      <Actions busy={busy} onSave={() => void save()} label="開封済みにする" disabled={states.length === 0} />
    </Shell>
  );
}

/** 手動の数量調整（棚卸しなど）。増減は履歴に残り、取り消せる。購入記録の数量は変えない */
function AdjustDialog({ row, onClose, onDone }: { row: BoxSummaryRow; onClose: () => void; onDone: () => void }) {
  const { profile } = useApp();
  const [lotId, setLotId] = useState(row.lots[0]?.lot.id ?? "");
  const [state, setState] = useState<ShrinkState>("unknown");
  const [sign, setSign] = useState<1 | -1>(1);
  const [qty, setQty] = useState(1);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [opId] = useState(() => crypto.randomUUID());
  const lot = row.lots.find((l) => l.lot.id === lotId);

  const save = async () => {
    if (qty < 1) return setError("数量は1以上にしてください");
    if (sign < 0 && lot && qty > lot.counts[state]) return setError(`このロットの${BOX_STATE_LABEL[state]}は${lot.counts[state]}BOXしかありません`);
    setBusy(true);
    const r = await adjustBoxAction({ lotId, state, delta: sign * qty, opId, note }, profile.id);
    setBusy(false);
    if (!r.ok) return setError(r.error);
    onDone();
  };
  return (
    <Shell title="数量を調整" desc="棚卸しなどで所有数を直します。購入記録の数量は変わりません。" testid="box-adjust-dialog" onClose={onClose}>
      <div className="mt-2 space-y-2">
        <label className="block text-sm">
          ロット
          <select aria-label="調整するロット" value={lotId} onChange={(e) => setLotId(e.target.value)} className={field}>
            {row.lots.map(({ lot: l }) => (
              <option key={l.id} value={l.id}>
                {[l.acquiredOn?.replaceAll("-", "/") ?? "購入日不明", l.storeLabel].filter(Boolean).join(" ・ ")}
              </option>
            ))}
          </select>
        </label>
        <div className="grid grid-cols-[1fr_4.5rem_4.5rem] gap-2">
          <label className="text-sm">
            状態
            <select aria-label="調整する状態" value={state} onChange={(e) => setState(e.target.value as ShrinkState)} className={field}>
              {BOX_STATES.map((s) => (
                <option key={s} value={s}>
                  {BOX_STATE_LABEL[s]}
                </option>
              ))}
            </select>
          </label>
          <label className="text-sm">
            増減
            <select aria-label="増減" value={sign} onChange={(e) => setSign(Number(e.target.value) as 1 | -1)} className={field}>
              <option value={1}>＋</option>
              <option value={-1}>－</option>
            </select>
          </label>
          <label className="text-sm">
            数量
            <CountInput aria-label="調整する数量" emptyValue={0} value={qty} onChange={setQty} className={`${field} text-center`} />
          </label>
        </div>
        <label className="block text-sm">
          メモ
          <input type="text" aria-label="調整のメモ" maxLength={200} value={note} onChange={(e) => setNote(e.target.value)} className={field} />
        </label>
      </div>
      {err(error)}
      <Actions busy={busy} onSave={() => void save()} label="調整する" disabled={!lotId} />
    </Shell>
  );
}

/** この商品の参考買取相場を入力する（基準相場と、状態別の実際の相場）。追記方式で、過去の値は残る */
function ProductPriceDialog({ row, latest, onClose, onDone }: { row: BoxSummaryRow; latest: Map<string, BoxPriceRow>; onClose: () => void; onDone: () => void }) {
  const { profile } = useApp();
  const [base, setBase] = useState("");
  const [shrink, setShrink] = useState("");
  const [noShrink, setNoShrink] = useState("");
  const [date, setDate] = useState(() => jstToday(new Date()));
  const [source, setSource] = useState("手動");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const cur = (s: ShrinkState | null) => latest.get(`${row.productId}|${s ?? ""}`);

  const save = async () => {
    const entries = [
      { state: null, v: parseYen(base) },
      { state: "shrink" as const, v: parseYen(shrink) },
      { state: "no_shrink" as const, v: parseYen(noShrink) },
    ];
    if (entries.some((e) => e.v === undefined)) return setError("金額は数字（円）で入力してください");
    const list = entries.filter((e) => e.v !== null).map((e) => ({ productId: row.productId, state: e.state, amountYen: e.v as number, confirmedOn: date, source: source.trim() || "手動" }));
    if (list.length === 0) return setError("金額を入力してください");
    setBusy(true);
    const r = await addBoxPricesAction(list, profile.id);
    setBusy(false);
    if (!r.ok) return setError(r.error);
    onDone();
  };
  const input = (label: string, value: string, set: (v: string) => void, s: ShrinkState | null) => (
    <label className="block text-sm">
      {label}
      <span className="ml-1 text-[11px] text-muted-foreground">{cur(s) ? `現在 ${cur(s)!.amountYen.toLocaleString("ja-JP")}円（${md(cur(s)!.confirmedOn)}）` : "未取得"}</span>
      <input type="text" inputMode="numeric" aria-label={label} placeholder="円（変更しない場合は空欄）" value={value} onChange={(e) => set(e.target.value)} className={field} />
    </label>
  );
  return (
    <Shell title="買取相場を入力" desc="1BOXあたりの参考買取相場（円）。状態別の実際の相場がある場合だけ、状態別にも入力します。" testid="box-product-price" onClose={onClose}>
      <div className="mt-2 space-y-2">
        {input("基準相場", base, setBase, null)}
        {input("シュリンクあり（実際の相場）", shrink, setShrink, "shrink")}
        {input("シュリンクなし（実際の相場）", noShrink, setNoShrink, "no_shrink")}
        <div className="grid grid-cols-2 gap-2">
          <label className="text-sm">
            基準日
            <input type="date" aria-label="相場の基準日" value={date} onChange={(e) => setDate(e.target.value)} className={field} />
          </label>
          <label className="text-sm">
            取得元
            <input type="text" aria-label="相場の取得元" maxLength={60} value={source} onChange={(e) => setSource(e.target.value)} className={field} />
          </label>
        </div>
      </div>
      {err(error)}
      <Actions busy={busy} onSave={() => void save()} label="保存" />
    </Shell>
  );
}

/** ロットの編集。購入時点の市場相場（金額・取得元・基準日）は履歴として固定し、現在の相場では更新しない。購入記録と連動するロットの購入日・価格は購入記録が正 */
function LotDialog({ lot, onClose, onDone }: { lot: BoxLotRow; onClose: () => void; onDone: () => void }) {
  const { profile } = useApp();
  const manual = lot.sourceKind === "manual";
  const [date, setDate] = useState(lot.acquiredOn ?? "");
  const [store, setStore] = useState(lot.storeLabel);
  const [actual, setActual] = useState(lot.actualUnitPrice === null ? "" : String(lot.actualUnitPrice));
  const [market, setMarket] = useState(lot.marketUnitPrice === null ? "" : String(lot.marketUnitPrice));
  const [source, setSource] = useState(lot.marketPriceSource);
  const [mdate, setMdate] = useState(lot.marketPriceDate ?? "");
  const [note, setNote] = useState(lot.note);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const save = async () => {
    const a = parseYen(actual);
    const m = parseYen(market);
    if (a === undefined || m === undefined) return setError("金額は数字（円）で入力してください");
    if (m !== null && (source.trim() === "" || mdate === "")) return setError("購入時点の市場相場には、取得元と基準日を入力してください");
    setBusy(true);
    const r = await updateBoxLotAction(
      { lotId: lot.id, acquiredOn: date || null, storeLabel: store, actualUnitPrice: a, marketUnitPrice: m, marketPriceSource: m === null ? "" : source, marketPriceDate: m === null ? null : mdate, note },
      profile.id,
    );
    setBusy(false);
    if (!r.ok) return setError(r.error);
    onDone();
  };
  return (
    <Shell title="ロットを編集" desc={manual ? undefined : "購入日・購入元・実購入価格は購入記録で変更します。"} testid="box-lot-dialog" onClose={onClose}>
      <div className="mt-2 space-y-2">
        <div className="grid grid-cols-2 gap-2">
          <label className="text-sm">
            購入日
            <input type="date" aria-label="購入日" value={date} disabled={!manual} onChange={(e) => setDate(e.target.value)} className={field} />
          </label>
          <label className="text-sm">
            購入元
            <input type="text" aria-label="購入元" maxLength={80} value={store} disabled={!manual} onChange={(e) => setStore(e.target.value)} className={field} />
          </label>
        </div>
        <label className="block text-sm">
          実際の購入価格（1BOX・円）
          <input type="text" inputMode="numeric" aria-label="実際の購入価格" value={actual} disabled={!manual} onChange={(e) => setActual(e.target.value)} className={field} />
        </label>
        <label className="block text-sm">
          購入時点の市場相場（1BOX・円）
          <input type="text" inputMode="numeric" aria-label="購入時点の市場相場" placeholder="不明は空欄" value={market} onChange={(e) => setMarket(e.target.value)} className={field} />
        </label>
        <div className="grid grid-cols-2 gap-2">
          <label className="text-sm">
            取得元
            <input type="text" aria-label="市場相場の取得元" maxLength={60} value={source} onChange={(e) => setSource(e.target.value)} className={field} />
          </label>
          <label className="text-sm">
            基準日
            <input type="date" aria-label="市場相場の基準日" value={mdate} onChange={(e) => setMdate(e.target.value)} className={field} />
          </label>
        </div>
        <label className="block text-sm">
          メモ
          <input type="text" aria-label="メモ" maxLength={500} value={note} onChange={(e) => setNote(e.target.value)} className={field} />
        </label>
      </div>
      {err(error)}
      <Actions busy={busy} onSave={() => void save()} label="保存" />
    </Shell>
  );
}

export type { StateCounts };
