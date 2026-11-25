import { cn } from "@/lib/utils";

/**
 * 状態ランクの四角い色分けバッジ（相場調査メモ・151図鑑の価格一覧・カード一覧で共通）。小型（高さ約18px）で、行の高さを増やさない。
 * ランクごとに色を分ける: S=緑／A=青／B=黄／C=橙／D=灰（旧 A+/A/B+/B/C からの移行後の5段階）。文字も併記するので、色だけに頼らない。ライト・ダーク両対応。
 */
const STYLE: Record<string, string> = {
  S: "border-emerald-600 bg-emerald-100 text-emerald-900 dark:border-emerald-500 dark:bg-emerald-950 dark:text-emerald-200",
  A: "border-sky-600 bg-sky-100 text-sky-900 dark:border-sky-500 dark:bg-sky-950 dark:text-sky-200",
  B: "border-amber-600 bg-amber-100 text-amber-900 dark:border-amber-500 dark:bg-amber-950 dark:text-amber-200",
  C: "border-orange-600 bg-orange-100 text-orange-900 dark:border-orange-500 dark:bg-orange-950 dark:text-orange-200",
  D: "border-zinc-500 bg-zinc-200 text-zinc-800 dark:border-zinc-400 dark:bg-zinc-800 dark:text-zinc-200",
};

export function RankBadge({ rank, className }: { rank: string; className?: string }) {
  return (
    <span
      className={cn("inline-flex h-[18px] min-w-[1.5rem] shrink-0 items-center justify-center rounded-[3px] border px-1 text-[11px] font-bold leading-none", STYLE[rank] ?? STYLE.D, className)}
      data-testid="rank-badge"
      data-rank={rank}
    >
      {rank}
    </span>
  );
}
