"use client";

import { useRef, useState } from "react";
import { setMarketLinkAction, updateMarketPricesAction, type MarketUpdateResult } from "@/app/(app)/collection/market-actions";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { MARKET_SOURCE_NAME, MARKET_SOURCE_URL } from "@/lib/market-price";
import type { MarketPriceRow } from "@/lib/collection";

const fmt = (iso: string | null) => (iso ? new Date(iso).toLocaleString("ja-JP", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" }) : "—");

/** 相場の最終更新（取得した相場のうち最新の取得日時） */
export const lastMarketUpdate = (market: MarketPriceRow[]): string | null => market.reduce<string | null>((a, m) => (!a || m.fetchedAt > a ? m.fetchedAt : a), null);

/**
 * 相場を一括更新（Stage 6G）。登録済みの全カードを、公開CSV 1回で照合する。手動の参考相場は変更しない。
 * 取得できない場合や許可を確認したくない場合は、CSVファイルを選んで取り込める。
 */
export function MarketUpdateDialog({ open, onOpenChange, cardCount, market, onDone }: { open: boolean; onOpenChange: (v: boolean) => void; cardCount: number; market: MarketPriceRow[]; onDone: () => void }) {
  const [busy, setBusy] = useState(false);
  const [res, setRes] = useState<MarketUpdateResult | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const file = useRef<HTMLInputElement>(null);
  const last = lastMarketUpdate(market);

  const run = async (opts: { csvText?: string; cardId?: string } = {}) => {
    setBusy(true);
    setErr(null);
    const r = await updateMarketPricesAction(opts);
    setBusy(false);
    if (r.ok) {
      setRes((cur) => (opts.cardId && cur ? { ...cur, ambiguous: cur.ambiguous.filter((a) => a.cardId !== opts.cardId), summary: { ...cur.summary, updated: cur.summary.updated + r.result.summary.updated, ambiguous: Math.max(0, cur.summary.ambiguous - 1) } } : r.result));
      onDone();
    } else setErr(r.error);
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

  const s = res?.summary;
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent data-testid="market-update">
        <DialogTitle>相場を一括更新</DialogTitle>
        <DialogDescription className="sr-only">登録済みのカードの販売・買取の参考相場をまとめて更新します</DialogDescription>
        <div className="space-y-3 text-sm">
          <p className="text-xs text-muted-foreground" data-testid="market-meta">
            対象 {cardCount}枚（種類） ／ 最終更新 {fmt(last)}
          </p>
          <div className="flex flex-wrap gap-2">
            <Button onClick={() => void run()} disabled={busy || cardCount === 0} data-testid="market-run">
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
          {s && res && (
            <div className="space-y-1.5 rounded-lg border p-2.5 text-xs" data-testid="market-result">
              <p className="font-medium">
                更新 {s.updated}・未掲載 {s.unlisted}・照合未確定 {s.ambiguous}・情報不足 {s.insufficient}
                {s.noPrice > 0 && `・価格なし ${s.noPrice}`}（全{s.total}件）
              </p>
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
            </div>
          )}
          <p className="text-[11px] text-muted-foreground">
            出典：
            <a href={MARKET_SOURCE_URL} target="_blank" rel="noopener noreferrer" className="underline">
              {MARKET_SOURCE_NAME}
            </a>
            の公開データ。各店舗の公開価格の参考値で、実際の取引価格や査定額を保証しません。手動で登録した参考相場は変更しません。
          </p>
        </div>
      </DialogContent>
    </Dialog>
  );
}
