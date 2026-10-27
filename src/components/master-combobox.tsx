"use client";

import { useId, useMemo, useState } from "react";
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
  const exact = key ? options.find((o) => normName(o.name) === key) : undefined;
  const isNew = value.id === null && value.name.trim().length > 0 && !exact;

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
      {isNew && (
        <p className="mt-0.5 text-xs text-info" data-testid="new-master-hint">
          未登録の名称です。保存時に「{value.name.trim()}」を仮登録します（後からマスター管理で補完できます）
        </p>
      )}
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
                <span className="truncate">{o.name}</span>
                {o.hint && <span className="shrink-0 text-xs text-muted-foreground">{o.hint}</span>}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
