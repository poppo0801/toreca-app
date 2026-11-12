"use client";

import { useMemo, useState } from "react";
import { useApp } from "@/components/app-provider";
import { Button } from "@/components/ui/button";
import { Sheet, SheetBody, SheetClose, SheetContent, SheetDescription, SheetTitle } from "@/components/ui/sheet";
import { groupBasis, lotteryLabel, suggestGroupMates } from "@/lib/lottery-group";
import type { Lottery, LotteryGroup } from "@/types/domain";

/** 解除の理由（Stage 8F）。AIがまとめたグループを外す・解除するときに選ぶ。記録され、同じ組を自動でまとめ直さないために使われる */
const REASONS = [
  { code: "different_campaign", label: "別の企画" },
  { code: "period_differs", label: "期間が違う" },
  { code: "conditions_differ", label: "条件が違う" },
  { code: "other", label: "その他" },
] as const;
type ReasonCode = (typeof REASONS)[number]["code"];

/** AIがまとめたグループの理由（basis に保存された、検証済みの根拠） */
function aiReason(group: LotteryGroup): { rationale: string; common: string[]; mismatches: string[]; confidence: number | null; auto: boolean } | null {
  if (group.origin !== "ai") return null;
  const b = group.basis as { rationale?: unknown; common?: unknown; mismatches?: unknown; confidence?: unknown; by?: unknown };
  const strs = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);
  const mm = Array.isArray(b.mismatches) ? (b.mismatches as { detail?: unknown }[]).map((m) => (typeof m?.detail === "string" ? m.detail : "")).filter(Boolean) : [];
  return {
    rationale: typeof b.rationale === "string" ? b.rationale : "",
    common: strs(b.common),
    mismatches: [...new Set(mm)],
    confidence: typeof b.confidence === "number" ? b.confidence : null,
    auto: b.by === "ai_auto",
  };
}

/**
 * 抽選グループの管理（Stage 8U-2。抽選詳細の「その他の操作」と、親カードの「グループを管理」から開く）。
 *  - グループに入っていない抽選: 同じ系列の他の抽選を選んで、新しいグループにまとめる（同じ企画の可能性があるものを「同じ企画の可能性」と示す。自動では選ばない）。
 *  - グループに入っている抽選: 所属一覧・店舗別に外す・グループ全体を解除・同じ系列の抽選を追加（別のグループの抽選は移す。誤ったグループ化の修正）。
 * 抽選ID・応募・当選の記録は変わらない。操作の履歴は残る（lottery_group_events）。AIがまとめたグループ（出所: ai）は、理由の表示と、解除の理由の記録（Stage 8F）がある。
 */
export function LotteryGroupSheet({ anchor, onClose }: { anchor: Lottery; onClose: () => void }) {
  const { data, actions } = useApp();
  const live = data.lotteries.find((l) => l.id === anchor.id) ?? anchor;
  // 開いた時点のグループ。「外す」で開いた抽選（anchor）自身が外れても、同じグループの管理を続けられる（グループが解散したときだけ、グループなしの表示になる）
  const [openedGroupId] = useState(anchor.groupId ?? null);
  const gid = live.groupId ?? openedGroupId;
  const group = gid ? data.lotteryGroups?.find((g) => g.id === gid) : undefined;
  const members = useMemo(() => (group ? data.lotteries.filter((l) => l.groupId === group.id) : []), [data.lotteries, group]);
  const sameChain = useMemo(() => data.lotteries.filter((l) => l.chainId === live.chainId && l.id !== live.id && (!group || l.groupId !== group.id)), [data.lotteries, live.chainId, live.id, group?.id]);
  const mates = useMemo(() => new Set(suggestGroupMates(live, sameChain).map((l) => l.id)), [live, sameChain]);
  const ordered = useMemo(() => [...sameChain].sort((a, b) => Number(mates.has(b.id)) - Number(mates.has(a.id))), [sameChain, mates]);
  const [picked, setPicked] = useState<string[]>([]);
  const [confirmDissolve, setConfirmDissolve] = useState(false);
  /** 理由の選択待ちのメンバー（AIがまとめたグループから外すとき）と、全体を解除するときの理由 */
  const [removing, setRemoving] = useState<string | null>(null);
  const [dissolveReason, setDissolveReason] = useState<ReasonCode | null>(null);
  const reason = group ? aiReason(group) : null;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const label = (l: Lottery) => lotteryLabel(l, data);

  const run = async (fn: () => Promise<{ ok: boolean; error?: string }>, after?: () => void) => {
    if (busy) return;
    setBusy(true);
    setError(null);
    const r = await fn();
    setBusy(false);
    if (!r.ok) return setError((r as { error?: string }).error ?? "操作できませんでした");
    setPicked([]);
    setConfirmDissolve(false);
    setRemoving(null);
    setDissolveReason(null);
    after?.();
  };
  const addOrCreate = () => {
    // グループ化の根拠（共通の項目・異なる項目）を記録する。店舗ごとのURL・条件の違いは許容する（手動・AIのどちらでも、あとから確認できる）
    const chosen = data.lotteries.filter((l) => picked.includes(l.id));
    const basis = groupBasis([live, ...chosen]) as unknown as Record<string, unknown>;
    return run(() => (group ? actions.groupLotteries(picked, { groupId: group.id, basis }) : actions.groupLotteries([live.id, ...picked], { basis })));
  };

  return (
    <Sheet open onOpenChange={(o) => !o && !busy && onClose()}>
      <SheetContent aria-describedby="lot-group-desc" data-testid="lottery-group-sheet">
        <div className="flex items-start gap-2 px-4 pb-2 pt-1">
          <div className="min-w-0 flex-1">
            <SheetTitle>{group ? "抽選グループ" : "グループにまとめる"}</SheetTitle>
            <SheetDescription id="lot-group-desc" className="truncate">
              {group ? `${members.length}店舗` : label(live)}
            </SheetDescription>
          </div>
          <SheetClose className="min-h-10 rounded-md px-2 text-sm text-muted-foreground hover:bg-muted">閉じる</SheetClose>
        </div>
        <SheetBody className="space-y-3 border-t pt-3 text-sm">
          {reason && (
            <details className="rounded-md border px-2 text-xs" data-testid="group-ai-reason">
              <summary className="min-h-10 cursor-pointer py-2.5 font-medium">
                {reason.auto ? "AIが自動でまとめました" : "AIの提案を承認してまとめました"}
                {reason.confidence !== null && <span className="ml-1.5 text-[10px] font-normal text-muted-foreground">信頼度 {reason.confidence}</span>}
              </summary>
              <div className="space-y-1 pb-2 text-muted-foreground">
                {reason.rationale && <p>{reason.rationale}</p>}
                {reason.common.length > 0 && <p>共通: {reason.common.join("・")}</p>}
                {reason.mismatches.length > 0 && <p className="text-warn">異なる点: {reason.mismatches.join("・")}</p>}
                <p>違っていたら、「外す」「グループ全体を解除」で直せます。理由を選ぶと、同じ組を自動でまとめ直さなくなります。</p>
              </div>
            </details>
          )}
          {group && (
            <section aria-label="所属" data-testid="group-members">
              <ul className="space-y-1">
                {members.map((l) => (
                  <li key={l.id} className="space-y-1" data-testid="group-member">
                    <div className="flex items-center gap-2">
                      <span className="min-w-0 flex-1 truncate text-xs">{label(l)}</span>
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() => (reason ? setRemoving(removing === l.id ? null : l.id) : void run(() => actions.ungroupLottery(l.id)))}
                        className="min-h-9 shrink-0 rounded-md border px-2 text-xs"
                        data-testid="group-remove"
                      >
                        外す
                      </button>
                    </div>
                    {reason && removing === l.id && (
                      <div className="flex flex-wrap items-center gap-1 pl-1" role="group" aria-label="外す理由" data-testid="group-remove-reasons">
                        <span className="text-[11px] text-muted-foreground">理由:</span>
                        {REASONS.map((r) => (
                          <button key={r.code} type="button" disabled={busy} onClick={() => void run(() => actions.ungroupLottery(l.id, { code: r.code }))} className="min-h-8 rounded-md border px-2 text-[11px]" data-testid={`group-remove-reason-${r.code}`}>
                            {r.label}
                          </button>
                        ))}
                        <button type="button" disabled={busy} onClick={() => void run(() => actions.ungroupLottery(l.id))} className="min-h-8 px-1 text-[11px] text-muted-foreground underline" data-testid="group-remove-noreason">
                          理由なし
                        </button>
                      </div>
                    )}
                  </li>
                ))}
              </ul>
              <p className="mt-1 text-[11px] text-muted-foreground">外しても、その抽選・応募・当選の記録は残ります。所属が1件だけになると、グループは自動で解除されます。</p>
            </section>
          )}
          <section aria-label="追加" data-testid="group-add">
            <p className="text-[13px] font-medium">{group ? "同じ系列の抽選を追加" : "一緒にまとめる抽選（同じ系列）"}</p>
            {ordered.length === 0 ? (
              <p className="mt-1 text-xs text-muted-foreground">同じ系列のほかの抽選がありません。</p>
            ) : (
              <ul className="mt-1 max-h-56 space-y-0.5 overflow-y-auto">
                {ordered.map((l) => (
                  <li key={l.id}>
                    <label className="flex min-h-11 items-center gap-2 text-xs">
                      <input type="checkbox" className="size-4" checked={picked.includes(l.id)} onChange={(e) => setPicked((p) => (e.target.checked ? [...p, l.id] : p.filter((x) => x !== l.id)))} data-testid="group-pick" />
                      <span className="min-w-0 flex-1 truncate">{label(l)}</span>
                      {mates.has(l.id) && <span className="shrink-0 rounded border border-info px-1 text-[10px] text-info">同じ企画の可能性</span>}
                      {l.groupId && l.groupId !== group?.id && <span className="shrink-0 text-[10px] text-warn">別グループから移す</span>}
                    </label>
                  </li>
                ))}
              </ul>
            )}
            <div className="mt-2 flex justify-end">
              <Button size="sm" disabled={busy || picked.length === 0 || (!group && picked.length < 1)} onClick={() => void addOrCreate()} data-testid="group-apply">
                {group ? `${picked.length}件を追加` : `${picked.length + 1}件でグループにする`}
              </Button>
            </div>
          </section>
          {group && (
            <section aria-label="解除">
              {!confirmDissolve ? (
                <button type="button" onClick={() => setConfirmDissolve(true)} className="min-h-10 text-xs text-danger underline" data-testid="group-dissolve-open">
                  グループ全体を解除
                </button>
              ) : (
                <div role="alert" className="space-y-2 rounded-md border border-warn p-2 text-xs" data-testid="group-dissolve-confirm">
                  <p>グループを解除します。{members.length}件の抽選はそのまま残り、応募・当選の記録は変わりません（通常のカードに戻ります）。</p>
                  {reason && (
                    <div className="flex flex-wrap items-center gap-1" role="group" aria-label="解除の理由" data-testid="group-dissolve-reasons">
                      <span className="text-[11px] text-muted-foreground">理由（任意）:</span>
                      {REASONS.map((r) => (
                        <button key={r.code} type="button" aria-pressed={dissolveReason === r.code} onClick={() => setDissolveReason(dissolveReason === r.code ? null : r.code)} className={`min-h-8 rounded-md border px-2 text-[11px] ${dissolveReason === r.code ? "border-primary bg-primary/10 font-bold" : ""}`} data-testid={`group-dissolve-reason-${r.code}`}>
                          {r.label}
                        </button>
                      ))}
                    </div>
                  )}
                  <div className="flex gap-2">
                    <Button size="sm" variant="danger" disabled={busy} onClick={() => void run(() => actions.dissolveLotteryGroup(group.id, dissolveReason ? { code: dissolveReason } : undefined), onClose)} data-testid="group-dissolve-run">
                      解除する
                    </Button>
                    <Button size="sm" variant="outline" onClick={() => setConfirmDissolve(false)}>
                      やめる
                    </Button>
                  </div>
                </div>
              )}
            </section>
          )}
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
