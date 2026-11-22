"use client";

import { useMemo, useState } from "react";
import { Loader2 } from "lucide-react";
import { useApp } from "@/components/app-provider";
import { Button } from "@/components/ui/button";
import { normStore, parseAmount, RANKS, recentPairs, type PriceInput, type Rank, type StorePair } from "@/lib/zukan/zukan";
import { cn } from "@/lib/utils";

/** 日本時間の今日（YYYY-MM-DD） */
export const jstToday = (now: Date): string => new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Tokyo", year: "numeric", month: "2-digit", day: "2-digit" }).format(now);

/** 複数の価格を順に登録する（状態違いの一括登録）。途中で失敗したら止め、保存済みの件数を返す */
export async function addPricesSequentially(items: PriceInput[], addOne: (v: PriceInput) => Promise<{ ok: true } | { ok: false; error: string }>): Promise<{ done: number; error: string | null }> {
  let done = 0;
  for (const v of items) {
    const r = await addOne(v);
    if (!r.ok) return { done, error: done > 0 ? `${done + 1}件目で失敗しました（${done}件は保存済み）: ${r.error}` : r.error };
    done++;
  }
  return { done, error: null };
}

export interface PriceFormValue {
  storeName: string;
  chainName: string;
  surveyedOn: string;
  condition: Rank | "";
  price: string;
  note: string;
}

/** 価格入力の候補: 過去の「系列＋店舗」の組み合わせ（新しい順）と、系列・店舗の入力候補（過去の入力＋マスター） */
export function usePriceCandidates(records: readonly { chainName: string; storeName: string; surveyedOn: string }[]) {
  const app = useApp() as { data?: { chains?: { id: string; name: string; archived?: boolean }[]; stores?: { name: string; chainId: string; archived?: boolean }[] } };
  return useMemo(() => {
    const pairs = recentPairs(records, 6);
    const chains = app.data?.chains?.filter((c) => !c.archived) ?? [];
    const masterStores = app.data?.stores?.filter((s) => !s.archived) ?? [];
    const chainNames = [...new Set([...records.map((r) => r.chainName).filter(Boolean), ...chains.map((c) => c.name)])];
    const storesFor = (chain: string): string[] => {
      const key = normStore(chain);
      const fromHistory = records.filter((r) => !key || normStore(r.chainName) === key).map((r) => r.storeName);
      const chainIds = new Set(chains.filter((c) => normStore(c.name) === key).map((c) => c.id));
      const fromMaster = key ? masterStores.filter((s) => chainIds.has(s.chainId)).map((s) => s.name) : [];
      return [...new Set([...fromHistory, ...fromMaster])].slice(0, 80);
    };
    return { pairs, chainNames, storesFor };
  }, [records, app.data?.chains, app.data?.stores]);
}

/**
 * 価格記録の入力フォーム（151図鑑の価格調査・相場調査メモ共通）。**項目の順序は固定**:
 *   [top: カード名など] → 系列 → 店舗 → 調査日 → 販売価格 → 状態ランク →（状態違いの追加）→ 任意項目（optional スロット・備考）→ ボタン
 *  - 系列・店舗は**どちらも必須**。過去の「系列＋店舗」をワンタップで両方に反映できる候補ボタン。候補が無ければ手入力（マスター・履歴の入力候補つき）。
 *  - 調査日は今日、**状態ランクは A が初期選択**。自動フォーカス・プルダウンの自動展開はしない。送信中は二重に送らない。
 *  - 任意項目（収録セット・番号・レア・備考）は必須項目の下に置く。
 */
export function PriceForm({
  initial,
  pairs,
  chainNames,
  storesFor,
  today,
  top,
  optional,
  submitLabel = "記録する",
  onSubmit,
  onSubmitBatch,
  onCancel,
}: {
  initial?: Partial<PriceFormValue>;
  pairs: StorePair[];
  chainNames: string[];
  storesFor: (chain: string) => string[];
  today: string;
  /** 最上部（カード名など。必須項目の前） */
  top?: React.ReactNode;
  /** 任意項目（収録セット・番号・レア等。必須項目の下） */
  optional?: React.ReactNode;
  submitLabel?: string;
  onSubmit: (v: PriceInput) => Promise<string | null>;
  /** 指定すると「状態違いの価格を追加」が使える（新規登録のみ。編集では使わない） */
  onSubmitBatch?: (items: PriceInput[]) => Promise<string | null>;
  onCancel: () => void;
}) {
  const [v, setV] = useState<PriceFormValue>({ storeName: "", chainName: "", surveyedOn: today, condition: "A", price: "", note: "", ...initial });
  const multi = !!onSubmitBatch && !initial;
  const [extra, setExtra] = useState<{ condition: Rank | ""; price: string }[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const set = <K extends keyof PriceFormValue>(k: K, val: PriceFormValue[K]) => setV((c) => ({ ...c, [k]: val }));
  const field = "mt-0.5 h-10 w-full rounded-md border bg-input px-2.5 text-sm";
  const storeOptions = useMemo(() => storesFor(v.chainName), [storesFor, v.chainName]);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (busy) return;
    if (!v.chainName.trim()) return setError("系列を入力してください");
    if (!v.storeName.trim()) return setError("店舗を入力してください");
    const amount = parseAmount(v.price);
    if (amount === null) return setError("販売価格を入力してください");
    if (amount === "invalid") return setError("販売価格は0以上の整数で入力してください");
    if (!v.condition) return setError("状態ランクを選んでください");
    const base = { storeName: v.storeName, chainName: v.chainName, surveyedOn: v.surveyedOn, note: v.note };
    const items: PriceInput[] = [{ ...base, condition: v.condition, priceYen: amount }];
    // 状態違いの追加行: 空の行は無視。入力があるのに価格・状態が足りない／同じ状態の重複は保存前に止める
    const seen = new Set<string>([v.condition]);
    for (const [i, x] of extra.entries()) {
      if (!x.condition && x.price.trim() === "") continue;
      const a = parseAmount(x.price);
      if (!x.condition || a === null || a === "invalid") return setError(`追加の価格（${i + 1}行目）は、状態ランクと0以上の整数の価格を入力してください`);
      if (seen.has(x.condition)) return setError(`状態「${x.condition}」が重複しています。同じ状態は1行にまとめてください`);
      seen.add(x.condition);
      items.push({ ...base, condition: x.condition, priceYen: a });
    }
    setBusy(true);
    setError(null);
    const err = multi && items.length > 1 ? await onSubmitBatch!(items) : await onSubmit(items[0]);
    setBusy(false);
    if (err) setError(err);
  };

  return (
    <form onSubmit={submit} noValidate className="space-y-2 rounded-lg border bg-card p-2.5" data-testid="price-form">
      {top}
      <div className="space-y-1">
        {pairs.length > 0 && !initial && (
          <div className="flex flex-wrap gap-1" data-testid="pair-chips" aria-label="過去の系列と店舗">
            {pairs.map((p) => (
              <button
                key={`${p.chainName}|${p.storeName}`}
                type="button"
                onClick={() => setV((c) => ({ ...c, chainName: p.chainName, storeName: p.storeName }))}
                className={cn("min-h-8 max-w-full truncate rounded-full border px-2.5 text-xs", v.chainName === p.chainName && v.storeName === p.storeName && "border-primary text-primary-ink")}
                data-testid="pair-chip"
              >
                {p.chainName} {p.storeName}
              </button>
            ))}
          </div>
        )}
        <div className="grid grid-cols-2 gap-2">
          <label className="block text-sm">
            <span className="text-[13px] font-medium">系列</span>
            <input value={v.chainName} onChange={(e) => set("chainName", e.target.value)} list="price-chain-options" className={field} maxLength={80} autoComplete="off" data-testid="price-chain" />
            <datalist id="price-chain-options">
              {chainNames.map((c) => (
                <option key={c} value={c} />
              ))}
            </datalist>
          </label>
          <label className="block text-sm">
            <span className="text-[13px] font-medium">店舗</span>
            <input value={v.storeName} onChange={(e) => set("storeName", e.target.value)} list="price-store-options" className={field} maxLength={80} autoComplete="off" data-testid="price-store" />
            <datalist id="price-store-options">
              {storeOptions.map((s) => (
                <option key={s} value={s} />
              ))}
            </datalist>
          </label>
        </div>
      </div>
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
            <button key={r} type="button" role="radio" aria-checked={v.condition === r} onClick={() => set("condition", r)} className={cn("min-h-10 rounded-md border text-sm font-bold", v.condition === r ? "border-primary bg-primary text-primary-foreground" : "text-muted-foreground")}>
              {r}
            </button>
          ))}
        </div>
      </div>
      {multi &&
        extra.map((x, i) => (
          <div key={i} className="grid grid-cols-[1fr_1fr_auto] items-end gap-1.5" data-testid="price-extra-row">
            <label className="block text-sm">
              <span className="text-[13px] font-medium">状態</span>
              <select value={x.condition} onChange={(e) => setExtra((l) => l.map((y, j) => (j === i ? { ...y, condition: e.target.value as Rank | "" } : y)))} className={field}>
                <option value="">選択</option>
                {RANKS.map((r) => (
                  <option key={r}>{r}</option>
                ))}
              </select>
            </label>
            <label className="block text-sm">
              <span className="text-[13px] font-medium">価格（円）</span>
              <input value={x.price} onChange={(e) => setExtra((l) => l.map((y, j) => (j === i ? { ...y, price: e.target.value } : y)))} inputMode="numeric" className={field} />
            </label>
            <Button type="button" variant="ghost" size="sm" className="min-h-10" onClick={() => setExtra((l) => l.filter((_, j) => j !== i))} aria-label={`追加の価格${i + 1}行目を削除`}>
              削除
            </Button>
          </div>
        ))}
      {multi && extra.length < 4 && (
        <button type="button" onClick={() => setExtra((l) => [...l, { condition: "", price: "" }])} className="min-h-9 text-xs text-info underline" data-testid="price-extra-add">
          ＋状態違いの価格を追加
        </button>
      )}
      {/* 任意項目（必須項目の下） */}
      <div className="space-y-2 border-t pt-2" data-testid="price-optional">
        {optional}
        <label className="block text-sm">
          <span className="text-[13px] font-medium">備考（任意）</span>
          <input value={v.note} onChange={(e) => set("note", e.target.value)} className={field} maxLength={500} autoComplete="off" data-testid="price-note" />
        </label>
      </div>
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
