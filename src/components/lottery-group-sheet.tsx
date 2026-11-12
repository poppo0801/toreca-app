"use client";

import { useMemo, useState } from "react";
import { useApp } from "@/components/app-provider";
import { Button } from "@/components/ui/button";
import { Sheet, SheetBody, SheetClose, SheetContent, SheetDescription, SheetTitle } from "@/components/ui/sheet";
import { groupBasis, lotteryLabel, suggestGroupMates } from "@/lib/lottery-group";
import type { Lottery } from "@/types/domain";

/**
 * 抽選グループの管理（Stage 8U-2。抽選詳細の「その他の操作」と、親カードの「グループを管理」から開く）。
 *  - グループに入っていない抽選: 同じ系列の他の抽選を選んで、新しいグループにまとめる（同じ企画の可能性があるものを「同じ企画の可能性」と示す。自動では選ばない）。
 *  - グループに入っている抽選: 所属一覧・店舗別に外す・グループ全体を解除・同じ系列の抽選を追加（別のグループの抽選は移す。誤ったグループ化の修正）。
 * 抽選ID・応募・当選の記録は変わらない。操作の履歴は残る（lottery_group_events）。AIによるグループ化は別（Stage 8F 以降）。
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
          {group && (
            <section aria-label="所属" data-testid="group-members">
              <ul className="space-y-1">
                {members.map((l) => (
                  <li key={l.id} className="flex items-center gap-2" data-testid="group-member">
                    <span className="min-w-0 flex-1 truncate text-xs">{label(l)}</span>
                    <button type="button" disabled={busy} onClick={() => void run(() => actions.ungroupLottery(l.id))} className="min-h-9 shrink-0 rounded-md border px-2 text-xs" data-testid="group-remove">
                      外す
                    </button>
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
                  <div className="flex gap-2">
                    <Button size="sm" variant="danger" disabled={busy} onClick={() => void run(() => actions.dissolveLotteryGroup(group.id), onClose)} data-testid="group-dissolve-run">
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
