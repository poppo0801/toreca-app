"use client";

import { ArrowLeftRight, CircleHelp, TriangleAlert } from "lucide-react";
import { useApp } from "@/components/app-provider";
import { ProfileAvatar } from "@/components/profile-avatar";
import { evaluateChain, evaluateLottery, kindLabel, remainingLabel, STATE_LABEL, type CondState } from "@/lib/chain-conditions";
import { jstDateString } from "@/lib/datetime";
import { effectiveEventState } from "@/lib/eligibility";
import { myApplication } from "@/lib/lottery-flow";
import { cn } from "@/lib/utils";
import type { Lottery } from "@/types/domain";

/**
 * 抽選カードの資格の注意表示。問題があるときだけ出す（達成済み・条件未登録は何も出さない）。長い説明は出さず、詳細で確認する。
 *   未達成=警告 / 未確認=確認マーク / 登録条件と今回の告知が異なる=相違マーク。応募の記録は禁止しない（注意喚起のみ）。
 */
export function EligibilityMark({ lottery, className }: { lottery: Lottery; className?: string }) {
  const { data, profile, now } = useApp();
  const event = effectiveEventState(lottery, now);
  if (event === "closed" || event === "cancelled") return null;
  if (myApplication(data, lottery.id, profile.id)) return null; // 応募済みは不要
  const ev = evaluateLottery(data, lottery, profile.id, jstDateString(now));
  if (!ev) return null;
  const Warn = ev.overall === "unmet" ? TriangleAlert : ev.overall === "unknown" ? CircleHelp : null;
  if (!Warn && ev.mismatches.length === 0) return null;
  return (
    <span className={cn("inline-flex items-center gap-1", className)} data-testid="eligibility-mark" data-state={ev.overall} data-mismatch={ev.mismatches.length > 0 ? "1" : undefined}>
      {Warn && (
        <Warn className={cn("size-3.5", ev.overall === "unmet" ? "text-warn" : "text-muted-foreground")} role="img" aria-label={ev.overall === "unmet" ? "資格が未達成です（目安）" : "資格が未確認です（目安）"} />
      )}
      {ev.mismatches.length > 0 && <ArrowLeftRight className="size-3.5 text-info" role="img" aria-label="登録条件と今回の応募条件が異なります" />}
    </span>
  );
}

/** 詳細画面: プロフィールごとの資格状況と、登録条件との相違（展開して確認）。系列に条件が未登録なら何も出さない */
export function EligibilitySection({ lottery }: { lottery: Lottery }) {
  const { data, profile, now } = useApp();
  const today = jstDateString(now);
  const mine = evaluateLottery(data, lottery, profile.id, today);
  if (!mine) return null;
  const profiles = data.profiles.filter((p) => p.active !== false && (profile.kind !== "sub" || p.id === profile.id));
  return (
    <div className="space-y-1.5 border-t pt-2 text-xs" data-testid="eligibility-section">
      <p className="font-medium">系列の資格（目安）</p>
      <ul className="flex flex-wrap gap-x-3 gap-y-1">
        {profiles.map((p) => {
          const ev = p.id === profile.id ? mine : evaluateLottery(data, lottery, p.id, today);
          const s: CondState = ev?.overall ?? "unknown";
          return (
            <li key={p.id} className="inline-flex items-center gap-1 whitespace-nowrap" data-state={s}>
              <ProfileAvatar profile={p} size="xs" />
              <span className={s === "met" ? "text-success" : s === "unmet" ? "text-danger" : "text-muted-foreground"}>{STATE_LABEL[s]}</span>
            </li>
          );
        })}
      </ul>
      <ul className="space-y-0.5 text-muted-foreground">
        {evaluateChain(data, lottery.chainId, profile.id, { today }).results.map((r) => (
          <li key={r.cond.id}>
            {kindLabel(r.cond.kind)}
            {r.cond.label && `（${r.cond.label}）`}：{STATE_LABEL[r.state]}
            {r.purchase && r.purchase.remaining.kind !== "none" && `（${remainingLabel(r.purchase.remaining)}）`}
          </li>
        ))}
      </ul>
      {mine.mismatches.length > 0 && (
        <details data-testid="eligibility-mismatch" className="rounded-md border border-info/40 p-2">
          <summary className="flex min-h-8 cursor-pointer items-center gap-1 font-medium text-info">
            <ArrowLeftRight className="size-3.5" aria-hidden="true" />
            登録条件と今回の応募条件が異なります
          </summary>
          <ul className="list-disc space-y-0.5 pl-4 pt-1 text-foreground">
            {mine.mismatches.map((m) => (
              <li key={m}>{m}</li>
            ))}
          </ul>
          <p className="pt-1 text-muted-foreground">系列の登録条件は変更されません。今回の抽選の条件を優先して参考判定しています。</p>
        </details>
      )}
    </div>
  );
}
