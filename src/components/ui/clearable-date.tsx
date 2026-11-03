"use client";

import { X } from "lucide-react";
import { cn } from "@/lib/utils";

/** 入力済みの日付を空欄に戻す小さなクリアボタン（スマホの日付入力は誤入力を消しにくいため）。値が空のときは出さない */
export function DateClearButton({ label, onClear, className }: { label: string; onClear: () => void; className?: string }) {
  return (
    <button
      type="button"
      aria-label={`${label}をクリア`}
      title="クリア"
      data-testid="date-clear"
      onClick={onClear}
      className={cn("inline-flex size-6 shrink-0 items-center justify-center rounded-full border bg-input text-muted-foreground hover:bg-muted active:bg-muted", className)}
    >
      <X className="size-3.5" aria-hidden="true" />
    </button>
  );
}

/** クリアボタンつきの日付入力（日付だけの項目用） */
export function ClearableDateInput({ label, value, onChange, min, className }: { label: string; value: string; onChange: (v: string) => void; min?: string; className?: string }) {
  return (
    <div className="relative">
      <input
        type="date"
        aria-label={label}
        value={value}
        min={min}
        onChange={(e) => onChange(e.target.value)}
        className={cn("min-h-11 w-full min-w-0 rounded-md border bg-input px-1.5 pr-8 text-[13px]", className)}
      />
      {value !== "" && <DateClearButton label={label} onClear={() => onChange("")} className="absolute right-1.5 top-1/2 -translate-y-1/2" />}
    </div>
  );
}
