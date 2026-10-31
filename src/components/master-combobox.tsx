"use client";

import { useId, useMemo, useState, type ReactNode } from "react";
import { normName } from "@/lib/norm";
import { cn } from "@/lib/utils";

export interface MasterRef {
  id: string | null;
  name: string;
}

export interface MasterOption {
  id: string;
  name: string;
  hint?: string;
  /** 商品画像などの小さな見た目（任意） */
  thumb?: ReactNode;
}

/** 項目名の横に出す小さな「仮登録」バッジ（未登録の名称を入力したとき）。タップで短い説明を出す。常時の説明文は出さない */
export function NewMasterBadge({ show }: { show: boolean }) {
  const [open, setOpen] = useState(false);
  if (!show) return null;
  return (
    <span className="inline-flex items-center gap-1">
      <button
        type="button"
        data-testid="new-master-hint"
        aria-expanded={open}
        aria-label="仮登録（タップで詳細）"
        onClick={() => setOpen((v) => !v)}
        className="inline-flex min-h-6 items-center rounded-full border border-info px-1.5 text-[10px] font-medium leading-none text-info"
      >
        仮登録
      </button>
      {open && (
        <span role="status" className="text-[11px] font-normal text-muted-foreground">
          保存時にマスターへ仮登録されます
        </span>
      )}
    </span>
  );
}

/**
 * マスターの検索選択 + 自由入力。既存マスターを選ぶと id を持ち、未登録の名称を入力すると id=null（保存時に仮登録）。
 * 入力した名称が既存マスターと（全半角・空白の差を無視して）一致する場合は、自動的にその既存マスターを選んだ扱いにする。
 */
export function MasterCombobox({
  label,
  value,
  onChange,
  options,
  placeholder,
  disabled,
  className,
}: {
  label: string;
  value: MasterRef;
  onChange: (v: MasterRef) => void;
  options: MasterOption[];
  placeholder?: string;
  disabled?: boolean;
  className?: string;
}) {
  const [focused, setFocused] = useState(false);
  const listId = useId();
  const key = normName(value.name);
  const matches = useMemo(
    () => (key ? options.filter((o) => normName(o.name).includes(key)) : options).slice(0, 8),
    [options, key],
  );

  return (
    <div className={cn("relative text-sm", className)}>
      <input
        role="combobox"
        aria-label={label}
        aria-expanded={focused}
        aria-controls={listId}
        aria-autocomplete="list"
        autoComplete="off"
        disabled={disabled}
        value={value.name}
        placeholder={placeholder ?? "検索または新しい名称を入力"}
        onFocus={() => setFocused(true)}
        onBlur={() => window.setTimeout(() => setFocused(false), 120)}
        onChange={(e) => {
          const name = e.target.value;
          const hit = options.find((o) => normName(o.name) === normName(name));
          onChange(hit && normName(name) ? { id: hit.id, name } : { id: null, name });
        }}
        className="min-h-11 w-full rounded-md border bg-input px-3 text-sm"
      />
      {value.id !== null && <span className="sr-only">既存のマスターを選択中</span>}
      {focused && matches.length > 0 && !disabled && (
        <ul
          id={listId}
          role="listbox"
          aria-label={`${label}の候補`}
          className="absolute z-40 mt-1 max-h-56 w-full overflow-y-auto rounded-md border bg-card shadow-lg"
        >
          {matches.map((o) => (
            <li key={o.id} role="option" aria-selected={o.id === value.id}>
              <button
                type="button"
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => {
                  onChange({ id: o.id, name: o.name });
                  setFocused(false);
                }}
                className="flex min-h-11 w-full items-center justify-between gap-2 px-3 text-left hover:bg-muted"
              >
                {o.thumb && <span className="flex w-9 shrink-0 justify-center">{o.thumb}</span>}
                <span className="min-w-0 flex-1 truncate">{o.name}</span>
                {o.hint && <span className="shrink-0 text-xs text-muted-foreground">{o.hint}</span>}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
