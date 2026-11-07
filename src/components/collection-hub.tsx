"use client";

import { TrendingUp } from "lucide-react";
import { useSearchParams } from "next/navigation";
import { useEffect, useRef, useState, type TouchEvent } from "react";
import { BoxCollectionPanel, type BoxPanelHandle } from "@/components/box-collection-view";
import { CollectionView, type CardPanelHandle } from "@/components/collection-view";
import { PAGE_HEADING_ROW, PageHeading } from "@/components/page-heading";
import type { CollectionKind } from "@/components/register-kind-switch";
import { Button } from "@/components/ui/button";
import { IS_SUPABASE_MODE } from "@/lib/data-source";
import { cn } from "@/lib/utils";

/** 横スワイプでページを切り替える条件: 横の移動が十分大きく、縦の移動より明らかに大きい */
const SWIPE_MIN_PX = 60;
const SWIPE_RATIO = 1.6;
const SLIDE_MS = 300;

/**
 * コレクション（カード／BOX）。左右スワイプだけで切り替える（横へ滑るアニメーション。切替ボタンは置かない）。
 * 一覧・集計・並び順・絞り込みは各ページで独立。右上の［相場更新］［登録］は表示中のページに対して働く。
 * スワイプは、ダイアログ内・長押しドラッグ中・入力欄での操作では切り替えない。
 */
export function CollectionHub() {
  const params = useSearchParams();
  const [tab, setTab] = useState<CollectionKind>(() => (params.get("tab") === "box" && params.get("add") !== "1" ? "box" : "card"));
  // 切替のアニメーション中は両方のページを表示し、終わったら非表示のページを畳む（高さを持たせない）
  const [sliding, setSliding] = useState(false);
  const cardRef = useRef<CardPanelHandle>(null);
  const boxRef = useRef<BoxPanelHandle>(null);
  const touch = useRef<{ x: number; y: number; cancelled: boolean } | null>(null);
  const first = useRef(true);

  useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    const url = new URL(window.location.href);
    if (tab === "box") url.searchParams.set("tab", "box");
    else url.searchParams.delete("tab");
    window.history.replaceState(window.history.state, "", url);
    // eslint-disable-next-line react-hooks/set-state-in-effect -- 切替アニメーション中だけ両方のページを表示する
    setSliding(true);
    const t = window.setTimeout(() => setSliding(false), SLIDE_MS + 40);
    return () => window.clearTimeout(t);
  }, [tab]);

  const onStart = (e: TouchEvent<HTMLDivElement>) => {
    const t = e.touches[0];
    // ダイアログなど別の場所（portal）で始まった操作・入力欄・複数本指は対象外
    const inside = e.currentTarget.contains(e.target as Node);
    const typing = (e.target as HTMLElement).closest?.("input,select,textarea,[role=dialog]");
    touch.current = e.touches.length === 1 && inside && !typing ? { x: t.clientX, y: t.clientY, cancelled: false } : null;
  };
  const onMove = () => {
    // 長押しドラッグ（カードの並び替え）が始まったら、スワイプとしては扱わない
    if (touch.current && document.querySelector("[data-dragging]")) touch.current.cancelled = true;
  };
  const onEnd = (e: TouchEvent<HTMLDivElement>) => {
    const s = touch.current;
    touch.current = null;
    if (!s || s.cancelled) return;
    const t = e.changedTouches[0];
    const dx = t.clientX - s.x;
    const dy = t.clientY - s.y;
    if (Math.abs(dx) < SWIPE_MIN_PX || Math.abs(dx) < Math.abs(dy) * SWIPE_RATIO) return;
    if (dx < 0 && tab === "card") setTab("box");
    else if (dx > 0 && tab === "box") setTab("card");
  };

  if (!IS_SUPABASE_MODE) return <p className="text-sm text-muted-foreground">コレクションはSupabaseモード（ログイン後）でのみ利用できます。</p>;

  const panel = (k: CollectionKind, children: React.ReactNode) => (
    <div
      role="region"
      aria-label={k === "card" ? "カードのコレクション" : "BOXのコレクション"}
      aria-hidden={tab !== k}
      inert={tab !== k}
      className={cn("w-1/2 shrink-0", tab !== k && !sliding && "h-0 overflow-hidden")}
      data-testid={`collection-panel-${k}`}
    >
      {children}
    </div>
  );

  return (
    <div className="space-y-3" data-testid="collection-hub" data-tab={tab}>
      <div className={PAGE_HEADING_ROW}>
        <PageHeading navId="collection">コレクション</PageHeading>
        {/* 右上: [相場更新][登録]。表示中のページ（カード／BOX）に対して働く。スマホでも押しやすい高さ（40px） */}
        <div className="flex shrink-0 items-center gap-1.5">
          <Button size="sm" variant="outline" className="h-10 gap-1 px-2.5" onClick={() => (tab === "card" ? cardRef.current?.openMarket() : boxRef.current?.openPrices())} data-testid="market-update-open">
            <TrendingUp className="size-4" aria-hidden="true" />
            相場更新
          </Button>
          <Button size="sm" className="h-10 px-3" onClick={() => (tab === "card" ? cardRef.current?.openRegister() : boxRef.current?.openRegister())} data-testid="add-card">
            ＋登録
          </Button>
        </div>
      </div>

      <div className="overflow-x-clip [touch-action:pan-y]" onTouchStart={onStart} onTouchMove={onMove} onTouchEnd={onEnd} data-testid="collection-swipe">
        <div
          className="flex w-[200%] transition-transform duration-300 ease-out motion-reduce:transition-none"
          style={{ transform: tab === "card" ? "translateX(0)" : "translateX(-50%)" }}
          data-testid="collection-track"
        >
          {panel("card", <CollectionView ref={cardRef} onSwitchKind={() => (setTab("box"), window.setTimeout(() => boxRef.current?.openRegister(), 0))} />)}
          {panel("box", <BoxCollectionPanel ref={boxRef} onSwitchKind={() => (setTab("card"), window.setTimeout(() => cardRef.current?.openRegister(), 0))} />)}
        </div>
      </div>
    </div>
  );
}
