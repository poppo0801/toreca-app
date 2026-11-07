"use client";

import { cn } from "@/lib/utils";

export type CollectionKind = "card" | "box";

/** コレクションの登録フォームの上部で、カード／BOXを切り替える（どちらも手動登録できる） */
export function RegisterKindSwitch({ value, onChange }: { value: CollectionKind; onChange: (k: CollectionKind) => void }) {
  return (
    <div role="tablist" aria-label="登録する種類" className="mb-2 grid grid-cols-2 rounded-lg border p-0.5 text-sm" data-testid="register-kind">
      {(["card", "box"] as const).map((k) => (
        <button
          key={k}
          type="button"
          role="tab"
          aria-selected={value === k}
          onClick={() => value !== k && onChange(k)}
          className={cn("min-h-9 rounded-md font-medium", value === k ? "bg-primary text-primary-foreground" : "text-muted-foreground")}
          data-testid={`register-kind-${k}`}
        >
          {k === "card" ? "カード" : "BOX"}
        </button>
      ))}
    </div>
  );
}
