"use client";

import { Star } from "lucide-react";
import { useEffect, useState } from "react";
import { addPriceAction, deleteCardAction, deleteHoldingAction, getCardImageUrlAction, updateHoldingAction } from "@/app/(app)/collection/actions";
import { CardFormDialog } from "@/components/card-form";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { Sheet, SheetBody, SheetContent, SheetDescription, SheetTitle } from "@/components/ui/sheet";
import { useShine } from "@/components/shine";
import { conditionOptions, initialCondition, normalizeGrade } from "@/lib/card-condition";
import { GRADE_DESCRIPTION } from "@/lib/condition-value";
import { cardPriceState, jstDate, type CardRow, type CardSummaryRow, type HoldingRow, type MarketPriceRow, type PriceRow } from "@/lib/collection";
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
  market,
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
  /** 取得した相場（ポケカ価格比較のCSV。手動の参考相場とは別） */
  market: MarketPriceRow[];
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
  const shine = useShine(card.rarity, fx, { once: true });
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
              <div className={cn("relative flex max-h-[46dvh] w-[min(70%,18rem)] items-center justify-center overflow-hidden rounded-xl", shine.className)} data-testid="detail-image" {...shine.props}>
                {/* eslint-disable-next-line @next/next/no-img-element -- 期限つきURLの画像 */}
                {img ? <img src={img} alt={card.name} className="max-h-[46dvh] w-full object-contain" decoding="async" /> : <div className="flex h-52 w-full items-center justify-center rounded-xl border bg-muted text-xs text-muted-foreground">画像なし</div>}
              </div>
            </div>

            <dl className="grid grid-cols-2 gap-x-3 gap-y-2 rounded-lg border p-3 text-sm" aria-label="カード情報">
              <Item label="所持枚数" value={`${card.qty}枚`} />
              <Item label="収録パック" value={card.productName || "—"} />
              <Item label="購入額（合計）" value={card.costTotal === null ? "—" : `${yen(card.costTotal)}${card.costUnknownQty > 0 ? `（${card.costUnknownQty}枚は金額不明）` : ""}`} />
              <Item label="カードの種類" value={card.cardType || "—"} />
              <Item label="販売参考相場" value={priceText(card, "sale")} testId="ref-sale" />
              <Item label="買取参考相場" value={priceText(card, "buyback")} testId="ref-buyback" />
              <Item label="販売参考との差額" value={signed(card.saleDiff)} testId="diff-sale" />
              <Item label="買取参考との差額" value={signed(card.buybackDiff)} testId="diff-buyback" />
            </dl>
            <ValuationBlock card={card} />
            <MarketBlock rows={market.filter((m) => m.cardId === card.id)} card={card} />
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
                          <p className="text-xs text-muted-foreground">{[h.source, h.condition && (normalizeGrade(h.condition) ? `状態 ${normalizeGrade(h.condition)}` : `状態 旧表記「${h.condition}」`), h.note].filter(Boolean).join(" ・ ")}</p>
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

function Item({ label, value, testId, strong }: { label: string; value: React.ReactNode; testId?: string; /** 主要な金額として目立たせる（Stage 8U-1） */ strong?: boolean }) {
  return (
    <div className="min-w-0">
      <dt className="text-[11px] text-muted-foreground">{label}</dt>
      <dd className={strong ? "break-words text-base font-bold leading-snug" : "break-words"} data-testid={testId}>
        {value}
      </dd>
    </div>
  );
}

/** 取得した相場（販売・買取）。件数が1件のときは明示する。状態による補正はしない */
/** 状態別の評価額: 基準相場（補正前）と、状態補正後の評価額を区別して表示する。取得元・手動の相場そのものは変えない */
function ValuationBlock({ card }: { card: CardSummaryRow }) {
  const rows = [
    { key: "sale", label: "販売", base: card.saleBaseValue, adjusted: card.saleValue, lines: card.saleLines },
    { key: "buyback", label: "買取", base: card.buybackBaseValue, adjusted: card.buybackValue, lines: card.buybackLines },
  ].filter((r) => r.adjusted !== null && card.qty > 0);
  if (rows.length === 0) return null;
  return (
    <div className="space-y-1 rounded-lg border p-3 text-sm" data-testid="valuation-block">
      <p className="text-[13px] font-bold">状態別の評価額（所持{card.qty}枚）</p>
      {rows.map((r) => (
        <div key={r.key} className="space-y-0.5" data-testid={`valuation-${r.key}`}>
          <p className="flex justify-between gap-2 text-xs text-muted-foreground">
            <span>{r.label}・基準相場（補正前）</span>
            <span className="tabular-nums" data-testid={`valuation-${r.key}-base`}>{yen(r.base ?? 0)}</span>
          </p>
          <p className="flex justify-between gap-2">
            <span>{r.label}・評価額（状態補正後）</span>
            <span className="font-bold tabular-nums" data-testid={`valuation-${r.key}-adjusted`}>{yen(r.adjusted ?? 0)}</span>
          </p>
          <p className="text-[11px] text-muted-foreground">
            {r.lines.map((l) => `${l.grade}（${GRADE_DESCRIPTION[l.grade]}）${l.qty}枚×${yen(l.unitYen)}${l.source === "market" ? "（状態別の取得相場）" : l.pct === 100 ? "" : `（基準×${l.pct}%の推定）`}`).join(" ／ ")}
          </p>
        </div>
      ))}
      {card.conditionUnsetQty > 0 && <p className="text-[11px] text-warn" data-testid="valuation-unset">状態が未設定の{card.conditionUnsetQty}枚は、A（補正なし）として計算しています。</p>}
    </div>
  );
}

/** 参考相場の表示: 手動か取得か、取得日、店舗数（1店舗のみは明示） */
function priceText(card: CardSummaryRow, kind: "sale" | "buyback"): string {
  const manual = kind === "sale" ? card.sale : card.buyback;
  const mk = kind === "sale" ? card.saleMarket : card.buybackMarket;
  const src = kind === "sale" ? card.saleSource : card.buybackSource;
  if (src === "manual" && manual) return `${yen(manual.amountYen)}／枚（${manual.confirmedOn}${manual.source ? `・${manual.source}` : ""}・手動）`;
  if (src === "market" && mk) return `${yen(mk.medianYen)}／枚（取得 ${jstDate(mk.fetchedAt)}・${mk.sampleCount === 1 ? "1店舗のみ" : `${mk.sampleCount}店舗`}）`;
  if (src === "market") return "状態別の取得相場のみ";
  return "未設定";
}

function MarketBlock({ rows: all, card }: { rows: MarketPriceRow[]; card: CardSummaryRow }) {
  const state = cardPriceState(card);
  const rows = all.filter((r) => (r.conditionGrade ?? "A") === "A");
  const sale = rows.find((r) => r.kind === "sale");
  const buy = rows.find((r) => r.kind === "buyback");
  const fetched = rows.reduce<string | null>((a, r) => (!a || r.fetchedAt > a ? r.fetchedAt : a), null);
  const line = (r: MarketPriceRow | undefined, edge: "low" | "high") =>
    r ? `${yen(r.medianYen)}（${edge === "low" ? "最安" : "最高"} ${yen(edge === "low" ? r.lowYen : r.highYen)}・${r.sampleCount === 1 ? "参考データ1件" : `${r.sampleCount}店舗`}）` : "未取得";
  return (
    <div className="space-y-1" data-testid="market-block">
      {/* 主要な金額（販売＝買う価格・買取＝売る価格）を最も目立たせ、更新日時・情報源は下に小さく置く。取得できていない種類は「未取得」と明示する */}
      <dl className="grid grid-cols-2 gap-x-3 gap-y-2 rounded-lg border p-3 text-sm" aria-label="取得した相場">
        <Item label="販売相場（買う価格・取得）" value={line(sale, "low")} testId="market-sale" strong={!!sale} />
        <Item label="買取相場（売る価格・取得）" value={line(buy, "high")} testId="market-buy" strong={!!buy} />
        <Item label="更新（最終取得）" value={fetched ? new Date(fetched).toLocaleString("ja-JP", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" }) : "—"} />
        <Item label="参照サイト" value={rows[0] ? <a href={rows[0].sourceUrl ?? "https://card.pricebest.jp/data/"} target="_blank" rel="noopener noreferrer" className="underline">{rows[0].source || "ポケカ価格比較"}</a> : "—"} />
      </dl>
      {state.level !== "ok" && (
        <p className={cn("text-[11px]", state.level === "none" ? "text-muted-foreground" : "text-warn")} data-testid="price-state">
          価格の状況: {state.label}
          {state.detail ? `（${state.detail}）` : ""}
        </p>
      )}
      {(sale || buy) && <p className="text-[11px] text-muted-foreground">店舗の公開価格の中央値（状態A基準）です。補正前の基準相場で、状態別の評価額は上の欄に出します。実際の取引価格や査定額とは異なります。</p>}
    </div>
  );
}

function HoldingEditor({ h, onSave, onCancel }: { h: HoldingRow; onSave: (v: { quantity: number; acquiredOn: string; unitPriceYen: number | null; source: string; condition: string; note: string; purchaseId: string | null }) => void; onCancel: () => void }) {
  const [q, setQ] = useState(String(h.quantity));
  const [p, setP] = useState(h.unitPriceYen === null ? "" : String(h.unitPriceYen));
  const [d, setD] = useState(h.acquiredOn ?? "");
  const [s, setS] = useState(h.source);
  const [cond, setCond] = useState(initialCondition(h.condition));
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
        <label className="col-span-2 text-xs">
          状態
          <select value={cond} onChange={(e) => setCond(e.target.value)} className={field} data-testid="holding-condition">
            {conditionOptions(h.condition).map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
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
            onSave({ quantity: qty, acquiredOn: d, unitPriceYen: price, source: s, condition: cond, note: h.note, purchaseId: h.purchaseId });
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
