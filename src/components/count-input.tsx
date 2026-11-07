"use client";

import { useState } from "react";
import { cn } from "@/lib/utils";

/**
 * 数量の入力欄（整数・0以上）。入力中は文字列のまま保持するので、数字を全部消して空欄にしてから別の数字を打てる。
 * 値が確定するのはフォーカスが外れたとき（空欄・不正値は emptyValue になる）。負数・小数・数字以外は入力できない。
 * onChange は入力のたびに、いま読み取れる数値（空欄は emptyValue）を返すので、保存時の検証は呼び出し側の値でそのまま行える。
 * スマホでは数字キーボードを表示する。
 */
export interface CountInputProps {
  value: number;
  onChange: (n: number) => void;
  /** 空欄・不正値で確定したときの値（既定 0） */
  emptyValue?: number;
  max?: number;
  className?: string;
  "aria-label"?: string;
  id?: string;
  disabled?: boolean;
  "data-testid"?: string;
}

/** 入力文字列を整数に（数字以外は取り除く。全角数字は半角にする）。読み取れなければ null */
export function parseCount(raw: string, max = 9999): number | null {
  const half = raw.replace(/[０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0)).replace(/[^0-9]/g, "");
  if (half === "") return null;
  return Math.min(Number(half), max);
}

export function CountInput({ value, onChange, emptyValue = 0, max = 9999, className, ...rest }: CountInputProps) {
  // 入力中の文字列。null の間は value をそのまま表示する（外から値が変わったときに追従する）
  const [text, setText] = useState<string | null>(null);
  return (
    <input
      type="text"
      inputMode="numeric"
      pattern="[0-9]*"
      autoComplete="off"
      value={text ?? String(value)}
      onChange={(e) => {
        const raw = e.target.value;
        const n = parseCount(raw, max);
        // 数字以外の文字は受け付けない（貼り付けも数字だけ残す）
        setText(n === null ? "" : String(n));
        onChange(n ?? emptyValue);
      }}
      onFocus={(e) => e.currentTarget.select()}
      onBlur={() => {
        setText(null);
      }}
      className={cn(className)}
      {...rest}
    />
  );
}
