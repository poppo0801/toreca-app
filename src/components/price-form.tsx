"use client";

import { useState } from "react";
import { Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { parseAmount, RANKS, type PriceInput, type Rank } from "@/lib/zukan/zukan";
import { cn } from "@/lib/utils";

/** 日本時間の今日（YYYY-MM-DD） */
export const jstToday = (now: Date): string => new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Tokyo", year: "numeric", month: "2-digit", day: "2-digit" }).format(now);

export interface PriceFormValue {
  storeName: string;
  chainName: string;
  surveyedOn: string;
  condition: Rank | "";
  price: string;
  note: string;
}

/**
 * 価格記録の入力フォーム（151図鑑の価格調査・相場調査メモ共通）。スマホで素早く入力できるよう、
 * 店舗は過去に入力した店舗をタップで再入力、状態ランクは5つのボタン（過去によく使ったものを先頭の候補に印）、調査日は今日が初期値。
 * 自動フォーカス・プルダウンの自動展開はしない。送信中は二重に送らない。
 */
export function PriceForm({ initial, stores, defaultRank, today, submitLabel = "記録する", onSubmit, onCancel }: { initial?: Partial<PriceFormValue>; stores: string[]; defaultRank: Rank | null; today: string; submitLabel?: string; onSubmit: (v: PriceInput) => Promise<string | null>; onCancel: () => void }) {
  const [v, setV] = useState<PriceFormValue>({ storeName: "", chainName: "", surveyedOn: today, condition: "", price: "", note: "", ...initial });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const set = <K extends keyof PriceFormValue>(k: K, val: PriceFormValue[K]) => setV((c) => ({ ...c, [k]: val }));
  const field = "mt-0.5 h-10 w-full rounded-md border bg-input px-2.5 text-sm";

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (busy) return;
    const amount = parseAmount(v.price);
    if (amount === null) return setError("販売価格を入力してください");
    if (amount === "invalid") return setError("販売価格は0以上の整数で入力してください");
    if (!v.condition) return setError("状態ランクを選んでください");
    setBusy(true);
    setError(null);
    const err = await onSubmit({ storeName: v.storeName, chainName: v.chainName, surveyedOn: v.surveyedOn, condition: v.condition, priceYen: amount, note: v.note });
    setBusy(false);
    if (err) setError(err);
  };

  return (
    <form onSubmit={submit} noValidate className="space-y-2.5 rounded-lg border bg-card p-3" data-testid="price-form">
      <label className="block text-sm">
        <span className="text-[13px] font-medium">店舗</span>
        <input value={v.storeName} onChange={(e) => set("storeName", e.target.value)} className={field} maxLength={80} placeholder="店舗名" autoComplete="off" data-testid="price-store" />
        {stores.length > 0 && (
          <span className="mt-1 flex flex-wrap gap-1" data-testid="store-chips">
            {stores.map((s) => (
              <button key={s} type="button" onClick={() => set("storeName", s)} className={cn("min-h-8 rounded-full border px-2.5 text-xs", v.storeName === s && "border-primary text-primary-ink")}>
                {s}
              </button>
            ))}
          </span>
        )}
      </label>
      <div className="grid grid-cols-2 gap-2">
        <label className="block text-sm">
          <span className="text-[13px] font-medium">調査日</span>
          <input type="date" value={v.surveyedOn} onChange={(e) => set("surveyedOn", e.target.value)} className={field} data-testid="price-date" />
        </label>
        <label className="block text-sm">
          <span className="text-[13px] font-medium">販売価格（円）</span>
          <input value={v.price} onChange={(e) => set("price", e.target.value)} inputMode="numeric" className={field} placeholder="例: 1200" data-testid="price-yen" />
        </label>
      </div>
      <div className="text-sm">
        <span className="text-[13px] font-medium">状態ランク</span>
        <div role="radiogroup" aria-label="状態ランク" className="mt-0.5 grid grid-cols-5 gap-1" data-testid="price-rank">
          {RANKS.map((r) => (
            <button key={r} type="button" role="radio" aria-checked={v.condition === r} onClick={() => set("condition", r)} className={cn("relative min-h-10 rounded-md border text-sm font-bold", v.condition === r ? "border-primary bg-primary text-primary-foreground" : "text-muted-foreground")}>
              {r}
              {defaultRank === r && v.condition !== r && <span className="absolute -right-0.5 -top-0.5 size-2 rounded-full bg-info" title="よく使う状態" aria-hidden="true" />}
            </button>
          ))}
        </div>
      </div>
      <label className="block text-sm">
        <span className="text-[13px] font-medium">系列（任意）・備考（任意）</span>
        <input value={v.chainName} onChange={(e) => set("chainName", e.target.value)} className={field} maxLength={80} placeholder="系列" autoComplete="off" />
        <input value={v.note} onChange={(e) => set("note", e.target.value)} className={cn(field, "mt-1")} maxLength={500} placeholder="備考" autoComplete="off" />
      </label>
      {error && (
        <p role="alert" className="text-xs text-danger" data-testid="price-error">
          {error}
        </p>
      )}
      <div className="flex gap-2">
        <Button type="button" variant="outline" className="min-h-10 flex-1" onClick={onCancel} disabled={busy}>
          キャンセル
        </Button>
        <Button type="submit" className="min-h-10 flex-1" disabled={busy} data-testid="price-submit">
          {busy && <Loader2 className="size-4 animate-spin" aria-hidden="true" />} {submitLabel}
        </Button>
      </div>
    </form>
  );
}
