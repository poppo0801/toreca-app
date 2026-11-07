"use client";

import { useEffect, useRef, useState } from "react";
import { cn } from "@/lib/utils";

export interface BarItem {
  id: string;
  /** 一覧と同じ短い分類名（カード／サプライ／経費） */
  label: string;
  amount: number;
  color: string;
}

const yen = (n: number) => `${n.toLocaleString("ja-JP")}円`;

/** 割合の表示。1%未満は「1%未満」（極端に小さい分類も確認できるようにする） */
export function percentLabel(amount: number, total: number): string {
  if (total <= 0) return "0%";
  const p = (amount / total) * 100;
  return p < 1 ? "1%未満" : `${Math.round(p)}%`;
}

/**
 * 支出の内訳を、分類別の割合を示す横長の1本のバーで表す（Stage 6R）。高さは約12px。
 * 色の部分をタップすると、その分類の金額と割合をバーの近くに小さく出す（レイアウトは押し下げない）。
 * 同じ色の再タップ・バー以外のタップで閉じ、別の色で切り替わる。金額0円の分類は描画しない。支出が0円なら「支出なし」。
 */
export function ExpenseBar({ items }: { items: BarItem[] }) {
  const [active, setActive] = useState<string | null>(null);
  const box = useRef<HTMLDivElement>(null);
  const shown = items.filter((i) => i.amount > 0);
  const total = shown.reduce((a, i) => a + i.amount, 0);

  useEffect(() => {
    if (!active) return;
    const close = (e: Event) => {
      if (!box.current?.contains(e.target as Node)) setActive(null);
    };
    document.addEventListener("pointerdown", close);
    return () => document.removeEventListener("pointerdown", close);
  }, [active]);
  // 期間・絞り込みで内訳が変わり、選択中の分類が無くなったら閉じる
  const current = active && shown.some((i) => i.id === active) ? active : null;

  if (total === 0) {
    return (
      <p className="text-[11px] text-muted-foreground" data-testid="expense-bar-empty">
        支出内訳: 支出なし
      </p>
    );
  }
  let before = 0;
  const centers = new Map<string, number>();
  for (const i of shown) {
    centers.set(i.id, ((before + i.amount / 2) / total) * 100);
    before += i.amount;
  }
  const sel = shown.find((i) => i.id === current);
  return (
    <div ref={box} className="relative" data-testid="expense-bar">
      <div className="flex items-center gap-2">
        <span className="shrink-0 text-[10px] text-muted-foreground">支出内訳</span>
        <div className="flex h-5 min-w-0 flex-1 items-center gap-px" role="group" aria-label="支出の内訳（分類別の割合）">
          {shown.map((i) => (
            <button
              key={i.id}
              type="button"
              aria-pressed={current === i.id}
              aria-label={`${i.label} ${yen(i.amount)}（${percentLabel(i.amount, total)}）`}
              onClick={() => setActive(current === i.id ? null : i.id)}
              className="flex h-5 items-center"
              style={{ flexGrow: i.amount, flexBasis: 0, minWidth: 8 }}
              data-testid={`bar-seg-${i.id}`}
            >
              <span className={cn("block h-3 w-full transition-opacity first:rounded-l-full last:rounded-r-full", current && current !== i.id && "opacity-45")} style={{ background: i.color }} />
            </button>
          ))}
        </div>
      </div>
      {sel && (
        <span
          role="status"
          className="absolute top-full z-20 mt-0.5 -translate-x-1/2 whitespace-nowrap rounded-md border bg-card px-2 py-0.5 text-[11px] shadow-md"
          style={{ left: `calc(2.9rem + (100% - 2.9rem) * ${Math.min(80, Math.max(20, centers.get(sel.id) ?? 50)) / 100})` }}
          data-testid="bar-tip"
        >
          <span aria-hidden="true" className="mr-1 inline-block size-2 rounded-full align-middle" style={{ background: sel.color }} />
          {sel.label}：{yen(sel.amount)}（{percentLabel(sel.amount, total)}）
        </span>
      )}
    </div>
  );
}
