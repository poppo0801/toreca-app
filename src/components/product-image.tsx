"use client";

import { ImageOff } from "lucide-react";
import { useRef, useState } from "react";
import { useApp } from "@/components/app-provider";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { updateProductImageDisplay, uploadProductImage } from "@/app/(app)/settings/masters/image-actions";
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
  const scale = image.scale ?? 1;
  const dx = image.offsetX ?? 0;
  const dy = image.offsetY ?? 0;
  const adjusted = scale !== 1 || dx !== 0 || dy !== 0;
  const img = (
    // eslint-disable-next-line @next/next/no-img-element -- 期限付きの署名URL（next/image の最適化対象外）。幅・高さ属性で表示領域を先に確保
    <img
      src={image.url}
      alt={alt}
      width={image.width ?? undefined}
      height={image.height ?? undefined}
      loading="lazy"
      decoding="async"
      className={cn("w-auto max-w-full object-contain", adjusted ? "h-full" : heightClass)}
      style={adjusted ? { transform: `translate(${dx}%, ${dy}%) scale(${scale})` } : undefined}
    />
  );
  // 倍率・位置を調整した画像は、枠(高さ固定)の外にはみ出さないよう切り取って表示する（元画像は変更しない）
  return adjusted ? <span className={cn("inline-flex overflow-hidden rounded-sm", heightClass)}>{img}</span> : img;
}

/** 画像の表示倍率・位置の調整（倍率 50〜300%、位置 ±50%）。プレビューを見ながら保存する */
function ImageAdjust({ productId, name }: { productId: string; name: string }) {
  const { data, profile, reload } = useApp();
  const product = data.products.find((p) => p.id === productId);
  const kinds = (["box", "pack", "unit"] as const).filter((k) => product?.images?.[k]);
  const [kind, setKind] = useState<ProductImageKind>(kinds[0] ?? "box");
  const img = product?.images?.[kind];
  const [scale, setScale] = useState(img?.scale ?? 1);
  const [dx, setDx] = useState(img?.offsetX ?? 0);
  const [dy, setDy] = useState(img?.offsetY ?? 0);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  if (kinds.length === 0 || !img) return null;

  const pick = (k: ProductImageKind) => {
    const i = product?.images?.[k];
    setKind(k);
    setScale(i?.scale ?? 1);
    setDx(i?.offsetX ?? 0);
    setDy(i?.offsetY ?? 0);
    setMsg(null);
  };
  const save = async () => {
    setBusy(true);
    const res = await updateProductImageDisplay({ productId, kind, actor: profile.id, scale, offsetX: dx, offsetY: dy });
    setBusy(false);
    if (res.ok) {
      setMsg("保存しました");
      await reload();
    } else setMsg(res.error);
  };
  const slider = (label: string, value: number, set: (n: number) => void, min: number, max: number, step: number, unit: string) => (
    <label className="grid grid-cols-[4.5rem_1fr_3.5rem] items-center gap-2 text-xs">
      {label}
      <input type="range" min={min} max={max} step={step} value={value} onChange={(e) => set(Number(e.target.value))} aria-label={label} className="w-full" />
      <span className="text-right tabular-nums">{unit === "%" && label === "倍率" ? Math.round(value * 100) : value}{unit}</span>
    </label>
  );
  return (
    <div className="space-y-2 rounded-md border p-2" data-testid="image-adjust">
      <p className="text-xs font-medium">表示の調整（一覧・抽選カードでの見え方。元画像は変わりません）</p>
      <div className="flex gap-1">
        {kinds.map((k) => (
          <button key={k} type="button" aria-pressed={k === kind} onClick={() => pick(k)} className={cn("min-h-9 rounded-md border px-2 text-xs", k === kind ? "border-primary bg-primary text-primary-foreground" : "hover:bg-muted")}>
            {IMAGE_KIND_LABEL[k]}
          </button>
        ))}
      </div>
      <div className="flex h-28 items-center justify-center rounded bg-muted/50">
        <ProductImageView image={{ ...img, scale, offsetX: dx, offsetY: dy }} alt={`${name} 調整プレビュー`} heightClass="h-24" />
      </div>
      {slider("倍率", scale, setScale, 0.5, 3, 0.05, "%")}
      {slider("横位置", dx, setDx, -50, 50, 1, "%")}
      {slider("縦位置", dy, setDy, -50, 50, 1, "%")}
      <div className="flex items-center justify-between gap-2">
        <Button type="button" size="sm" variant="ghost" onClick={() => { setScale(1); setDx(0); setDy(0); }}>
          等倍に戻す
        </Button>
        <Button type="button" size="sm" onClick={save} disabled={busy}>
          {busy ? "保存中…" : "調整を保存"}
        </Button>
      </div>
      {msg && <p role="status" className="text-xs text-muted-foreground">{msg}</p>}
    </div>
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
      <ImageAdjust key={`${productId}-${Object.keys(product?.images ?? {}).join(",")}`} productId={productId} name={product?.officialName ?? ""} />
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
