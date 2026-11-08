"use client";

import { useRouter } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import { setRetired } from "@/app/(app)/settings/masters/actions";
import { deleteProductAction, mergeProductsAction, previewMergeAction, productReferencesAction } from "@/app/(app)/settings/masters/product-merge-actions";
import { useApp } from "@/components/app-provider";
import { MasterCombobox, type MasterRef } from "@/components/master-combobox";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { HISTORY_KEYS, historyTotal, refLines, type RefCounts } from "@/lib/product-merge";

/**
 * 商品マスターの削除（Stage 6P）。削除前に、抽選・購入・売却・BOX・コレクションなどからの参照を調べて表示する。
 * 参照が無い商品だけ削除できる。参照がある商品は削除せず（履歴を連鎖削除しない）、非表示にすることを提案する。
 */
export function ProductDeleteButton({ productId, name }: { productId: string; name: string }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button size="sm" variant="outline" onClick={() => setOpen(true)} aria-label={`${name}を削除`} data-testid="product-delete-open">
        削除
      </Button>
      {open && <DeleteDialog productId={productId} name={name} onClose={() => setOpen(false)} />}
    </>
  );
}

function DeleteDialog({ productId, name, onClose }: { productId: string; name: string; onClose: () => void }) {
  const router = useRouter();
  const { profile } = useApp();
  const [counts, setCounts] = useState<RefCounts | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    void productReferencesAction(productId).then((r) => {
      if (!live) return;
      if (r.ok) setCounts(r.counts);
      else setError(r.error);
    });
    return () => {
      live = false;
    };
  }, [productId]);

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
      <DialogContent data-testid="product-delete-dialog">
        <DialogTitle>商品「{name}」を削除</DialogTitle>
        <DialogDescription className="sr-only">削除前に参照の有無を確認します</DialogDescription>
        <div className="mt-2 space-y-2 text-sm">
          {counts === null && !error && <p className="text-muted-foreground">参照を調査しています…</p>}
          {counts && refs === 0 && <p data-testid="product-delete-ok">この商品はどこからも参照されていません。削除できます（元に戻せません）。</p>}
          {counts && refs !== null && refs > 0 && (
            <div className="space-y-1.5" data-testid="product-delete-blocked">
              <p className="font-medium text-warn">この商品は次のデータから参照されているため、削除できません。</p>
              <ul className="list-inside list-disc text-xs">
                {refLines(counts, HISTORY_KEYS).map((l) => (
                  <li key={l}>{l}</li>
                ))}
              </ul>
              <p className="text-xs text-muted-foreground">履歴を壊さないため、削除ではなく「非表示」にできます（新規登録の候補から外れ、既存の記録はそのまま残ります）。同じ商品の重複なら「既存商品に統合」を使ってください。</p>
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
            <Button variant="outline" disabled={busy} onClick={() => void run(() => setRetired("products", productId, true, profile.id))} data-testid="product-hide">
              非表示にする
            </Button>
          )}
          {refs === 0 && (
            <Button variant="danger" disabled={busy} onClick={() => void run(() => deleteProductAction(productId))} data-testid="product-delete-confirm">
              削除する
            </Button>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}

/**
 * 既存商品への統合（Stage 6P）。同じ商品が別名称で重複登録されているとき、統合元の参照（抽選・購入・売却・BOX・カードなど）を統合先へ付け替える。
 * 履歴は削除せず、統合元は非表示で残り、統合先の画像・価格・発売日は上書きしない。確定前に影響件数を表示する。
 */
export function ProductMergeButton({ productId, name }: { productId: string; name: string }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button size="sm" variant="outline" onClick={() => setOpen(true)} aria-label={`${name}を既存商品に統合`} data-testid="product-merge-open">
        既存商品に統合
      </Button>
      {open && <MergeDialog fromId={productId} name={name} onClose={() => setOpen(false)} />}
    </>
  );
}

function MergeDialog({ fromId, name, onClose }: { fromId: string; name: string; onClose: () => void }) {
  const router = useRouter();
  const { data, profile } = useApp();
  const [target, setTarget] = useState<MasterRef>({ id: null, name: "" });
  const [preview, setPreview] = useState<{ from: RefCounts; into: RefCounts } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);

  const options = useMemo(() => data.products.filter((p) => p.id !== fromId && !p.archived).map((p) => ({ id: p.id, name: p.officialName, hint: p.code || undefined })), [data.products, fromId]);
  const into = target.id ? data.products.find((p) => p.id === target.id) : undefined;
  const from = data.products.find((p) => p.id === fromId);

  const choose = (t: MasterRef) => {
    setTarget(t);
    setPreview(null);
    setError(null);
  };
  const check = async () => {
    if (!target.id) return;
    setBusy(true);
    setError(null);
    const r = await previewMergeAction(fromId, target.id, profile.id);
    setBusy(false);
    if (!r.ok) return setError(r.error);
    if (r.preview.already) return setError("この統合はすでに実行済みです");
    setPreview(r.preview);
  };
  const run = async () => {
    if (!target.id) return;
    setBusy(true);
    setError(null);
    const r = await mergeProductsAction(fromId, target.id, profile.id);
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
      <DialogContent className="max-w-md overflow-y-auto" data-testid="product-merge-dialog">
        <DialogTitle>「{name}」を既存商品に統合</DialogTitle>
        <DialogDescription>同じ商品の重複登録を1つにまとめます。履歴は削除せず、参照を統合先へ付け替えます。</DialogDescription>
        {done ? (
          <>
            <p className="mt-2 text-sm" role="status" data-testid="product-merge-done">
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
                統合先の商品
                <MasterCombobox label="統合先の商品" value={target} options={options} onChange={choose} placeholder="商品名・コードで検索" />
              </div>
              {into && from && (
                <dl className="grid grid-cols-[4.5rem_1fr] gap-x-2 gap-y-0.5 rounded-md border p-2 text-xs" data-testid="product-merge-compare">
                  <dt className="text-muted-foreground">統合元</dt>
                  <dd>
                    {from.officialName}（コード {from.code || "なし"}）
                  </dd>
                  <dt className="text-muted-foreground">統合先</dt>
                  <dd>
                    {into.officialName}（コード {into.code || "なし"}）
                  </dd>
                </dl>
              )}
              {preview && (
                <div className="space-y-1 rounded-md border border-info p-2 text-xs" data-testid="product-merge-preview">
                  <p className="font-medium">付け替える参照</p>
                  <ul className="list-inside list-disc">
                    {refLines(preview.from, HISTORY_KEYS).length === 0 ? <li>履歴の参照はありません</li> : refLines(preview.from, HISTORY_KEYS).map((l) => <li key={l}>{l}</li>)}
                  </ul>
                  <p className="text-muted-foreground">統合先の画像・価格・発売日は上書きしません（統合先に無い画像・価格・別名だけ引き継ぎます）。統合元の名前は統合先の別名になり、統合元は非表示で残ります。購入数量・売却数量・BOX在庫は付け替え前後で照合し、合わなければ何も変更しません。</p>
                </div>
              )}
              {error && (
                <p role="alert" className="text-sm text-danger" data-testid="product-merge-error">
                  {error}
                </p>
              )}
            </div>
            <div className="mt-4 flex justify-end gap-2">
              <Button variant="outline" onClick={onClose} disabled={busy}>
                キャンセル
              </Button>
              {!preview ? (
                <Button disabled={busy || !target.id} onClick={() => void check()} data-testid="product-merge-check">
                  内容を確認
                </Button>
              ) : (
                <Button variant="danger" disabled={busy} onClick={() => void run()} data-testid="product-merge-run">
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
