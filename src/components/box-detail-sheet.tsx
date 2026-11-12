"use client";

import { useMemo, useState } from "react";
import { ChevronDown } from "lucide-react";
import { addBoxPricesAction, adjustBoxAction, openBoxesAction, reclassifyBoxAction, revertBoxOpAction, updateBoxLotAction } from "@/app/(app)/collection/box-actions";
import { useApp } from "@/components/app-provider";
import { CountInput } from "@/components/count-input";
import { ProductThumb } from "@/components/product-image";
import { Button } from "@/components/ui/button";
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { Sheet, SheetBody, SheetContent, SheetDescription, SheetTitle } from "@/components/ui/sheet";
import {
  actualPurchaseTotal,
  availableStates,
  openedQtyOf,
  indexMarket,
  jstDateOf,
  type BoxMarketRow,
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
import { BOX_BASIS_LABEL, BOX_METHOD_LABEL } from "@/lib/box-market";
import { STATUS_TEXT, type MarketStatusRow } from "@/lib/collection";
import type { ShrinkState } from "@/types/domain";

const field = "mt-1 min-h-11 w-full rounded-md border bg-input px-3 text-sm";
const yen = (n: number | null) => (n === null ? "未取得" : `${n.toLocaleString("ja-JP")}円`);
const md = (d: string | null) => (d ? d.slice(5).replace("-", "/") : "—");
const BASIS: Record<string, string> = { actual: "状態別の相場", adjusted: "基準相場×補正", base: "基準相場（シュリンク状態を考慮しない）", none: "相場未取得" };
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

/**
 * 取得した相場（CSV）の内訳（Stage 8U-1 で整理）。情報の優先順位: ①主要な相場金額（買取＝売る価格・販売＝買う価格を、種類を混同しないよう別々に大きく）
 * ②更新日時・情報源・照合方法（常に小さく表示） ③補助情報（状態別・基準の見方）は折りたたみ。取得できていないときは、その状態と理由を明確に示す。手動の相場とは別。
 */
function MarketInfo({ productId, market, status, hasManual }: { productId: string; market: BoxMarketRow[]; status: MarketStatusRow | null; hasManual: boolean }) {
  const mine = market.filter((m) => m.productId === productId);
  if (mine.length === 0 && !status) return null;
  const fetched = mine.map((m) => m.fetchedAt).sort().at(-1) ?? null;
  const method = mine[0]?.matchMethod;
  const order = ["base", "no_shrink", "shrink"] as const;
  const rows = mine.slice().sort((a, b) => (a.kind === b.kind ? order.indexOf(a.basis) - order.indexOf(b.basis) : a.kind === "sale" ? -1 : 1));
  // 主要な金額: 買取・販売それぞれの「基準」（状態の指定なし）。基準が無い種類は、その種類で最初の行
  const primary = (["buyback", "sale"] as const).map((k) => {
    const of = rows.filter((m) => m.kind === k);
    return { kind: k, row: of.find((m) => m.basis === "base") ?? of[0] ?? null };
  });
  const rest = rows.filter((m) => !primary.some((p) => p.row === m));
  const KIND_TEXT = { buyback: "買取相場（売る価格）", sale: "販売相場（買う価格）" } as const;
  return (
    <section className="space-y-2 rounded-lg border p-3" aria-label="取得した相場" data-testid="box-market-info">
      {rows.length > 0 ? (
        <>
          <div className="grid grid-cols-2 gap-2">
            {primary.map(({ kind, row }) => (
              <div key={kind} data-testid={row ? `market-${kind}-${row.basis}` : `market-${kind}-none`} className={row?.sampleCount === 1 ? "text-warn" : undefined}>
                <p className="text-[11px] text-muted-foreground">{KIND_TEXT[kind]}</p>
                {row ? (
                  <>
                    <p className="text-lg font-bold tabular-nums leading-tight">{yen(row.medianYen)}</p>
                    <p className="text-[10px] text-muted-foreground">
                      {BOX_BASIS_LABEL[row.basis]}・{row.sampleCount === 1 ? "1店舗のみ" : `${row.sampleCount}店舗`}
                    </p>
                  </>
                ) : (
                  <p className="text-sm font-bold text-muted-foreground">未取得</p>
                )}
              </div>
            ))}
          </div>
          {rest.length > 0 && (
            <details className="text-xs" data-testid="box-market-more">
              <summary className="min-h-8 cursor-pointer text-muted-foreground">状態別の相場（{rest.length}件）</summary>
              <ul className="space-y-0.5 pt-1">
                {rest.map((m) => (
                  <li key={`${m.kind}${m.basis}`} data-testid={`market-${m.kind}-${m.basis}`} className={m.sampleCount === 1 ? "text-warn" : undefined}>
                    {m.kind === "sale" ? "販売" : "買取"}・{BOX_BASIS_LABEL[m.basis]} {yen(m.medianYen)}（{m.sampleCount === 1 ? "1店舗のみ" : `${m.sampleCount}店舗`}）
                  </li>
                ))}
              </ul>
            </details>
          )}
        </>
      ) : (
        <div data-testid="box-market-none">
          <p className="text-sm font-bold text-warn">相場は未取得です</p>
          <p className="text-xs text-muted-foreground">{status ? status.reason || STATUS_TEXT[status.status] : "取得した相場がありません"}</p>
        </div>
      )}
      <p className="text-[11px] text-muted-foreground" data-testid="box-market-meta">
        {fetched ? `更新 ${md(jstDateOf(fetched))}` : "更新: 未取得"} ・ 情報源: ポケカ価格比較
        {method ? ` ・ 照合: ${BOX_METHOD_LABEL[method]}` : ""}
        {hasManual ? " ・ 手動の相場があるため、評価には手動の相場を使います" : ""}
      </p>
      <details className="text-[11px] text-muted-foreground">
        <summary className="min-h-8 cursor-pointer">相場の見方</summary>
        <p className="pt-1">「未開封」「新品」の掲載は、シュリンクの有無を断定しない基準の価格として扱います。シュリンクの有無が明示された価格だけ、状態別の実価格に使います。1店舗のみの価格は参考値です。</p>
      </details>
    </section>
  );
}

type Sub = "open" | "adjust" | "state" | "price" | { lot: BoxLotRow } | null;

/**
 * BOXの詳細（下から開くパネル）。状態別の数量と評価、購入ロット（実購入価格・購入時点の市場相場）、在庫の履歴。
 * 開封・数量調整・相場の入力・ロットの編集はここから。売却は収支の売却記録（BOX・状態を選ぶと所有数が減る）で行う。
 */
export function BoxDetailSheet({
  row,
  prices,
  market,
  status,
  settings,
  movements,
  onOpenChange,
  onChanged,
}: {
  row: BoxSummaryRow;
  prices: BoxPriceRow[];
  market: BoxMarketRow[];
  status: MarketStatusRow[];
  settings: BoxSettings;
  movements: BoxMovementRow[];
  onOpenChange: (v: boolean) => void;
  onChanged: () => void;
}) {
  const { data } = useApp();
  const product = data.products.find((p) => p.id === row.productId);
  const latest = useMemo(() => latestPrices(prices), [prices]);
  const marketIdx = useMemo(() => indexMarket(market), [market]);
  const [sub, setSub] = useState<Sub>(null);
  const [error, setError] = useState<string | null>(null);
  const lotIds = new Set(row.lots.map((l) => l.lot.id));
  const history = movements.filter((m) => lotIds.has(m.lotId)).slice(0, 40);
  const reverted = new Set(movements.map((m) => m.revertsOp).filter(Boolean) as string[]);
  // 保有数（在庫）と開封済み数は別の数字（開封した分は保有数から減っている）。二重に数えない
  const openedQty = openedQtyOf(movements, lotIds);
  const purchase = actualPurchaseTotal(row.lots);
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
                <span data-testid="box-hold-line">保有 {row.qty}BOX ｜ 開封済み {openedQty}BOX</span>
                {row.releaseDate ? ` ・ 発売 ${row.releaseDate.replaceAll("-", "/")}` : ""}
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
                    <th className="py-1 text-right font-normal">買取単価</th>
                    <th className="py-1 text-right font-normal">買取合計</th>
                  </tr>
                </thead>
                <tbody>
                  {BOX_STATES.filter((s) => row.byState[s] > 0).map((s) => {
                    const b = unitBuyback(row.productId, s, latest, settings, marketIdx);
                    return (
                      <tr key={s} className="border-t" data-testid={`state-${s}`}>
                        <td className="py-1.5">
                          {BOX_STATE_LABEL[s]}
                          <span className="block text-[10px] text-muted-foreground">
                            {BASIS[b.basis]}
                            {b.source === "market" ? `・取得相場${b.samples === 1 ? "（1店舗のみ）" : `（${b.samples}店舗）`}` : b.source === "manual" ? "・手動" : ""}
                          </span>
                        </td>
                        <td className="py-1.5 text-right tabular-nums">{row.byState[s]}BOX</td>
                        <td className="py-1.5 text-right tabular-nums">{yen(b.amount)}</td>
                        <td className="py-1.5 text-right tabular-nums">{b.amount === null ? "未取得" : yen(b.amount * row.byState[s])}</td>
                      </tr>
                    );
                  })}
                </tbody>
                <tfoot>
                  <tr className="border-t-2 font-bold" data-testid="state-total">
                    <td className="py-1.5">合計</td>
                    <td className="py-1.5 text-right tabular-nums">{row.qty}BOX</td>
                    <td className="py-1.5 text-right text-muted-foreground">—</td>
                    <td className="py-1.5 text-right tabular-nums">{yen(row.buybackTotal)}</td>
                  </tr>
                </tfoot>
              </table>
              {row.buybackMissingQty > 0 && <p className="text-[11px] text-muted-foreground">{row.buybackMissingQty}BOXは相場が未取得のため、買取合計に含めていません。</p>}
              <p className="mt-1.5 text-sm font-bold" data-testid="box-purchase-total">
                購入総額：{purchase.total === null ? "未取得" : yen(purchase.total)}
                {purchase.total !== null && purchase.missingQty > 0 && <span className="ml-1 text-[11px] font-normal text-muted-foreground">（{purchase.missingQty}BOXは購入価格が未取得）</span>}
              </p>
              {row.buybackUnconfirmedQty > 0 && <p className="text-[11px] text-warn">シュリンク状態「－」の{row.buybackUnconfirmedQty}BOXは、基準相場のまま計算しています。</p>}
            </section>

            <MarketInfo productId={row.productId} market={market} status={status.find((x) => x.subjectId === row.productId) ?? null} hasManual={latest.has(`${row.productId}|`)} />

            <div className="flex flex-wrap gap-2" data-testid="box-ops">
              <Button size="sm" onClick={() => setSub("open")} data-testid="box-open-btn">
                開封済みにする
              </Button>
              <Button size="sm" variant="outline" onClick={() => setSub("price")} data-testid="box-price-btn">
                相場を入力
              </Button>
              <Button size="sm" variant="outline" onClick={() => setSub("state")} data-testid="box-state-btn">
                シュリンク変更
              </Button>
              <Button size="sm" variant="outline" onClick={() => setSub("adjust")} data-testid="box-adjust-btn">
                数量調整
              </Button>
            </div>
            {error && (
              <p role="alert" className="text-sm text-danger">
                {error}
              </p>
            )}

            <details aria-label="購入ロット" className="group rounded-lg border" data-testid="box-lots">
              <summary className="flex min-h-10 cursor-pointer list-none items-center justify-between px-3 text-xs font-bold" data-testid="box-lots-summary">
                購入ロット（{row.lots.length}件）
                <ChevronDown className="size-4 transition-transform group-open:rotate-180" aria-hidden="true" />
              </summary>
              <ul className="divide-y border-t">
                {row.lots.map(({ lot, counts }) => {
                  const qty = counts.shrink + counts.no_shrink + counts.unknown;
                  const amount = lot.actualUnitPrice === null ? null : lot.actualUnitPrice * qty;
                  return (
                    <li key={lot.id} className="px-3 py-1.5 text-xs" data-testid="box-lot">
                      <div className="flex items-center gap-x-2">
                        <span className="w-12 shrink-0 font-medium">{lot.acquiredOn ? md(lot.acquiredOn) : "日付不明"}</span>
                        <span className="min-w-0 flex-1 truncate">
                          {BOX_STATES.filter((st) => counts[st] > 0)
                            .map((st) => `${BOX_STATE_LABEL[st]}`)
                            .join("・") || "—"}
                        </span>
                        <span className="shrink-0 tabular-nums">{qty}BOX</span>
                        <span className="w-20 shrink-0 text-right tabular-nums">{yen(amount)}</span>
                        <button type="button" className="shrink-0 text-info underline" onClick={() => setSub({ lot })} data-testid="lot-edit">
                          詳細
                        </button>
                      </div>
                      <div className="mt-0.5 truncate text-[11px] text-muted-foreground">{lot.storeLabel || "購入元不明"}</div>
                    </li>
                  );
                })}
              </ul>
            </details>

            <details aria-label="在庫履歴" className="group rounded-lg border" data-testid="box-history">
              <summary className="flex min-h-10 cursor-pointer list-none items-center justify-between px-3 text-xs font-bold" data-testid="box-history-summary">
                在庫履歴（{history.length}件）
                <ChevronDown className="size-4 transition-transform group-open:rotate-180" aria-hidden="true" />
              </summary>
              <ul className="divide-y border-t text-xs">
                {history.length === 0 && <li className="px-3 py-2 text-muted-foreground">履歴はありません</li>}
                {history.map((m) => (
                  <li key={m.id} className="flex items-center gap-2 px-3 py-1.5">
                    <span className="w-11 shrink-0 text-muted-foreground">{md(m.occurredAt.slice(0, 10))}</span>
                    <span className="w-9 shrink-0">{m.revertsOp ? "取消" : KIND[m.kind]}</span>
                    <span className="shrink-0 tabular-nums">{m.qty > 0 ? `＋${m.qty}` : `－${-m.qty}`}BOX</span>
                    <span className="min-w-0 flex-1 truncate text-[11px] text-muted-foreground">{BOX_STATE_LABEL[m.state]}</span>
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
            </details>
          </SheetBody>
        </SheetContent>
      </Sheet>

      {sub === "open" && <OpenDialog row={row} onClose={() => setSub(null)} onDone={changed} />}
      {sub === "state" && <StateDialog row={row} onClose={() => setSub(null)} onDone={changed} />}
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

/**
 * 登録済みBOXのシュリンク状態の変更（Stage 6P）。対象のロット（購入）を選び、元の状態から新しい状態へ移す数量を指定する。
 * 所有数の合計は変わらず、購入・受取・売却の履歴は残る（変更は履歴に追記され、取り消せる）。評価額は新しい状態の相場で再計算される。
 * 受取で記録した実際の状態と違う状態にするときは、その旨を表示し、メモを残せる。
 */
function StateDialog({ row, onClose, onDone }: { row: BoxSummaryRow; onClose: () => void; onDone: () => void }) {
  const { profile } = useApp();
  const [lotId, setLotId] = useState(row.lots[0]?.lot.id ?? "");
  const lot = row.lots.find((l) => l.lot.id === lotId);
  const fromChoices = BOX_STATES.filter((s) => (lot?.counts[s] ?? 0) > 0);
  const [from, setFrom] = useState<ShrinkState>(fromChoices[0] ?? "unknown");
  const [to, setTo] = useState<ShrinkState>("shrink");
  const [qty, setQty] = useState(lot?.counts[from] ?? 1);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [opId] = useState(() => crypto.randomUUID());
  const pickLot = (id: string) => {
    setLotId(id);
    const l = row.lots.find((x) => x.lot.id === id);
    const f = BOX_STATES.find((s) => (l?.counts[s] ?? 0) > 0) ?? "unknown";
    setFrom(f);
    setQty(l?.counts[f] ?? 1);
  };
  const available = lot?.counts[from] ?? 0;
  const fromReceipt = lot?.lot.sourceKind === "purchase" && from !== "unknown";

  const save = async () => {
    if (!lotId) return;
    if (from === to) return setError("変更前と変更後の状態が同じです");
    if (qty < 1 || qty > available) return setError(`このロットの${BOX_STATE_LABEL[from]}は${available}BOXです。1〜${available}の範囲で入力してください`);
    setBusy(true);
    const r = await reclassifyBoxAction({ lotId, from, to, quantity: qty, opId, note }, profile.id);
    setBusy(false);
    if (!r.ok) return setError(r.error);
    onDone();
  };
  return (
    <Shell title="シュリンク状態を変更" desc="所有数は変わりません。購入・受取・売却の履歴は残り、この変更も履歴に記録されます。" testid="box-state-dialog" onClose={onClose}>
      <div className="mt-2 space-y-2">
        <label className="block text-sm">
          対象のロット（購入）
          <select aria-label="対象のロット" value={lotId} onChange={(e) => pickLot(e.target.value)} className={field}>
            {row.lots.map(({ lot: l, counts }) => (
              <option key={l.id} value={l.id}>
                {[l.acquiredOn?.replaceAll("-", "/") ?? "購入日不明", l.storeLabel, `計${counts.shrink + counts.no_shrink + counts.unknown}BOX`].filter(Boolean).join(" ・ ")}
              </option>
            ))}
          </select>
        </label>
        <div className="grid grid-cols-[1fr_1fr_4.5rem] gap-2">
          <label className="text-sm">
            変更前
            <select aria-label="変更前の状態" value={from} onChange={(e) => { const f = e.target.value as ShrinkState; setFrom(f); setQty(lot?.counts[f] ?? 1); }} className={field}>
              {fromChoices.map((s) => (
                <option key={s} value={s}>
                  {BOX_STATE_LABEL[s]}（{lot?.counts[s]}BOX）
                </option>
              ))}
            </select>
          </label>
          <label className="text-sm">
            変更後
            <select aria-label="変更後の状態" value={to} onChange={(e) => setTo(e.target.value as ShrinkState)} className={field}>
              {BOX_STATES.map((s) => (
                <option key={s} value={s}>
                  {BOX_STATE_LABEL[s]}
                </option>
              ))}
            </select>
          </label>
          <label className="text-sm">
            数量
            <CountInput aria-label="変更する数量" emptyValue={0} value={qty} onChange={setQty} className={`${field} text-center`} />
          </label>
        </div>
        {fromReceipt && from !== to && (
          <p className="text-[11px] text-warn" role="status" data-testid="box-state-receipt-note">
            受取で記録した状態（{BOX_STATE_LABEL[from]}）と異なる状態にします。受取の記録はそのまま残り、この変更が履歴に追記されます。
          </p>
        )}
        <label className="block text-sm">
          メモ（任意）
          <input type="text" aria-label="変更のメモ" maxLength={150} value={note} onChange={(e) => setNote(e.target.value)} className={field} />
        </label>
      </div>
      {err(error)}
      <Actions busy={busy} onSave={() => void save()} label="変更する" disabled={!lotId || fromChoices.length === 0} />
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
