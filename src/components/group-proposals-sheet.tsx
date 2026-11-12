"use client";

import { useState } from "react";
import { useApp } from "@/components/app-provider";
import { Button } from "@/components/ui/button";
import { Sheet, SheetBody, SheetClose, SheetContent, SheetDescription, SheetTitle } from "@/components/ui/sheet";
import { lotteryLabel } from "@/lib/lottery-group";
import type { LotteryGroupProposal } from "@/types/domain";

/**
 * AIが提示したグループ候補の確認（Stage 8F）。承認すると、手動のグループと同じ親子カードになる（出所: ai）。却下は記録され、同じ組は再提案されない。
 * 店舗ごとの抽選・応募・当選・購入・通知・期限は変わらない。理由・共通点・異なる点・信頼度は、AIの文章ではなく検証層が事実と照合して決めたもの。
 */
const SIGNAL_LABEL: Record<string, string> = { campaign: "同じキャンペーン", source_url: "同じ情報源のURL", phrase: "共通の企画名を確認" };

function ProposalCard({ p, busy, onDecide }: { p: LotteryGroupProposal; busy: boolean; onDecide: (id: string, d: "approve" | "reject") => void }) {
  const { data } = useApp();
  const byId = new Map(data.lotteries.map((l) => [l.id, l]));
  const ids = [...new Set(p.kind === "new_group" ? p.lotteryIds : [p.subjectId])];
  const target = p.targetGroupId ? data.lotteryGroups?.find((g) => g.id === p.targetGroupId) : undefined;
  const targetMembers = target ? data.lotteries.filter((l) => l.groupId === target.id) : [];
  const names = ids.map((id) => (byId.get(id) ? lotteryLabel(byId.get(id)!, data) : "（除外済み）"));
  const hard = p.mismatches.filter((m) => m.severity === "hard");
  const first = p.rationale.split(" / ")[0] || p.rationale;
  return (
    <li className="space-y-1.5 rounded-lg border bg-card p-2.5" data-testid="group-proposal">
      <p className="text-[13px] font-medium" data-testid="group-proposal-title">
        {p.kind === "new_group" ? `${ids.length}店舗をグループにまとめる` : `既存のグループ（${targetMembers.length}店舗）に追加`}
        <span className="ml-1.5 rounded border px-1 text-[10px] font-normal text-muted-foreground" data-testid="group-proposal-confidence">
          信頼度 {p.confidence}
        </span>
      </p>
      <p className="truncate text-xs text-muted-foreground">{names.join(" ／ ")}</p>
      <p className="text-xs">{first}</p>
      {p.common.length > 0 && <p className="text-[11px] text-muted-foreground">共通: {p.common.slice(0, 5).join("・")}</p>}
      {hard.length > 0 && (
        <p className="text-[11px] text-warn" data-testid="group-proposal-mismatch">
          異なる点: {[...new Set(hard.map((m) => m.detail))].slice(0, 3).join("・")}
        </p>
      )}
      <details className="text-[11px] text-muted-foreground">
        <summary className="min-h-8 cursor-pointer py-1">根拠の詳細</summary>
        <div className="space-y-1 pb-1">
          <p>{p.rationale}</p>
          <p>同じ企画の裏づけ: {p.strongSignals.length > 0 ? p.strongSignals.map((s) => SIGNAL_LABEL[s] ?? s).join("・") : "確認できていません"}</p>
          {p.missing.length > 0 && <p>不足している情報: {p.missing.join("・")}</p>}
          {p.mismatches.length > 0 && <p>相違・不足: {p.mismatches.map((m) => m.detail).join("・")}</p>}
        </div>
      </details>
      <div className="flex justify-end gap-2">
        <Button size="sm" variant="outline" disabled={busy} onClick={() => onDecide(p.id, "reject")} data-testid="group-proposal-reject">
          違う
        </Button>
        <Button size="sm" disabled={busy} onClick={() => onDecide(p.id, "approve")} data-testid="group-proposal-approve">
          まとめる
        </Button>
      </div>
    </li>
  );
}

export function GroupProposalsSheet({ onClose }: { onClose: () => void }) {
  const { data, actions } = useApp();
  const list = data.groupProposals ?? [];
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const decide = async (id: string, d: "approve" | "reject") => {
    if (busy) return;
    setBusy(true);
    setError(null);
    const r = await actions.decideGroupProposal(id, d);
    setBusy(false);
    if (!r.ok) setError((r as { error?: string }).error ?? "操作できませんでした");
  };
  return (
    <Sheet open onOpenChange={(o) => !o && !busy && onClose()}>
      <SheetContent aria-describedby="group-proposals-desc" data-testid="group-proposals-sheet">
        <div className="flex items-start gap-2 px-4 pb-2 pt-1">
          <div className="min-w-0 flex-1">
            <SheetTitle>グループ候補</SheetTitle>
            <SheetDescription id="group-proposals-desc" className="truncate">
              {list.length > 0 ? `${list.length}件。確認してまとめます` : "確認待ちの候補はありません"}
            </SheetDescription>
          </div>
          <SheetClose className="min-h-10 rounded-md px-2 text-sm text-muted-foreground hover:bg-muted">閉じる</SheetClose>
        </div>
        <SheetBody className="space-y-2 border-t pt-3 text-sm">
          {list.length === 0 ? (
            <p className="text-xs text-muted-foreground">確認待ちの候補はありません。</p>
          ) : (
            <ul className="space-y-2">
              {list.map((p) => (
                <ProposalCard key={p.id} p={p} busy={busy} onDecide={decide} />
              ))}
            </ul>
          )}
          <p className="text-[11px] text-muted-foreground">まとめても、店舗ごとの応募・当選・購入・期限はそのまま残ります。「違う」を選ぶと、同じ組は提案されなくなります。</p>
          {error && (
            <p role="alert" className="text-sm text-danger">
              {error}
            </p>
          )}
        </SheetBody>
      </SheetContent>
    </Sheet>
  );
}
