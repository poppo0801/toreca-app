"use client";

import { useRouter } from "next/navigation";
import { useEffect, useRef, useState, useTransition } from "react";
import { useApp } from "@/components/app-provider";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { removeChainLogo, uploadChainLogo } from "@/app/(app)/settings/masters/chain-logo-actions";
import { chainLogoUrl } from "@/lib/chain-logo";

const MAX_BYTES = 2 * 1024 * 1024;

/** 系列マスターの行から開く、ロゴの登録・変更・削除（所属する全店舗に自動で反映される） */
export function ChainLogoButton({ chainId, name, sha }: { chainId: string; name: string; sha: string | null }) {
  const router = useRouter();
  const { reload } = useApp();
  const [open, setOpen] = useState(false);
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [pending, start] = useTransition();
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!file) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- 選択ファイルのプレビューURLの生成と破棄
      setPreview(null);
      return;
    }
    const u = URL.createObjectURL(file);
    setPreview(u);
    return () => URL.revokeObjectURL(u);
  }, [file]);

  const close = (o: boolean) => {
    setOpen(o);
    if (!o) {
      setFile(null);
      setError(null);
      setConfirmDelete(false);
    }
  };
  const choose = (f: File | null) => {
    setError(null);
    if (f && f.size > MAX_BYTES) {
      setFile(null);
      return setError("ロゴ画像は2MB以下にしてください");
    }
    if (f && !/^image\/(png|jpeg|webp)$/.test(f.type)) {
      setFile(null);
      return setError("PNG・JPEG・WebPの画像を選択してください");
    }
    setFile(f);
  };
  const done = () => {
    setFile(null);
    if (input.current) input.current.value = "";
    router.refresh();
    void reload();
  };
  const save = () =>
    start(async () => {
      if (!file) return;
      setError(null);
      const body = new FormData();
      body.set("chainId", chainId);
      body.set("file", file);
      const res = await uploadChainLogo(body);
      if (res.ok) done();
      else setError(res.error);
    });
  const remove = () =>
    start(async () => {
      setError(null);
      const res = await removeChainLogo(chainId);
      setConfirmDelete(false);
      if (res.ok) done();
      else setError(res.error);
    });

  const current = sha ? chainLogoUrl(chainId, sha) : null;
  const tile = "flex size-24 items-center justify-center rounded-lg bg-white p-1 ring-1 ring-black/10 dark:ring-white/20";
  return (
    <>
      <Button size="sm" variant="outline" onClick={() => setOpen(true)} aria-label={`${name}のロゴを管理`} data-testid="chain-logo-button">
        ロゴ
      </Button>
      <Dialog open={open} onOpenChange={close}>
        <DialogContent className="max-w-sm">
          <DialogTitle>系列ロゴ</DialogTitle>
          <DialogDescription>{name}（この系列の全店舗の抽選カードに表示されます）</DialogDescription>
          <div className="mt-3 space-y-3 text-sm">
            <div className="flex items-start gap-3">
              <figure className="space-y-1 text-center">
                <div className={tile} data-testid="logo-current">
                  {current ? (
                    // eslint-disable-next-line @next/next/no-img-element -- 認証付きの自前API
                    <img src={current} alt={`${name}の現在のロゴ`} className="size-full object-contain" />
                  ) : (
                    <span className="text-[11px] text-muted-foreground">未登録</span>
                  )}
                </div>
                <figcaption className="text-[11px] text-muted-foreground">現在</figcaption>
              </figure>
              {preview && (
                <figure className="space-y-1 text-center">
                  <div className={tile} data-testid="logo-preview">
                    {/* eslint-disable-next-line @next/next/no-img-element -- ブラウザ内のプレビュー */}
                    <img src={preview} alt="選択したロゴのプレビュー" className="size-full object-contain" />
                  </div>
                  <figcaption className="text-[11px] text-muted-foreground">登録後（正方形に整えます）</figcaption>
                </figure>
              )}
            </div>
            <label className="block">
              <span className="sr-only">ロゴ画像（PNG・JPEG・WebP）</span>
              <input
                ref={input}
                type="file"
                accept="image/png,image/jpeg,image/webp"
                disabled={pending}
                onChange={(e) => choose(e.target.files?.[0] ?? null)}
                className="block w-full text-sm file:mr-3 file:min-h-10 file:rounded-md file:border file:bg-input file:px-3"
                data-testid="logo-file"
              />
            </label>
            <p className="text-[11px] text-muted-foreground">正方形（1:1）のPNG・JPEG・WebP、2MBまで。横長・縦長の画像は、縦横比を保ったまま余白で正方形に整えます。透過PNGも使えます。</p>
            {error && (
              <p role="alert" className="text-xs text-danger" data-testid="logo-error">
                {error}
              </p>
            )}
            <div className="flex flex-wrap items-center justify-between gap-2">
              {current && !confirmDelete && (
                <Button variant="outline" size="sm" onClick={() => setConfirmDelete(true)} disabled={pending} data-testid="logo-delete">
                  ロゴを削除
                </Button>
              )}
              {confirmDelete && (
                <span className="flex items-center gap-1.5 text-xs">
                  削除しますか？
                  <Button variant="danger" size="sm" onClick={remove} disabled={pending} data-testid="logo-delete-confirm">
                    削除する
                  </Button>
                  <Button variant="outline" size="sm" onClick={() => setConfirmDelete(false)} disabled={pending}>
                    やめる
                  </Button>
                </span>
              )}
              <Button size="sm" onClick={save} disabled={!file || pending} className="ml-auto" data-testid="logo-save">
                {pending ? "保存しています…" : current ? "ロゴを変更" : "ロゴを登録"}
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}
