"use client";

import { useRef, useState } from "react";
import type { MarketRunInfo } from "@/app/(app)/collection/actions";
import { setBoxMarketLinkAction, setMarketLinkAction, updateMarketPricesAction, type MarketUpdateResult } from "@/app/(app)/collection/market-actions";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { MARKET_SOURCE_NAME, MARKET_SOURCE_URL } from "@/lib/market-price";
import type { MarketPriceRow } from "@/lib/collection";

const fmt = (iso: string | null) => (iso ? new Date(iso).toLocaleString("ja-JP", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" }) : "—");
const yen = (n: number | null) => (n === null ? "—" : `${n.toLocaleString("ja-JP")}円`);

/** 相場の最終更新（取得した相場のうち最新の取得日時） */
export const lastMarketUpdate = (market: MarketPriceRow[]): string | null => market.reduce<string | null>((a, m) => (!a || m.fetchedAt > a ? m.fetchedAt : a), null);

const ERROR_KIND_TEXT: Record<string, string> = { network: "通信エラー", http: "取得元の応答エラー", format: "データの形式エラー", save: "保存エラー", other: "エラー" };

/**
 * 相場を一括更新（Stage 6G・7F）。登録済みの全カードと商品（BOX）を、公開CSV 1回で照合する。手動で登録した参考相場は変更しない。
 * 取得できない場合や許可を確認したくない場合は、CSVファイルを選んで取り込める。
 * BOXは、自動で確定できない商品だけ候補を示し、利用者が選んだ対応を保存して次回以降も使う。
 */
export function MarketUpdateDialog({
  open,
  onOpenChange,
  cardCount,
  boxCount = 0,
  market,
  lastAt,
  lastRun = null,
  onDone,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  cardCount: number;
  /** BOXの照合対象（商品）の数。表示用 */
  boxCount?: number;
  market: MarketPriceRow[];
  /** 最終更新（省略時は market から求める） */
  lastAt?: string | null;
  /** 直近の更新の結果。失敗していたら、取得済みの価格が古い可能性を示す */
  lastRun?: MarketRunInfo | null;
  /** 更新後に集計を取り直す。完了まで待つ */
  onDone: () => void | Promise<void>;
}) {
  const [busy, setBusy] = useState(false);
  const [res, setRes] = useState<MarketUpdateResult | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const file = useRef<HTMLInputElement>(null);
  const last = lastAt !== undefined ? lastAt : lastMarketUpdate(market);

  const run = async (opts: { csvText?: string; cardId?: string; productId?: string } = {}) => {
    setBusy(true);
    setErr(null);
    const r = await updateMarketPricesAction(opts);
    if (r.ok) {
      setRes((cur) => {
        if (!cur || (!opts.cardId && !opts.productId)) return r.result;
        if (opts.cardId) return { ...cur, ambiguous: cur.ambiguous.filter((a) => a.cardId !== opts.cardId), summary: { ...cur.summary, updated: cur.summary.updated + r.result.summary.updated, ambiguous: Math.max(0, cur.summary.ambiguous - 1) } };
        const done = r.result.box?.summary;
        return cur.box
          ? { ...cur, box: { ...cur.box, review: cur.box.review.filter((x) => x.productId !== opts.productId), priceRows: cur.box.priceRows + (r.result.box?.priceRows ?? 0), summary: { ...cur.box.summary, linkMatched: cur.box.summary.linkMatched + (done?.linkMatched ?? 0), priced: cur.box.summary.priced + (done?.priced ?? 0), needsReview: Math.max(0, cur.box.summary.needsReview - 1) } } }
          : cur;
      });
      await onDone();
      setBusy(false);
    } else {
      setBusy(false);
      setErr(r.error);
    }
  };

  const pickFile = async (f: File | undefined) => {
    if (!f) return;
    if (f.size > 5 * 1024 * 1024) return setErr("CSVが大きすぎます（5MBまで）");
    await run({ csvText: await f.text() });
    if (file.current) file.current.value = "";
  };

  const choose = async (cardId: string, key: string) => {
    setBusy(true);
    const l = await setMarketLinkAction(cardId, key);
    setBusy(false);
    if (!l.ok) return setErr(l.error);
    await run({ cardId });
  };

  const chooseBox = async (productId: string, key: string, name: string) => {
    setBusy(true);
    const l = await setBoxMarketLinkAction(productId, key, name);
    setBusy(false);
    if (!l.ok) return setErr(l.error);
    await run({ productId });
  };

  const s = res?.summary;
  const b = res?.box;
  const total = cardCount + boxCount;
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent data-testid="market-update">
        <DialogTitle>相場を一括更新</DialogTitle>
        <DialogDescription className="sr-only">登録済みのカードとBOXの販売・買取の参考相場をまとめて更新します</DialogDescription>
        <div className="space-y-3 text-sm">
          <p className="text-xs text-muted-foreground" data-testid="market-meta">
            対象 {[cardCount > 0 ? `カード${cardCount}種` : null, boxCount > 0 ? `商品${boxCount}件（BOX）` : null].filter(Boolean).join("・") || "なし"} ／ 最終更新 {fmt(last)}
          </p>
          {lastRun && !lastRun.ok && (
            <p className="text-xs text-warn" data-testid="market-last-failed">
              前回の更新（{fmt(lastRun.at)}）は失敗しました（{ERROR_KIND_TEXT[lastRun.errorKind ?? "other"] ?? "エラー"}）。取得済みの価格は消さず、最終更新{fmt(last)}のものを使っています。
            </p>
          )}
          <div className="flex flex-wrap gap-2">
            <Button onClick={() => void run()} disabled={busy || total === 0} data-testid="market-run">
              {busy ? "更新しています…" : `${MARKET_SOURCE_NAME}から更新`}
            </Button>
            <Button variant="outline" onClick={() => file.current?.click()} disabled={busy} data-testid="market-upload">
              CSVから取り込み
            </Button>
            <input ref={file} type="file" accept=".csv,text/csv" className="hidden" onChange={(e) => void pickFile(e.target.files?.[0])} data-testid="market-file" />
          </div>
          {err && (
            <p role="alert" className="text-xs text-danger" data-testid="market-error">
              {err}
            </p>
          )}
          {res && (
            <div className="space-y-1.5 rounded-lg border p-2.5 text-xs" data-testid="market-result">
              {s && s.total > 0 && (
                <p className="font-medium" data-testid="market-card-summary">
                  カード: 更新 {s.updated}・未掲載 {s.unlisted}・照合未確定 {s.ambiguous}・情報不足 {s.insufficient}
                  {s.noPrice > 0 && `・価格なし ${s.noPrice}`}（全{s.total}件）
                </p>
              )}
              {b && (
                <p className="font-medium" data-testid="market-box-summary">
                  BOX: 価格取得 {b.summary.priced}（販売 {b.summary.salePriced}・買取 {b.summary.buybackPriced}）・自動照合 {b.summary.autoMatched}・確定済み {b.summary.linkMatched}・要確認 {b.summary.needsReview}・未掲載 {b.summary.unlisted}
                  {b.summary.noPrice > 0 && `・価格なし ${b.summary.noPrice}`}（全{b.summary.total}件）
                  {b.summary.staleLinks > 0 && `・CSVに無い確定済みの対応 ${b.summary.staleLinks}`}
                </p>
              )}
              <p className="text-muted-foreground">
                {res.source === "upload" ? "アップロードしたCSV" : MARKET_SOURCE_NAME}：{res.csvRows}行／CSV更新 {fmt(res.csvUpdatedAt)}
              </p>
              {res.ambiguous.length > 0 && (
                <ul className="space-y-1.5 border-t pt-1.5" data-testid="market-ambiguous">
                  {res.ambiguous.map((a) => (
                    <li key={a.cardId} className="space-y-1">
                      <p>
                        {a.name}：{a.reason}
                      </p>
                      <div className="flex flex-wrap gap-1.5">
                        {a.variants.map((v) => (
                          <Button key={v.key} variant="outline" size="sm" disabled={busy} onClick={() => void choose(a.cardId, v.key)}>
                            {v.name}（{v.rarity || "—"}）を使う
                          </Button>
                        ))}
                      </div>
                    </li>
                  ))}
                </ul>
              )}
              {b && b.review.length > 0 && (
                <ul className="space-y-2 border-t pt-1.5" data-testid="market-box-review">
                  {b.review.map((x) => (
                    <li key={x.productId} className="space-y-1" data-testid="market-box-review-item">
                      <p className="font-medium">{x.name}</p>
                      <p className="text-muted-foreground">{x.reason}（価格はまだ登録していません）</p>
                      <ul className="space-y-1">
                        {x.candidates.map((cand) => (
                          <li key={cand.key} className="rounded-md border p-1.5">
                            <p>{cand.name}</p>
                            <p className="text-[11px] text-muted-foreground">
                              販売 {yen(cand.saleYen)}・買取 {yen(cand.buybackYen)}・{cand.shops}店舗 ／ {cand.reason}
                            </p>
                            <Button variant="outline" size="sm" className="mt-1" disabled={busy} onClick={() => void chooseBox(x.productId, cand.key, cand.name)} data-testid="market-box-choose">
                              この商品として登録
                            </Button>
                          </li>
                        ))}
                      </ul>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}
          <p className="text-[11px] text-muted-foreground">
            出典：
            <a href={MARKET_SOURCE_URL} target="_blank" rel="noopener noreferrer" className="underline">
              {MARKET_SOURCE_NAME}
            </a>
            の公開データ。各店舗の公開価格の参考値で、実際の取引価格や査定額を保証しません。手動で登録した参考相場は変更しません。提供元の再利用条件は確認できていないため、この画面の操作でだけ取得します（自動の定期取得はしません）。
          </p>
        </div>
      </DialogContent>
    </Dialog>
  );
}
