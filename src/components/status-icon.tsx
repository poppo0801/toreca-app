import { Circle, CircleCheck, CircleDot, CircleX, Minus, SkipForward, TriangleAlert, type LucideIcon } from "lucide-react";
import { cn } from "@/lib/utils";
import type { AccountStatus } from "@/types/domain";

/** 応募状態の表示定義。アイコン＋色＋文言で示し、色だけに頼らない */
export const STATUS_META: Record<AccountStatus, { symbol: string; label: string; icon: LucideIcon; tone: string; hint: string }> = {
  applied: { symbol: "●", label: "応募済み", icon: CircleCheck, tone: "text-success", hint: "応募を記録済み" },
  eligible_unapplied: { symbol: "○", label: "未応募", icon: Circle, tone: "text-primary-ink", hint: "応募できる状態で、まだ応募していません" },
  covered_by_limit: { symbol: "◎", label: "枠充足", icon: CircleDot, tone: "text-info", hint: "家族・住所などの応募枠が埋まっています" },
  skipped: { symbol: "⤼", label: "スルー", icon: SkipForward, tone: "text-muted-foreground", hint: "このユーザーはスルー設定中です" },
  ineligible: { symbol: "－", label: "対象外", icon: Minus, tone: "text-muted-foreground", hint: "このユーザーの対象範囲の外です" },
  unavailable: { symbol: "✕", label: "応募不可", icon: CircleX, tone: "text-muted-foreground", hint: "受付前・受付終了・中止などで応募できません" },
  needs_review: { symbol: "！", label: "要確認", icon: TriangleAlert, tone: "text-warn", hint: "会員資格や応募制限が未確認で、判定を確定できません" },
};

export function StatusIcon({ status, className }: { status: AccountStatus; className?: string }) {
  const { icon: Icon, tone } = STATUS_META[status];
  return <Icon aria-hidden="true" strokeWidth={2.4} className={cn("size-[18px] shrink-0", tone, className)} />;
}

/** アイコンの意味の一覧（折りたたみで表示）。画面内で意味を確認できるようにする */
export function StatusLegend({ className }: { className?: string }) {
  return (
    <ul className={cn("grid grid-cols-2 gap-x-3 gap-y-1 text-xs", className)} aria-label="アイコンの意味">
      {(Object.keys(STATUS_META) as AccountStatus[]).map((k) => (
        <li key={k} className="flex items-center gap-1.5">
          <StatusIcon status={k} />
          <span className="font-medium">{STATUS_META[k].label}</span>
          <span className="hidden text-muted-foreground sm:inline">{STATUS_META[k].hint}</span>
        </li>
      ))}
    </ul>
  );
}
