"use client";

import { Star } from "lucide-react";
import { useEffect, useState } from "react";
import { addPriceAction, deleteCardAction, deleteHoldingAction, getCardImageUrlAction, updateHoldingAction } from "@/app/(app)/collection/actions";
import { CardFormDialog } from "@/components/card-form";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { Sheet, SheetBody, SheetContent, SheetDescription, SheetTitle } from "@/components/ui/sheet";
import { isShine, type CardRow, type CardSummaryRow, type HoldingRow, type PriceRow } from "@/lib/collection";
import { parseYen } from "@/lib/collection-input";
import { cn } from "@/lib/utils";

const yen = (n: number | null) => (n === null ? "—" : `${n.toLocaleString("ja-JP")}円`);
const signed = (n: number | null) => (n === null ? "—" : `${n > 0 ? "+" : ""}${n.toLocaleString("ja-JP")}円`);
const today = () => new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Tokyo" }).format(new Date());

/**
 * コレクションのカード詳細（下から開くパネル）。画像・カード情報・所持枚数・購入履歴・参考相場・購入額との差額。
 * 参考相場は確定した売却額ではなく、実際の収入・収支には計上しない。削除は「取得記録1件」と「カード全体」を区別する。
 * どちらも購入記録・収支には影響しない。
 */
export function CardDetailSheet({
  card,
  prices,
  allCards,
  thumbUrl,
  favorite,
  fx,
  actor,
  onOpenChange,
  onToggleFavorite,
  onChanged,
}: {
  card: CardSummaryRow;
  prices: PriceRow[];
  allCards: CardRow[];
  thumbUrl: string | null;
  favorite: boolean;
  fx: boolean;
  actor: string;
  onOpenChange: (v: boolean) => void;
  onToggleFavorite: () => void;
  onChanged: () => void;
}) {
  const [mainUrl, setMainUrl] = useState<string | null>(null);
  const [form, setForm] = useState<null | "edit" | "holding">(null);
  const [confirm, setConfirm] = useState<null | { kind: "card" } | { kind: "holding"; id: string }>(null);
  const [editH, setEditH] = useState<HoldingRow | null>(null);
  const [priceKind, setPriceKind] = useState<"sale" | "buyback">("sale");
  const [priceAmount, setPriceAmount] = useState("");
  const [priceSource, setPriceSource] = useState("");
  const [priceDate, setPriceDate] = useState(today());
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  useEffect(() => {
    let alive = true;
    if (card.imagePath) {
      getCardImageUrlAction(card.imagePath).then((r) => {
        if (alive && r.ok) setMainUrl(r.url);
      });
    }
    return () => {
      alive = false;
    };
  }, [card.imagePath]);

  const run = async (p: Promise<{ ok: true } | { ok: false; error: string }>, done: string) => {
    const r = await p;
    if (r.ok) {
      setMsg({ ok: true, text: done });
      onChanged();
    } else setMsg({ ok: false, text: r.error });
    return r.ok;
  };

  const addPrice = async () => {
    const amount = parseYen(priceAmount);
    if (amount === null || amount === "invalid") return setMsg({ ok: false, text: "価格は数字で入力してください" });
    const ok = await run(addPriceAction(card.id, { kind: priceKind, amountYen: amount, confirmedOn: priceDate, source: priceSource, sourceUrl: "" }, actor), "参考相場を登録しました");
    if (ok) setPriceAmount("");
  };

  const hist = prices.filter((p) => p.cardId === card.id).slice().sort((a, b) => b.confirmedOn.localeCompare(a.confirmedOn) || b.createdAt.localeCompare(a.createdAt)).slice(0, 8);
  const field = "mt-0.5 min-h-10 w-full rounded-md border bg-input px-2 text-sm";
  const shine = fx && isShine(card.rarity);
  const img = mainUrl ?? thumbUrl;

  return (
    <>
      <Sheet open onOpenChange={onOpenChange}>
        <SheetContent aria-describedby="card-detail-desc" data-testid="card-detail" onOpenAutoFocus={(e) => e.preventDefault()}>
          <div className="flex items-start gap-2 px-4 pb-2">
            <div className="min-w-0 flex-1">
              <SheetTitle className="text-sm">{card.name}</SheetTitle>
              <SheetDescription id="card-detail-desc">{[card.rarity, card.cardNumber, card.setCode].filter(Boolean).join(" ・ ") || "カードの詳細"}</SheetDescription>
            </div>
            <button type="button" onClick={onToggleFavorite} aria-pressed={favorite} aria-label={favorite ? "お気に入りを外す" : "お気に入りにする"} className="flex size-10 shrink-0 items-center justify-center rounded-md hover:bg-muted" data-testid="detail-fav">
              <Star className={cn("size-5", favorite ? "fill-primary stroke-primary" : "stroke-muted-foreground")} aria-hidden="true" />
            </button>
          </div>
          <SheetBody className="space-y-4 border-t pt-3">
            <div className="flex justify-center">
              <div className={cn("relative flex max-h-[46dvh] w-[min(70%,18rem)] items-center justify-center overflow-hidden rounded-xl", shine && "card-shine card-shine-once")} data-testid="detail-image">
                {/* eslint-disable-next-line @next/next/no-img-element -- 期限つきURLの画像 */}
                {img ? <img src={img} alt={card.name} className="max-h-[46dvh] w-full object-contain" decoding="async" /> : <div className="flex h-52 w-full items-center justify-center rounded-xl border bg-muted text-xs text-muted-foreground">画像なし</div>}
              </div>
            </div>

            <dl className="grid grid-cols-2 gap-x-3 gap-y-2 rounded-lg border p-3 text-sm" aria-label="カード情報">
              <Item label="所持枚数" value={`${card.qty}枚`} />
              <Item label="収録商品" value={card.productName || "—"} />
              <Item label="購入額（合計）" value={card.costTotal === null ? "—" : `${yen(card.costTotal)}${card.costUnknownQty > 0 ? `（${card.costUnknownQty}枚は金額不明）` : ""}`} />
              <Item label="カードの種類" value={card.cardType || "—"} />
              <Item label="販売参考相場" value={card.sale ? `${yen(card.sale.amountYen)}／枚（${card.sale.confirmedOn}${card.sale.source ? `・${card.sale.source}` : ""}）` : "未設定"} />
              <Item label="買取参考相場" value={card.buyback ? `${yen(card.buyback.amountYen)}／枚（${card.buyback.confirmedOn}${card.buyback.source ? `・${card.buyback.source}` : ""}）` : "未設定"} />
              <Item label="販売参考との差額" value={signed(card.saleDiff)} testId="diff-sale" />
              <Item label="買取参考との差額" value={signed(card.buybackDiff)} testId="diff-buyback" />
            </dl>
            <p className="-mt-2 text-[11px] text-muted-foreground">参考相場は確定した売却額ではありません（状態により変わります）。差額は購入価格が全枚数分そろい、相場が設定されているときだけ計算します。</p>

            <section aria-labelledby="hold-title" className="space-y-1.5">
              <div className="flex items-center justify-between">
                <h3 id="hold-title" className="text-[13px] font-bold">
                  購入・取得の履歴
                </h3>
                <Button type="button" size="sm" variant="outline" onClick={() => setForm("holding")}>
                  ＋所有記録を追加
                </Button>
              </div>
              {card.holdings.length === 0 ? (
                <p className="text-xs text-muted-foreground">所有記録はありません。</p>
              ) : (
                <ul className="divide-y rounded-lg border text-sm" data-testid="holdings">
                  {card.holdings.map((h) => (
                    <li key={h.id} className="space-y-1 p-2">
                      {editH?.id === h.id ? (
                        <HoldingEditor
                          h={editH}
                          onCancel={() => setEditH(null)}
                          onSave={async (v) => {
                            if (await run(updateHoldingAction(h.id, v, actor), "更新しました")) setEditH(null);
                          }}
                        />
                      ) : (
                        <>
                          <div className="flex items-center gap-2">
                            <span className="font-medium">{h.quantity}枚</span>
                            <span className="text-muted-foreground">{h.unitPriceYen === null ? "金額不明" : `${yen(h.unitPriceYen)}／枚`}</span>
                            <span className="ml-auto text-xs text-muted-foreground">{h.acquiredOn ?? "日付不明"}</span>
                          </div>
                          <p className="text-xs text-muted-foreground">{[h.source, h.condition, h.note].filter(Boolean).join(" ・ ")}</p>
                          <div className="flex gap-2">
                            <Button type="button" size="sm" variant="ghost" onClick={() => setEditH(h)}>
                              編集
                            </Button>
                            <Button type="button" size="sm" variant="ghost" onClick={() => setConfirm({ kind: "holding", id: h.id })}>
                              この記録を削除
                            </Button>
                          </div>
                        </>
                      )}
                    </li>
                  ))}
                </ul>
              )}
            </section>

            <section aria-labelledby="price-title" className="space-y-1.5">
              <h3 id="price-title" className="text-[13px] font-bold">
                参考相場の登録（手入力）
              </h3>
              <div className="grid grid-cols-2 gap-2">
                <label className="text-xs">
                  種類
                  <select value={priceKind} onChange={(e) => setPriceKind(e.target.value as "sale" | "buyback")} className={field} aria-label="相場の種類">
                    <option value="sale">販売参考相場</option>
                    <option value="buyback">買取参考相場</option>
                  </select>
                </label>
                <label className="text-xs">
                  価格（1枚・円）
                  <input inputMode="numeric" value={priceAmount} onChange={(e) => setPriceAmount(e.target.value)} className={field} aria-label="相場の価格" />
                </label>
                <label className="text-xs">
                  確認日
                  <input type="date" value={priceDate} onChange={(e) => setPriceDate(e.target.value)} className={field} aria-label="相場の確認日" />
                </label>
                <label className="text-xs">
                  情報源（店舗名など）
                  <input value={priceSource} onChange={(e) => setPriceSource(e.target.value)} className={field} aria-label="相場の情報源" maxLength={60} />
                </label>
              </div>
              <Button type="button" size="sm" onClick={addPrice} data-testid="price-add">
                相場を登録
              </Button>
              {hist.length > 0 && (
                <ul className="space-y-0.5 text-xs text-muted-foreground" data-testid="price-history" aria-label="相場の履歴">
                  {hist.map((p) => (
                    <li key={p.id}>
                      {p.confirmedOn} ・ {p.kind === "sale" ? "販売" : "買取"} {yen(p.amountYen)}
                      {p.source ? ` ・ ${p.source}` : ""}
                    </li>
                  ))}
                </ul>
              )}
            </section>

            {card.sourceUrl && <p className="text-xs text-muted-foreground">出典: {card.sourceUrl}</p>}
            {msg && (
              <p role={msg.ok ? "status" : "alert"} className={cn("text-xs", msg.ok ? "text-muted-foreground" : "text-danger")} data-testid="detail-msg">
                {msg.text}
              </p>
            )}
            <div className="flex flex-wrap gap-2 border-t pt-3">
              <Button type="button" variant="outline" onClick={() => setForm("edit")}>
                カード情報を編集
              </Button>
              <Button type="button" variant="danger" onClick={() => setConfirm({ kind: "card" })} data-testid="card-delete">
                カードを削除
              </Button>
            </div>
          </SheetBody>
        </SheetContent>
      </Sheet>

      {form && <CardFormDialog open onOpenChange={(v) => !v && setForm(null)} mode={form === "edit" ? { kind: "edit", card } : { kind: "holding", card }} cards={allCards} actor={actor} onSaved={onChanged} />}

      <Dialog open={confirm !== null} onOpenChange={(v) => !v && setConfirm(null)}>
        <DialogContent data-testid="card-confirm">
          <DialogTitle>{confirm?.kind === "card" ? "このカードを削除しますか？" : "この取得記録を削除しますか？"}</DialogTitle>
          <DialogDescription>
            {confirm?.kind === "card"
              ? "カードと、そのすべての所有記録・お気に入りをコレクションから外します。購入記録・収支の履歴は削除されません。"
              : "この取得記録（枚数・購入金額）を外します。カードは残り、購入記録・収支の履歴は削除されません。"}
          </DialogDescription>
          <div className="mt-4 flex justify-end gap-2">
            <Button variant="outline" onClick={() => setConfirm(null)}>
              キャンセル
            </Button>
            <Button
              variant="danger"
              data-testid="confirm-ok"
              onClick={async () => {
                const c = confirm;
                setConfirm(null);
                if (!c) return;
                if (c.kind === "card") {
                  if (await run(deleteCardAction(card.id, actor), "削除しました")) onOpenChange(false);
                } else await run(deleteHoldingAction(c.id, actor), "削除しました");
              }}
            >
              削除する
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}

function Item({ label, value, testId }: { label: string; value: string; testId?: string }) {
  return (
    <div className="min-w-0">
      <dt className="text-[11px] text-muted-foreground">{label}</dt>
      <dd className="break-words" data-testid={testId}>
        {value}
      </dd>
    </div>
  );
}

function HoldingEditor({ h, onSave, onCancel }: { h: HoldingRow; onSave: (v: { quantity: number; acquiredOn: string; unitPriceYen: number | null; source: string; condition: string; note: string; purchaseId: string | null }) => void; onCancel: () => void }) {
  const [q, setQ] = useState(String(h.quantity));
  const [p, setP] = useState(h.unitPriceYen === null ? "" : String(h.unitPriceYen));
  const [d, setD] = useState(h.acquiredOn ?? "");
  const [s, setS] = useState(h.source);
  const [err, setErr] = useState<string | null>(null);
  const field = "mt-0.5 min-h-10 w-full rounded-md border bg-input px-2 text-sm";
  return (
    <div className="space-y-1.5">
      <div className="grid grid-cols-2 gap-1.5">
        <label className="text-xs">
          枚数
          <input type="number" min={1} value={q} onChange={(e) => setQ(e.target.value)} className={field} aria-label="取得記録の枚数" />
        </label>
        <label className="text-xs">
          購入金額（1枚）
          <input inputMode="numeric" value={p} onChange={(e) => setP(e.target.value)} className={field} aria-label="取得記録の購入金額" />
        </label>
        <label className="text-xs">
          購入日
          <input type="date" value={d} onChange={(e) => setD(e.target.value)} className={field} />
        </label>
        <label className="text-xs">
          購入元
          <input value={s} onChange={(e) => setS(e.target.value)} className={field} maxLength={60} />
        </label>
      </div>
      {err && <p className="text-xs text-danger">{err}</p>}
      <div className="flex gap-2">
        <Button
          type="button"
          size="sm"
          onClick={() => {
            const price = parseYen(p);
            const qty = Number(q);
            if (price === "invalid" || !Number.isInteger(qty) || qty < 1) return setErr("枚数・購入金額を確認してください");
            onSave({ quantity: qty, acquiredOn: d, unitPriceYen: price, source: s, condition: h.condition, note: h.note, purchaseId: h.purchaseId });
          }}
        >
          保存
        </Button>
        <Button type="button" size="sm" variant="outline" onClick={onCancel}>
          キャンセル
        </Button>
      </div>
    </div>
  );
}
