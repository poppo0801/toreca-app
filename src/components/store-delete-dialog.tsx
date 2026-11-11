"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { setRetired } from "@/app/(app)/settings/masters/actions";
import { deleteStoreAction, storeReferencesAction } from "@/app/(app)/settings/masters/store-admin-actions";
import { useApp } from "@/components/app-provider";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { storeRefLines, storeRefTotal, type StoreRefCounts } from "@/lib/store-admin";

/**
 * 店舗の削除（Stage 7S）。削除前に、抽選・応募・購入などからの参照件数を表示する。
 * 参照が無い店舗だけ完全削除できる。参照がある店舗は削除せず、アーカイブ（非表示）にする（既存の履歴・統計・重複判定はそのまま。新規登録の候補からは外れる）。
 * アーカイブした店舗は「非表示を表示」で確認し、表示管理から再表示（復元）できる。
 */
export function StoreDeleteDialog({ storeId, name, archived, onClose }: { storeId: string; name: string; archived: boolean; onClose: () => void }) {
  const router = useRouter();
  const { profile } = useApp();
  const [counts, setCounts] = useState<StoreRefCounts | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    void storeReferencesAction(storeId).then((r) => {
      if (!live) return;
      if (r.ok) setCounts(r.counts);
      else setError(r.error);
    });
    return () => {
      live = false;
    };
  }, [storeId]);

  const refs = counts ? storeRefTotal(counts) : null;
  const run = async (fn: () => Promise<{ ok: boolean; error?: string }>) => {
    setBusy(true);
    setError(null);
    const r = await fn();
    setBusy(false);
    if (r.ok) {
      router.refresh();
      onClose();
    } else setError(r.error ?? "失敗しました");
  };

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent data-testid="store-delete-dialog">
        <DialogTitle>店舗「{name}」を削除</DialogTitle>
        <DialogDescription className="sr-only">削除前に参照の有無を確認します</DialogDescription>
        <div className="mt-2 space-y-2 text-sm">
          {counts === null && !error && <p className="text-muted-foreground">参照を調査しています…</p>}
          {counts && refs === 0 && <p data-testid="store-delete-ok">この店舗はどこからも参照されていません。削除できます（元に戻せません）。</p>}
          {counts && refs !== null && refs > 0 && (
            <div className="space-y-1.5" data-testid="store-delete-blocked">
              <p className="font-medium text-warn">この店舗は次のデータから参照されているため、完全には削除できません。</p>
              <ul className="list-inside list-disc text-xs">
                {storeRefLines(counts).map((l) => (
                  <li key={l}>{l}</li>
                ))}
              </ul>
              <p className="text-xs text-muted-foreground">履歴を壊さないため、削除ではなく「アーカイブ（非表示）」にできます。新規登録の候補から外れ、既存の記録・統計はそのまま残ります。「非表示を表示」から再表示できます。</p>
            </div>
          )}
          {error && (
            <p role="alert" className="text-sm text-danger">
              {error}
            </p>
          )}
        </div>
        <div className="mt-4 flex justify-end gap-2">
          <Button variant="outline" onClick={onClose} disabled={busy}>
            キャンセル
          </Button>
          {refs !== null && refs > 0 && !archived && (
            <Button variant="outline" disabled={busy} onClick={() => void run(() => setRetired("stores", storeId, true, profile.id))} data-testid="store-archive">
              アーカイブする
            </Button>
          )}
          {refs === 0 && (
            <Button variant="danger" disabled={busy} onClick={() => void run(() => deleteStoreAction(storeId))} data-testid="store-delete-confirm">
              削除する
            </Button>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
