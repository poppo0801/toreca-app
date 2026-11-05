"use client";

import { useRef, type CSSProperties, type PointerEvent } from "react";
import { cn } from "@/lib/utils";
import { shineTier } from "@/lib/collection";

/**
 * カードの光沢・ホログラム演出の属性（Stage 6F）。レアリティで強さ（data-tier）を変える。
 * 触れた・なぞった位置に光が追従する（--mx/--my。rAFで間引き。変形はしないので、カード操作の反応は変わらない）。
 * 動きを減らす設定の扱いは CSS 側（静止した薄いホログラム）。演出OFF・対象外のレアリティでは何も付けない。
 */
export function useShine(rarity: string, enabled: boolean, opts: { once?: boolean } = {}) {
  const tier = enabled ? shineTier(rarity) : 0;
  const raf = useRef(0);
  if (tier === 0) return { className: undefined as string | undefined, props: {} as Record<string, unknown> };
  const move = (e: PointerEvent<HTMLElement>) => {
    const el = e.currentTarget;
    const { clientX, clientY } = e;
    if (raf.current) return;
    raf.current = requestAnimationFrame(() => {
      raf.current = 0;
      const r = el.getBoundingClientRect();
      if (r.width <= 0 || r.height <= 0) return;
      el.style.setProperty("--mx", `${Math.max(0, Math.min(100, ((clientX - r.left) / r.width) * 100)).toFixed(1)}%`);
      el.style.setProperty("--my", `${Math.max(0, Math.min(100, ((clientY - r.top) / r.height) * 100)).toFixed(1)}%`);
      el.dataset.touch = "1";
    });
  };
  const leave = (e: PointerEvent<HTMLElement>) => {
    delete e.currentTarget.dataset.touch;
  };
  return {
    className: cn("card-shine", opts.once && "card-shine-once"),
    props: { "data-tier": tier, onPointerMove: move, onPointerLeave: leave, onPointerUp: leave, onPointerCancel: leave, style: undefined as CSSProperties | undefined },
  };
}

/** グリッドのカード（押すと詳細）。レアリティに応じた光沢つき */
export function ShineButton({ rarity, enabled, className, children, ...rest }: { rarity: string; enabled: boolean } & React.ButtonHTMLAttributes<HTMLButtonElement>) {
  const shine = useShine(rarity, enabled);
  return (
    <button type="button" className={cn(className, shine.className)} {...rest} {...shine.props}>
      {children}
    </button>
  );
}
