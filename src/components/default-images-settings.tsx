"use client";

import { useRef, useState, useTransition } from "react";
import { useApp } from "@/components/app-provider";
import { Button } from "@/components/ui/button";
import { removeDefaultImage, uploadDefaultImage } from "@/app/(app)/settings/default-image-actions";

const ITEMS = [
  { id: "single_card", label: "シングルカード" },
  { id: "other", label: "その他" },
] as const;
const MAX_BYTES = 3 * 1024 * 1024;

/**
 * 購入記録の標準画像（Stage 7E）。商品個別の画像が無い購入記録（シングルカード・その他）に、共通の画像を表示する。
 * 表示の優先順位: 商品個別の画像 → 品目別の標準画像 → 画像なしアイコン。画像は購入記録ごとに複製せず、この1つを参照する。
 */
export function DefaultImagesSettings() {
  const { data, reload } = useApp();
  const [error, setError] = useState<{ id: string; text: string } | null>(null);
  const [pending, start] = useTransition();
  const inputs = useRef<Record<string, HTMLInputElement | null>>({});

  const upload = (id: string, file: File | undefined) => {
    if (!file) return;
    setError(null);
    if (file.size > MAX_BYTES) return setError({ id, text: "画像は3MB以下にしてください" });
    if (!/^image\/(png|jpeg|webp)$/.test(file.type)) return setError({ id, text: "PNG・JPEG・WebPの画像を選択してください" });
    start(async () => {
      const body = new FormData();
      body.set("category", id);
      body.set("file", file);
      const r = await uploadDefaultImage(body);
      if (r.ok) await reload();
      else setError({ id, text: r.error });
      if (inputs.current[id]) inputs.current[id]!.value = "";
    });
  };
  const remove = (id: string) =>
    start(async () => {
      setError(null);
      const r = await removeDefaultImage(id);
      if (r.ok) await reload();
      else setError({ id, text: r.error });
    });

  return (
    <section aria-labelledby="default-images-title" className="space-y-2" data-testid="default-images">
      <h2 id="default-images-title" className="text-sm font-bold">
        購入記録の標準画像
      </h2>
      <ul className="divide-y rounded-lg border">
        {ITEMS.map((it) => {
          const img = data.defaultImages?.[it.id];
          return (
            <li key={it.id} className="flex items-center gap-3 px-3 py-2" data-testid={`default-image-${it.id}`}>
              <span className="flex size-14 shrink-0 items-center justify-center rounded-md border bg-muted">
                {img ? (
                  // eslint-disable-next-line @next/next/no-img-element -- 認証付きの自前API
                  <img src={img.url} alt={`${it.label}の標準画像`} className="max-h-full max-w-full object-contain" data-testid="default-image-preview" />
                ) : (
                  <span className="text-[10px] text-muted-foreground">未登録</span>
                )}
              </span>
              <span className="min-w-0 flex-1">
                <span className="block text-sm font-medium">{it.label}</span>
                {error?.id === it.id && (
                  <span role="alert" className="block text-xs text-danger" data-testid="default-image-error">
                    {error.text}
                  </span>
                )}
              </span>
              <input ref={(el) => void (inputs.current[it.id] = el)} type="file" accept="image/png,image/jpeg,image/webp" className="hidden" disabled={pending} onChange={(e) => upload(it.id, e.target.files?.[0])} data-testid={`default-image-file-${it.id}`} />
              <Button size="sm" variant="outline" disabled={pending} onClick={() => inputs.current[it.id]?.click()}>
                {img ? "変更" : "登録"}
              </Button>
              {img && (
                <Button size="sm" variant="outline" disabled={pending} onClick={() => remove(it.id)} data-testid={`default-image-delete-${it.id}`}>
                  削除
                </Button>
              )}
            </li>
          );
        })}
      </ul>
    </section>
  );
}
