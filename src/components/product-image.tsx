"use client";

import { ImageOff } from "lucide-react";
import { useRef, useState } from "react";
import { useApp } from "@/components/app-provider";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { uploadProductImage } from "@/app/(app)/settings/masters/image-actions";
import { cn } from "@/lib/utils";
import type { Product, ProductImage, ProductImageKind } from "@/types/domain";

export const IMAGE_KIND_LABEL: Record<ProductImageKind, string> = { box: "BOX", pack: "パック", unit: "単品・セット" };

/** 画像が無いときの共通プレースホルダー（全商品で同じ見た目） */
export function ImagePlaceholder({ className, label }: { className?: string; label?: string }) {
  return (
    <span
      role="img"
      aria-label={label ?? "画像未登録"}
      data-testid="image-placeholder"
      className={cn("inline-flex shrink-0 items-center justify-center rounded-md border border-dashed bg-muted text-muted-foreground", className)}
    >
      <ImageOff className="size-1/3" aria-hidden="true" />
    </span>
  );
}

/**
 * 商品画像。元の縦横比のまま表示する（正方形への変形・余白の追加はしない）。高さだけを揃え、幅は画像の比率で決まる。
 * 透過PNGはカード/入力欄の面の色がそのまま透けるので、ライト・ダークどちらでも自然に見える。
 */
export function ProductImageView({ image, alt, heightClass = "h-14" }: { image: ProductImage; alt: string; heightClass?: string }) {
  return (
    // eslint-disable-next-line @next/next/no-img-element -- 期限付きの署名URL（next/image の最適化対象外）。幅・高さ属性で表示領域を先に確保
    <img
      src={image.url}
      alt={alt}
      width={image.width ?? undefined}
      height={image.height ?? undefined}
      loading="lazy"
      decoding="async"
      className={cn("w-auto max-w-full object-contain", heightClass)}
    />
  );
}

/** 一覧用のサムネイル: BOX → パック → 単品・セット の順で最初にある画像。無ければプレースホルダー */
export function ProductThumb({ product, heightClass = "h-14" }: { product: Pick<Product, "officialName" | "images"> | undefined; heightClass?: string }) {
  const img = product?.images?.box ?? product?.images?.pack ?? product?.images?.unit;
  const kind = product?.images?.box ? "BOX" : product?.images?.pack ? "パック" : "";
  if (!product || !img) return <ImagePlaceholder className={cn("aspect-[5/6]", heightClass)} />;
  return <ProductImageView image={img} alt={`${product.officialName} ${kind}`} heightClass={heightClass} />;
}

/** 商品マスター編集用: 種類ごとの画像と、アップロード・差し替えボタン */
export function ProductImagePanel({ productId }: { productId: string }) {
  const { data, profile, reload } = useApp();
  const product = data.products.find((p) => p.id === productId);
  const [busy, setBusy] = useState<ProductImageKind | null>(null);
  const [error, setError] = useState<string | null>(null);
  const inputs = useRef<Partial<Record<ProductImageKind, HTMLInputElement | null>>>({});

  const upload = async (kind: ProductImageKind, file: File | undefined) => {
    if (!file) return;
    setError(null);
    setBusy(kind);
    const fd = new FormData();
    fd.set("productId", productId);
    fd.set("kind", kind);
    fd.set("actor", profile.id);
    fd.set("file", file);
    const res = await uploadProductImage(fd);
    setBusy(null);
    if (res.ok) await reload();
    else setError(res.error);
    const el = inputs.current[kind];
    if (el) el.value = "";
  };

  return (
    <div className="space-y-3">
      <ul className="grid grid-cols-3 gap-2">
        {(["box", "pack", "unit"] as const).map((kind) => {
          const img = product?.images?.[kind];
          return (
            <li key={kind} className="flex flex-col items-center gap-1.5 rounded-md border p-2 text-center" data-testid={`image-slot-${kind}`}>
              <span className="text-xs font-medium">{IMAGE_KIND_LABEL[kind]}</span>
              <span className="flex h-24 items-center justify-center">
                {img ? <ProductImageView image={img} alt={`${product?.officialName ?? ""} ${IMAGE_KIND_LABEL[kind]}`} heightClass="h-24" /> : <ImagePlaceholder className="h-24 w-20" />}
              </span>
              <span className="text-[11px] text-muted-foreground">{img ? (img.source === "manual" ? "手動で登録" : "取り込み") : "未登録"}</span>
              <input
                ref={(el) => {
                  inputs.current[kind] = el;
                }}
                type="file"
                accept="image/png,image/jpeg,image/webp"
                aria-label={`${IMAGE_KIND_LABEL[kind]}画像を選択`}
                className="sr-only"
                onChange={(e) => upload(kind, e.target.files?.[0])}
              />
              <Button type="button" size="sm" variant="outline" disabled={busy !== null} onClick={() => inputs.current[kind]?.click()}>
                {busy === kind ? "保存中…" : img ? "差し替え" : "追加"}
              </Button>
            </li>
          );
        })}
      </ul>
      <p className="text-xs text-muted-foreground">PNG・JPEG・WebP（3MBまで）。縦横比はそのまま表示されます。手動で入れた画像は、再取り込みでは上書きされません。</p>
      {error && (
        <p role="alert" className="text-sm text-danger">
          {error}
        </p>
      )}
    </div>
  );
}

/** マスター一覧の行用: IDから商品を引いてサムネイルを表示 */
export function ProductThumbById({ productId, heightClass }: { productId: string; heightClass?: string }) {
  const { data } = useApp();
  return <ProductThumb product={data.products.find((p) => p.id === productId)} heightClass={heightClass} />;
}

/** マスター一覧の行用: 画像の追加・差し替えダイアログを開くボタン */
export function ProductImagesButton({ productId, name }: { productId: string; name: string }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button size="sm" variant="outline" onClick={() => setOpen(true)} aria-label={`${name}の画像を管理`}>
        画像
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-w-md">
          <DialogTitle>商品画像</DialogTitle>
          <DialogDescription>{name}</DialogDescription>
          <div className="mt-3">{open && <ProductImagePanel productId={productId} />}</div>
        </DialogContent>
      </Dialog>
    </>
  );
}
