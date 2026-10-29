"use client";

import { AlertTriangle } from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * AI読み取り結果の「要確認」「仮登録」表示。項目名の横に小さな印だけを出し、
 * タップすると理由・原文の抜粋（解析の根拠）・マスター照合の結果を展開する（常時の長い警告文は出さない）。
 */
export type FlagEvidence = { quote: string; verified: boolean | null } | undefined;

/** 「マスターに無い…仮登録されます」だけの注意は「仮登録」、それ以外は「要確認」 */
export function flagKind(text: string): "仮登録" | "要確認" {
  return /仮登録されます/.test(text) && !text.includes(" / ") ? "仮登録" : "要確認";
}

export function FlagChip({ text, open, onToggle, panelId, label }: { text?: string; open: boolean; onToggle: () => void; panelId: string; label?: string }) {
  if (!text) return null;
  const kind = flagKind(text);
  return (
    <button
      type="button"
      onClick={onToggle}
      aria-expanded={open}
      aria-controls={panelId}
      aria-label={`${label ?? ""}${kind}（タップで詳細）`}
      data-testid="ai-flag"
      data-kind={kind}
      className={cn(
        "inline-flex min-h-6 items-center gap-0.5 rounded-full border px-1.5 text-[10px] font-medium leading-none",
        kind === "要確認" ? "border-warn text-warn" : "border-info text-info",
      )}
    >
      {kind === "要確認" && <AlertTriangle className="size-3" aria-hidden="true" />}
      {kind}
    </button>
  );
}

/** 展開した詳細（理由・原文の抜粋）。入力欄の値とは別に表示する */
export function FlagPanel({ id, text, evidence, open }: { id: string; text?: string; evidence?: FlagEvidence; open: boolean }) {
  if (!text || !open) return null;
  return (
    <div id={id} className="mt-1 space-y-1 rounded-md border bg-muted/50 p-2 text-[11px] leading-relaxed" data-testid="ai-flag-detail">
      <p>{text}</p>
      {evidence?.quote && (
        <p className="text-muted-foreground">
          原文: 「{evidence.quote}」{evidence.verified === false && <span className="text-warn">（原文に見当たりません）</span>}
        </p>
      )}
    </div>
  );
}
