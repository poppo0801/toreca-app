"use client";

import { useEffect, useRef, useState } from "react";
import { cn } from "@/lib/utils";

export interface ComboOption {
  key: string;
  /** 選ぶと入力欄に入る値 */
  value: string;
  /** 一覧での表示 */
  label: React.ReactNode;
}

/**
 * 候補つきの入力欄（レアリティ・番号）。**入力欄をタップすると候補の一覧を開き**、入力するたびに（先頭の1文字から）候補が絞り込まれる。
 * 候補を選ぶと onPick（収録セット・レアリティの自動補完など）を呼ぶ。一覧に無い値は**自由入力**できる（候補は強制ではない）。
 * 候補の並べ方・絞り込みは呼び出し側（options）が決める。タッチ操作で入力欄の焦点を失わないよう、選択は pointerdown で受ける。
 */
export function ComboInput({ value, onChange, options, onPick, className, maxLength, placeholder, testId, ariaLabel }: { value: string; onChange: (v: string) => void; options: ComboOption[]; onPick?: (o: ComboOption) => void; className?: string; maxLength?: number; placeholder?: string; testId?: string; ariaLabel?: string }) {
  const [open, setOpen] = useState(false);
  const wrap = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const away = (e: PointerEvent) => {
      if (!wrap.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", away);
    return () => document.removeEventListener("pointerdown", away);
  }, [open]);
  const show = open && options.length > 0;
  return (
    <div ref={wrap} className="relative">
      <input
        value={value}
        onChange={(e) => {
          onChange(e.target.value);
          setOpen(true);
        }}
        onFocus={() => setOpen(true)}
        onClick={() => setOpen(true)}
        onKeyDown={(e) => {
          if (e.key === "Escape") setOpen(false);
        }}
        className={className}
        maxLength={maxLength}
        placeholder={placeholder}
        autoComplete="off"
        role="combobox"
        aria-expanded={show}
        aria-autocomplete="list"
        aria-label={ariaLabel}
        data-testid={testId}
      />
      {show && (
        <ul role="listbox" className="absolute left-0 top-full z-40 mt-0.5 max-h-56 min-w-full overflow-y-auto rounded-md border bg-card py-0.5 shadow-lg" data-testid={testId ? `${testId}-options` : undefined}>
          {options.map((o) => (
            <li key={o.key} role="option" aria-selected={o.value === value}>
              <button
                type="button"
                className={cn("flex min-h-10 w-full items-center px-2.5 text-left text-sm active:bg-muted", o.value === value && "font-bold")}
                onPointerDown={(e) => {
                  e.preventDefault();
                  onChange(o.value);
                  onPick?.(o);
                  setOpen(false);
                }}
                onClick={(e) => e.preventDefault()}
                data-testid={testId ? `${testId}-option` : undefined}
              >
                {o.label}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
