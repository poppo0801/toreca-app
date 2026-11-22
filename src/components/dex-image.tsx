"use client";

import { useState } from "react";
import { cn } from "@/lib/utils";

/**
 * ポケモン画像（151図鑑・相場調査メモ共通）。ログイン必須の配信ルート /api/pokemon-image/[no] から取得する（Supabase Storage の非公開バケット）。
 * 読み込めない・画像が無いときは図鑑番号のプレースホルダー。遅延読み込みでスクロール性能を保つ。
 * `dim` は「未入手の半透明」の見た目で、**図鑑の一覧だけが指定する**。相場調査メモなど他の画面は指定せず、常に通常の不透明度で表示する。
 */
export const DIM_OPACITY_CLASS = "opacity-35";

/** 画像の配信を有効にするか（既定は無効=プレースホルダーのみ。利用権限の確認と画像の導入が済んだ環境で NEXT_PUBLIC_POKEMON_IMAGES=on） */
const IMAGES_ON = process.env.NEXT_PUBLIC_POKEMON_IMAGES === "on";

export function DexImage({ no, name, className, dim }: { no: number; name: string; className?: string; dim?: boolean }) {
  const [failed, setFailed] = useState(false);
  if (failed || !IMAGES_ON)
    return (
      <span className={cn("flex shrink-0 items-center justify-center rounded-md bg-muted text-[10px] tabular-nums text-muted-foreground", className)} aria-hidden="true" data-testid="dex-placeholder">
        {String(no).padStart(3, "0")}
      </span>
    );
  return (
    // eslint-disable-next-line @next/next/no-img-element -- 認証つきの配信ルート。サイズは事前変換済み（192px）
    <img src={`/api/pokemon-image/${no}`} alt="" width={96} height={96} loading="lazy" decoding="async" onError={() => setFailed(true)} className={cn("shrink-0 object-contain", dim && DIM_OPACITY_CLASS, className)} data-testid="dex-image" data-dim={dim ? "true" : "false"} data-name={name} />
  );
}
