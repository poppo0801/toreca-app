"use client";

import { TriangleAlert } from "lucide-react";
import { cautionSummary, type Caution } from "@/lib/collector/attention";
import { cn } from "@/lib/utils";

/**
 * 注意付きで自動登録された抽選の小さな注意アイコン（Stage 7A）。注意が無い通常の抽選には何も出さない。
 * 店舗名の行の右端に置き、NEW・★・応募状態と重ならず、カードの高さも増やさない。詳細は抽選の詳細画面で項目別に確認できる。
 */
export function CautionMark({ cautions, className }: { cautions: Caution[] | undefined | null; className?: string }) {
  if (!cautions || cautions.length === 0) return null;
  const text = cautionSummary(cautions);
  return (
    <span role="img" aria-label={`注意あり: ${text}`} title={`注意あり: ${text}`} data-testid="caution-mark" className={cn("inline-flex shrink-0 items-center text-primary-ink", className)}>
      <TriangleAlert className="size-3.5" aria-hidden="true" />
    </span>
  );
}
