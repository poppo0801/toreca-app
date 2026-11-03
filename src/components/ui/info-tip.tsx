"use client";

import { Info } from "lucide-react";
import { useId, useState } from "react";
import { cn } from "@/lib/utils";

/**
 * 項目名の右に置けない補足（段落の途中など）を、1行の「ⓘ 補足」に畳んで必要なときだけ開く。長い説明文を常時表示して画面を縦に伸ばさない。
 * 入力ミスや事故につながる重要な注意は、これに入れず常時表示すること。
 */
export function InfoNote({ text, className }: { text: React.ReactNode; className?: string }) {
  const [open, setOpen] = useState(false);
  return (
    <div className={className}>
      <button type="button" aria-expanded={open} onClick={() => setOpen((v) => !v)} data-testid="info-note" className="inline-flex min-h-6 items-center gap-1 text-[11px] text-muted-foreground hover:text-foreground">
        <Info className="size-3" aria-hidden="true" />
        補足
      </button>
      {open && <p className="mt-0.5 text-[11px] leading-relaxed text-muted-foreground">{text}</p>}
    </div>
  );
}

/**
 * 項目名の横に置く小さな「ⓘ」。タップしたときだけ説明を表示する（説明文を常時表示して画面を縦に伸ばさない）。
 * 入力ミスや事故につながる重要な注意は、これに入れず常時表示すること。
 * 説明はボタンの直下に出て、もう一度タップするか別の場所を押すと閉じる。
 */
export function InfoTip({ text, label = "説明", className }: { text: React.ReactNode; label?: string; className?: string }) {
  const [open, setOpen] = useState(false);
  const id = useId();
  return (
    <span className={cn("relative inline-flex align-middle", className)}>
      <button
        type="button"
        aria-label={`${label}を表示`}
        aria-expanded={open}
        aria-controls={id}
        data-testid="info-tip"
        onClick={() => setOpen((v) => !v)}
        onBlur={() => setOpen(false)}
        className="inline-flex size-5 items-center justify-center rounded-full text-muted-foreground hover:text-foreground"
      >
        <Info className="size-3.5" aria-hidden="true" />
      </button>
      {open && (
        <span id={id} role="note" className="absolute left-0 top-6 z-30 w-64 max-w-[80vw] rounded-md border bg-card p-2 text-xs font-normal leading-relaxed text-foreground shadow-md">
          {text}
        </span>
      )}
    </span>
  );
}
