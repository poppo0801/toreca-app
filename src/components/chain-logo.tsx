import { cn } from "@/lib/utils";

/**
 * 系列ロゴ（店舗名の左に置く識別用の小さな画像）。
 * 常に正方形の固定サイズで場所を確保するので、読み込み中もレイアウトがずれない。縦横比は保つ（object-contain）。
 * 淡い白地のタイルに載せるので、ライト・ダークどちらでも背景に溶けない。未登録なら何も出さない。
 * 上下の負のマージンで、1行の文字の高さ（約16px）を超えないようにする（カードの高さを増やさない）。
 */
export function ChainLogo({ src, name, className }: { src?: string | null; name: string; className?: string }) {
  if (!src) return null;
  return (
    // eslint-disable-next-line @next/next/no-img-element -- 認証付きの自前API。サイズ固定のため next/image は不要
    <img
      src={src}
      alt={`${name}のロゴ`}
      width={20}
      height={20}
      loading="lazy"
      decoding="async"
      data-testid="chain-logo"
      className={cn("-my-0.5 size-5 shrink-0 rounded-[5px] bg-white object-contain p-px ring-1 ring-black/10 dark:ring-white/20", className)}
    />
  );
}
