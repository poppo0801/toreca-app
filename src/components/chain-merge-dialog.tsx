"use client";

import { useRouter } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import { setRetired } from "@/app/(app)/settings/masters/actions";
import { chainReferencesAction, deleteChainAction, mergeChainsAction, previewChainMergeAction } from "@/app/(app)/settings/masters/chain-merge-actions";
import { useApp } from "@/components/app-provider";
import { MasterCombobox, type MasterRef } from "@/components/master-combobox";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { CHAIN_HISTORY_KEYS as HISTORY_KEYS, chainRefLines as refLines, chainRefTotal as historyTotal, type ChainRefCounts as RefCounts } from "@/lib/chain-merge";

/**
 * 系列マスターの削除（Stage 6Q）。削除前に、店舗・抽選・購入・BOXなどからの参照を調べて表示する。
 * 参照が無い系列だけ削除できる。参照がある系列は削除せず（履歴を連鎖削除しない）、非表示にすることを提案する。
 */
export function ChainDeleteButton({ chainId, name }: { chainId: string; name: string }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button size="sm" variant="outline" onClick={() => setOpen(true)} aria-label={`${name}を削除`} data-testid="chain-delete-open">
        削除
      </Button>
      {open && <ChainDeleteDialog chainId={chainId} name={name} onClose={() => setOpen(false)} />}
    </>
  );
}

function ChainDeleteDialog({ chainId, name, onClose }: { chainId: string; name: string; onClose: () => void }) {
  const router = useRouter();
  const { profile } = useApp();
  const [counts, setCounts] = useState<RefCounts | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    void chainReferencesAction(chainId).then((r) => {
      if (!live) return;
      if (r.ok) setCounts(r.counts);
      else setError(r.error);
    });
    return () => {
      live = false;
    };
  }, [chainId]);

  const refs = counts ? historyTotal(counts) : null;
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
      <DialogContent data-testid="chain-delete-dialog">
        <DialogTitle>系列「{name}」を削除</DialogTitle>
        <DialogDescription className="sr-only">削除前に参照の有無を確認します</DialogDescription>
        <div className="mt-2 space-y-2 text-sm">
          {counts === null && !error && <p className="text-muted-foreground">参照を調査しています…</p>}
          {counts && refs === 0 && <p data-testid="chain-delete-ok">この系列はどこからも参照されていません。削除できます（元に戻せません）。</p>}
          {counts && refs !== null && refs > 0 && (
            <div className="space-y-1.5" data-testid="chain-delete-blocked">
              <p className="font-medium text-warn">この系列は次のデータから参照されているため、削除できません。</p>
              <ul className="list-inside list-disc text-xs">
                {refLines(counts, HISTORY_KEYS).map((l) => (
                  <li key={l}>{l}</li>
                ))}
              </ul>
              <p className="text-xs text-muted-foreground">履歴を壊さないため、削除ではなく「非表示」にできます（新規登録の候補から外れ、既存の記録はそのまま残ります）。同じ系列の重複なら「既存系列に統合」を使ってください。</p>
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
          {refs !== null && refs > 0 && (
            <Button variant="outline" disabled={busy} onClick={() => void run(() => setRetired("chains", chainId, true, profile.id))} data-testid="chain-hide">
              非表示にする
            </Button>
          )}
          {refs === 0 && (
            <Button variant="danger" disabled={busy} onClick={() => void run(() => deleteChainAction(chainId))} data-testid="chain-delete-confirm">
              削除する
            </Button>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}

/**
 * 既存系列への統合（Stage 6Q）。同じ系列が別名称で重複登録されているとき、統合元の参照（店舗・抽選・応募・購入・BOXなど）を統合先へ付け替える。
 * 履歴は削除せず、統合元は非表示で残り、名前は統合先の別名になる。確定前に影響件数を表示する。
 */
export function ChainMergeButton({ chainId, name }: { chainId: string; name: string }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button size="sm" variant="outline" onClick={() => setOpen(true)} aria-label={`${name}を既存系列に統合`} data-testid="chain-merge-open">
        既存系列に統合
      </Button>
      {open && <ChainMergeDialog fromId={chainId} name={name} onClose={() => setOpen(false)} />}
    </>
  );
}

function ChainMergeDialog({ fromId, name, onClose }: { fromId: string; name: string; onClose: () => void }) {
  const router = useRouter();
  const { data, profile } = useApp();
  const [target, setTarget] = useState<MasterRef>({ id: null, name: "" });
  const [preview, setPreview] = useState<{ from: RefCounts; into: RefCounts } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);

  const options = useMemo(() => data.chains.filter((c) => c.id !== fromId && !c.archived).map((c) => ({ id: c.id, name: c.name })), [data.chains, fromId]);
  const into = target.id ? data.chains.find((c) => c.id === target.id) : undefined;
  const from = data.chains.find((c) => c.id === fromId);

  const choose = (t: MasterRef) => {
    setTarget(t);
    setPreview(null);
    setError(null);
  };
  const check = async () => {
    if (!target.id) return;
    setBusy(true);
    setError(null);
    const r = await previewChainMergeAction(fromId, target.id, profile.id);
    setBusy(false);
    if (!r.ok) return setError(r.error);
    if (r.preview.already) return setError("この統合はすでに実行済みです");
    setPreview(r.preview);
  };
  const run = async () => {
    if (!target.id) return;
    setBusy(true);
    setError(null);
    const r = await mergeChainsAction(fromId, target.id, profile.id);
    setBusy(false);
    if (!r.ok) return setError(r.error);
    setDone(r.result.already ? "すでに統合済みです" : "統合しました。統合元は非表示になり、参照は統合先へ付け替えました。");
    // 一覧の更新は閉じるときに行う（統合元の行は非表示になり、この画面ごと消えるため、結果を読む前に閉じてしまわない）
  };
  const close = () => {
    if (done) router.refresh();
    onClose();
  };

  return (
    <Dialog open onOpenChange={(o) => !o && close()}>
      <DialogContent className="max-w-md overflow-y-auto" data-testid="chain-merge-dialog">
        <DialogTitle>「{name}」を既存系列に統合</DialogTitle>
        <DialogDescription>同じ系列の重複登録を1つにまとめます。履歴は削除せず、店舗・抽選・応募・購入などの参照を統合先へ付け替えます。</DialogDescription>
        {done ? (
          <>
            <p className="mt-2 text-sm" role="status" data-testid="chain-merge-done">
              {done}
            </p>
            <div className="mt-4 flex justify-end">
              <Button onClick={close}>閉じる</Button>
            </div>
          </>
        ) : (
          <>
            <div className="mt-2 space-y-2 text-sm">
              <div>
                統合先の系列
                <MasterCombobox label="統合先の系列" value={target} options={options} onChange={choose} placeholder="系列名で検索" />
              </div>
              {into && from && (
                <dl className="grid grid-cols-[4.5rem_1fr] gap-x-2 gap-y-0.5 rounded-md border p-2 text-xs" data-testid="chain-merge-compare">
                  <dt className="text-muted-foreground">統合元</dt>
                  <dd>
                    {from.name}
                  </dd>
                  <dt className="text-muted-foreground">統合先</dt>
                  <dd>
                    {into.name}
                  </dd>
                </dl>
              )}
              {preview && (
                <div className="space-y-1 rounded-md border border-info p-2 text-xs" data-testid="chain-merge-preview">
                  <p className="font-medium">付け替える参照</p>
                  <ul className="list-inside list-disc">
                    {refLines(preview.from, HISTORY_KEYS).length === 0 ? <li>履歴の参照はありません</li> : refLines(preview.from, HISTORY_KEYS).map((l) => <li key={l}>{l}</li>)}
                  </ul>
                  <p className="text-muted-foreground">同じ名前の店舗は統合先の店舗に寄せ、名前が違う店舗は統合先の系列へ移します。同名義・同ラベルの応募アカウントは応募履歴ごと統合先へ寄せます。統合元の名前は統合先の別名になり、統合元は非表示で残ります。抽選・購入・BOXの件数は付け替え前後で照合し、合わなければ何も変更しません。</p>
                </div>
              )}
              {error && (
                <p role="alert" className="text-sm text-danger" data-testid="chain-merge-error">
                  {error}
                </p>
              )}
            </div>
            <div className="mt-4 flex justify-end gap-2">
              <Button variant="outline" onClick={onClose} disabled={busy}>
                キャンセル
              </Button>
              {!preview ? (
                <Button disabled={busy || !target.id} onClick={() => void check()} data-testid="chain-merge-check">
                  内容を確認
                </Button>
              ) : (
                <Button variant="danger" disabled={busy} onClick={() => void run()} data-testid="chain-merge-run">
                  {busy ? "統合中…" : "統合する"}
                </Button>
              )}
            </div>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
