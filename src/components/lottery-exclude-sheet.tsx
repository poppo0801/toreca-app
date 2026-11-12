"use client";

import { useMemo, useState } from "react";
import { useApp } from "@/components/app-provider";
import { Button } from "@/components/ui/button";
import { Sheet, SheetBody, SheetClose, SheetContent, SheetDescription, SheetTitle } from "@/components/ui/sheet";
import { EXCLUDE_REASONS, type ExcludeReason } from "@/lib/collector/user-rules";
import { lotteryLabel } from "@/lib/lottery-group";
import { cn } from "@/lib/utils";
import type { Lottery } from "@/types/domain";

/**
 * 登録済みの抽選の除外（Stage 8U-1）。抽選候補の除外と同じ理由の分類（地域・店舗／信頼性なし／エリア外系列／重複／別ゲーム／その他）を選ぶ。
 *  - 理由を選んで「除外する」。理由を選ばずに除外する場合は「理由を指定しないで除外」（理由なし=unspecified として記録）。
 *  - 重複を選んだら、どの抽選と重複しているか（同じ系列の抽選）を選ぶ。参照先は記録され、あとから追跡できる。
 *  - 抽選は削除しない（アーカイブ）。応募・当落・購入の履歴は保持される。ユーザー別の「スルー」とは別の操作。収集条件（ルール）は自動では変更しない。
 */
export function LotteryExcludeSheet({ lottery, onClose, onDone }: { lottery: Lottery; onClose: () => void; onDone: () => void }) {
  const { data, actions } = useApp();
  const [reason, setReason] = useState<ExcludeReason | null>(null);
  const [dupId, setDupId] = useState("");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const label = (l: Lottery) => lotteryLabel(l, data);
  // 重複の参照先: 同じ系列の、ほかの（除外されていない）抽選。同じ商品のものを先頭に
  const dupTargets = useMemo(() => {
    const mine = new Set(lottery.items.map((i) => i.productId));
    return data.lotteries
      .filter((l) => l.id !== lottery.id && l.chainId === lottery.chainId)
      .map((l) => ({ l, same: l.items.some((i) => mine.has(i.productId)) }))
      .sort((a, b) => Number(b.same) - Number(a.same))
      .map((x) => x.l);
  }, [data.lotteries, lottery]);

  const submit = async (code: ExcludeReason | "unspecified") => {
    if (busy) return;
    if (code === "duplicate" && !dupId) return setError("重複先の抽選を選択してください（見つからなければ「その他」を選んでください）");
    setBusy(true);
    setError(null);
    const res = await actions.excludeLottery(lottery.id, { reason: code, duplicateOfId: code === "duplicate" ? dupId : null, note: note.trim() });
    setBusy(false);
    if (!res.ok) return setError(res.error);
    onDone();
  };

  return (
    <Sheet open onOpenChange={(o) => !o && !busy && onClose()}>
      <SheetContent aria-describedby="lot-exclude-desc" data-testid="lottery-exclude-sheet">
        <div className="flex items-start gap-2 px-4 pb-2 pt-1">
          <div className="min-w-0 flex-1">
            <SheetTitle>除外の理由</SheetTitle>
            <SheetDescription id="lot-exclude-desc" className="truncate">
              {label(lottery)}
            </SheetDescription>
          </div>
          <SheetClose className="min-h-10 rounded-md px-2 text-sm text-muted-foreground hover:bg-muted">閉じる</SheetClose>
        </div>
        <SheetBody className="space-y-3 border-t pt-3">
          <div className="grid grid-cols-2 gap-2" role="radiogroup" aria-label="除外理由">
            {EXCLUDE_REASONS.map((r) => (
              <button
                key={r.code}
                type="button"
                role="radio"
                aria-checked={reason === r.code}
                disabled={busy}
                data-testid={`lot-reason-${r.code}`}
                onClick={() => {
                  setError(null);
                  setReason(r.code);
                }}
                className={cn("min-h-11 rounded-md border text-sm font-medium", reason === r.code ? "border-primary bg-primary text-primary-foreground" : "bg-input")}
              >
                {r.label}
              </button>
            ))}
          </div>
          {reason === "duplicate" && (
            <label className="block text-sm">
              <span className="text-[13px] font-medium">重複している抽選</span>
              <select value={dupId} onChange={(e) => setDupId(e.target.value)} className="mt-1 min-h-11 w-full rounded-md border bg-input px-3 text-sm" data-testid="lot-dup-target">
                <option value="">選択してください</option>
                {dupTargets.map((l) => (
                  <option key={l.id} value={l.id}>
                    {label(l)}
                  </option>
                ))}
              </select>
            </label>
          )}
          {reason && (
            <label className="block text-sm">
              <span className="text-[13px] font-medium">メモ（任意）</span>
              <input value={note} maxLength={200} onChange={(e) => setNote(e.target.value)} className="mt-1 min-h-11 w-full rounded-md border bg-input px-3 text-sm" data-testid="lot-exclude-note" />
            </label>
          )}
          {error && (
            <p role="alert" className="text-sm text-danger">
              {error}
            </p>
          )}
          <p className="text-[11px] text-muted-foreground">除外しても、応募・当落・購入の記録は残ります（一覧に表示されなくなります）。</p>
          <div className="flex items-center justify-between gap-2">
            <button type="button" disabled={busy} onClick={() => void submit("unspecified")} className="min-h-10 text-xs text-muted-foreground underline" data-testid="lot-exclude-unspecified">
              理由を指定しないで除外
            </button>
            <Button variant="danger" disabled={busy || !reason} onClick={() => reason && void submit(reason)} data-testid="lot-exclude-submit">
              {busy ? "除外中…" : "除外する"}
            </Button>
          </div>
        </SheetBody>
      </SheetContent>
    </Sheet>
  );
}
