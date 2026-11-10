"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Check, Star, X } from "lucide-react";
import { useApp } from "@/components/app-provider";
import { useApplyExit } from "@/components/apply-exit";
import { useUndoToast } from "@/components/undo-toast";
import { Button } from "@/components/ui/button";
import { AppliedStoreDialog } from "@/components/applied-store-dialog";
import type { StoreChoice } from "@/lib/applied-store";
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { myApplication } from "@/lib/lottery-flow";
import { applyControlFor } from "@/lib/lottery-summary";
import { formatItem, type Tab } from "@/lib/lottery-view";
import { classifyAxis, commitDirection, pullOffset, SWIPE, type SwipeDirection } from "@/lib/swipe";
import { leavesTabOnCommit, OP_META, opFor, planSwipe, type SwipeOp, type SwipeTone } from "@/lib/swipe-actions";
import { readPref } from "@/services/local-device-store";
import { ItemPickerDialog } from "@/components/item-picker-dialog";
import { cn } from "@/lib/utils";
import type { Lottery } from "@/types/domain";

const TONE: Record<SwipeTone, string> = {
  primary: "bg-primary text-primary-foreground",
  success: "bg-success text-background",
  muted: "bg-muted text-foreground",
  warn: "bg-warn text-background",
};

/** スワイプ操作を使うか: タッチ操作の端末で、端末設定がオフでないとき。PC（マウス）ではスワイプしない（★操作を使う） */
function useSwipeEnabled(): boolean {
  const [on, setOn] = useState(false);
  useEffect(() => {
    const touch = typeof window.matchMedia === "function" && window.matchMedia("(pointer: coarse)").matches;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- 端末の入力方式と端末設定の判定（マウント後に1回）
    setOn(touch && readPref("swipe", ["on", "off"] as const, "on") === "on");
  }, []);
  return on;
}

interface PendingDialog {
  kind: "confirm" | "choose-item" | "choose-items" | "choose-store" | "choose-fulfillment";
  op?: SwipeOp;
}

/**
 * 抽選カードを横スワイプで操作する枠。タブごとの操作は swipe-actions.ts の割り当てどおり。
 *  ・縦スクロールとの競合: touch-action: pan-y でブラウザの縦スクロールはそのまま。指を動かし始めて軸が「縦」と判定されたら、以後このスワイプは何もしない。
 *  ・指を離すまで状態は変えない。閾値に届かなければ元に戻る。確定後は一定時間（COOLDOWN）と通信中は次のスワイプを受け付けない。
 *  ・横スワイプの直後のクリック（カードを開く等）は無効化する。
 * 実際の更新は既存の状態管理(actions)を使い、成功したら画面上部のUndo通知を出す。
 */
export function SwipeCard({ lottery, tab, children }: { lottery: Lottery; tab: Tab; children: React.ReactNode }) {
  const { data, now, profile, actions, persistent, settings } = useApp();
  const toast = useUndoToast();
  const exit = useApplyExit();
  // タブ切替モード（プロフィール別の設定）では、カードの横スワイプ操作は無効（横スワイプはタブの切替に使う）。カードのタップ・詳細・ボタンは従来どおり
  const enabled = useSwipeEnabled() && persistent && (settings?.swipeMode ?? "card") === "card";
  const [offset, setOffset] = useState(0);
  const [dragging, setDragging] = useState(false);
  /** 確定して一覧から外れる操作のとき、離した位置から同じ方向へ流れてフェードアウトしている向き */
  const [leaving, setLeaving] = useState<SwipeDirection | null>(null);
  const leaveTimer = useRef<number | null>(null);
  const [dialog, setDialog] = useState<PendingDialog | null>(null);
  const root = useRef<HTMLDivElement>(null);
  const g = useRef<{ id: number; x: number; y: number; axis: "pending" | "horizontal" | "vertical" } | null>(null);
  const busy = useRef(false);
  const cooldown = useRef(0);
  const swallowClick = useRef(false);

  const rightOp = opFor(tab, "right");
  const leftOp = opFor(tab, "left");

  const fail = useCallback((message: string) => toast.show({ message, tone: "error" }), [toast]);

  /** 状態を変える本体。成功したらUndo付きの通知を出す。busy 中は何もしない（通信中の重複操作を防ぐ） */
  const okRef = useRef(false);
  const exec = useCallback(
    async (op: SwipeOp, extra: { itemId?: string; itemIds?: string[]; result?: "won" | "lost"; store?: StoreChoice | null } = {}) => {
      if (busy.current) return;
      busy.current = true;
      try {
        const done = OP_META[op].done;
        switch (op) {
          case "add_managed": {
            const r = await actions.setManaged(lottery.id, true);
            if (!r.ok) return fail(r.error);
            okRef.current = true;
            return toast.show({ message: done, undo: async () => { const u = await actions.setManaged(lottery.id, false); return u.ok ? true : u.error; } });
          }
          case "unmanage": {
            const r = await actions.setManaged(lottery.id, false);
            if (!r.ok) return fail(r.error);
            okRef.current = true;
            return toast.show({ message: done, undo: async () => { const u = await actions.setManaged(lottery.id, true); return u.ok ? true : u.error; } });
          }
          case "skip_once": {
            const r = await actions.setLotterySkip(lottery.id, true);
            if (!r.ok) return fail(r.error);
            okRef.current = true;
            return toast.show({ message: done, undo: async () => { const u = await actions.setLotterySkip(lottery.id, false); return u.ok ? true : u.error; } });
          }
          case "mark_applied": {
            const c = applyControlFor(data, lottery, profile.id, now);
            if (c.kind !== "apply") return fail("応募済みにできません");
            const r = await actions.setApplied(lottery.id, c.accountId, true, extra.itemId ?? null, extra.store === undefined && !extra.itemIds ? undefined : { ...(extra.store === undefined ? {} : { appliedStore: extra.store }), ...(extra.itemIds ? { itemIds: extra.itemIds } : {}) });
            if (!r.ok) return fail(r.error);
            okRef.current = true;
            return toast.show({
              message: done,
              undo: async () => {
                const u = await actions.setApplied(lottery.id, c.accountId, false);
                if (u.ok) exit?.cancel(lottery.id);
                return u.ok ? true : u.error;
              },
            });
          }
          case "result_won":
          case "result_lost": {
            const app = myApplication(data, lottery.id, profile.id);
            if (!app) return fail("このユーザーは応募していません");
            const result = op === "result_won" ? "won" : "lost";
            const r = await actions.setResult(app.id, result);
            if (!r.ok) return fail(r.error);
            // 取り消しは「結果未確認(pending)」へ戻す
            okRef.current = true;
            return toast.show({ message: done, undo: async () => { const u = await actions.setResult(app.id, "pending"); return u.ok ? true : u.error; } });
          }
          case "receive": {
            const app = myApplication(data, lottery.id, profile.id);
            if (!app) return fail("このユーザーは当選していません");
            const prev = app.fulfillment === "procedure_done" ? "procedure_done" : "none";
            const r = await actions.setFulfillment(app.id, "purchased");
            if (!r.ok) return fail(r.error);
            okRef.current = true;
            return toast.show({ message: done, undo: async () => { const u = await actions.revertFulfillment(app.id, prev); return u.ok ? true : u.error; } });
          }
        }
      } finally {
        busy.current = false;
      }
    },
    [actions, data, exit, fail, lottery, now, profile.id, toast],
  );
  /** 実行して、状態が変わったか（成功したか）を返す。★・スワイプの共通の退出アニメーションが、成否で続ける／戻すを決める */
  const run = useCallback(
    async (op: SwipeOp, extra: { itemId?: string; result?: "won" | "lost" } = {}): Promise<boolean> => {
      okRef.current = false;
      await exec(op, extra);
      return okRef.current;
    },
    [exec],
  );

  const commit = useCallback(
    (dir: SwipeDirection) => {
      if (busy.current || performance.now() < cooldown.current) return;
      cooldown.current = performance.now() + SWIPE.COOLDOWN_MS;
      const plan = planSwipe(data, lottery, tab, dir, profile.id, now);
      switch (plan.kind) {
        case "none":
          return;
        case "blocked":
          return toast.show({ message: plan.message, tone: "error" });
        case "open-detail":
          return toast.show({ message: plan.message, tone: "error" });
        case "run": {
          // 今のタブから外れる操作: 指を離した位置から同じ向きへカードが画面外まで滑り、保存を待たずに下のカードが詰まる（★の退出と共通）。
          // 保存に失敗したら、カードを元の位置へ戻す。外れなかった場合（絞り込みで残るなど）も戻る
          const leaves = leavesTabOnCommit(plan.op, tab);
          const handle = leaves ? exit?.begin(lottery.id, { dir, waitMs: 160, slid: true }) : undefined;
          if (leaves) setLeaving(dir);
          return void run(plan.op).then((ok) => {
            if (ok) handle?.ok();
            else handle?.fail();
            if (!leaves) return;
            if (leaveTimer.current) window.clearTimeout(leaveTimer.current);
            // 失敗した／保存後もこのタブに残る場合は、カードを元の位置へ戻す（退出が続いている間は戻さない）
            // 退出が続いている間は、終わるまで（最大約2秒）見張る。終わってもカードが残っていれば元の位置へ戻す
            let left = 10;
            const check = () => {
              if (!ok || !exit?.active(lottery.id) || left-- <= 0) return setLeaving(null);
              leaveTimer.current = window.setTimeout(check, 200);
            };
            leaveTimer.current = window.setTimeout(check, ok ? 160 : 30);
          });
        }
        case "confirm":
          return setDialog({ kind: "confirm", op: plan.op });
        case "choose-item":
          return setDialog({ kind: "choose-item" });
        case "choose-items":
          return setDialog({ kind: "choose-items" });
        case "choose-store":
          return setDialog({ kind: "choose-store" });
        case "choose-fulfillment":
          return setDialog({ kind: "choose-fulfillment" });
      }
    },
    [data, exit, lottery, now, profile.id, run, tab, toast],
  );

  // ---- ジェスチャ
  const onPointerDown = (e: React.PointerEvent) => {
    if (!enabled || e.pointerType === "mouse" || !e.isPrimary) return;
    if (!rightOp && !leftOp) return;
    // 入力欄・選択欄の操作はスワイプにしない
    if ((e.target as HTMLElement).closest("input,select,textarea,[data-no-swipe]")) return;
    g.current = { id: e.pointerId, x: e.clientX, y: e.clientY, axis: "pending" };
  };
  const onPointerMove = (e: React.PointerEvent) => {
    const s = g.current;
    if (!s || s.id !== e.pointerId || s.axis === "vertical") return;
    const dx = e.clientX - s.x;
    const dy = e.clientY - s.y;
    if (s.axis === "pending") {
      const axis = classifyAxis(dx, dy);
      if (axis === "pending") return;
      s.axis = axis;
      if (axis === "vertical") return; // 縦スクロール: 以後このジェスチャは無視
      try {
        root.current?.setPointerCapture(e.pointerId);
      } catch {
        /* noop */
      }
      setDragging(true);
    }
    // 操作のない向きには動かさない（当選タブの左など）
    const allowed = dx > 0 ? rightOp : leftOp;
    setOffset(allowed ? pullOffset(dx) : pullOffset(dx) * 0.2);
  };
  const finish = (e: React.PointerEvent, cancelled: boolean) => {
    const s = g.current;
    if (!s || s.id !== e.pointerId) return;
    g.current = null;
    if (s.axis === "horizontal") {
      swallowClick.current = true;
      window.setTimeout(() => (swallowClick.current = false), 350);
      const dx = e.clientX - s.x;
      const dir = cancelled ? null : commitDirection(dx, root.current?.offsetWidth || 360);
      setDragging(false);
      setOffset(0);
      if (dir && (dir === "right" ? rightOp : leftOp)) commit(dir);
    }
  };

  useEffect(
    () => () => {
      if (leaveTimer.current) window.clearTimeout(leaveTimer.current);
    },
    [],
  );

  const activeDir: SwipeDirection | null = offset > 6 ? "right" : offset < -6 ? "left" : null;
  const hintOp = activeDir === "right" ? rightOp : activeDir === "left" ? leftOp : null;
  const reached = Math.abs(offset) >= SWIPE.COMMIT_PX * 0.95;

  return (
    <div
      ref={root}
      className="relative min-w-0 max-w-full rounded-xl"
      style={{ touchAction: enabled ? "pan-y" : undefined }}
      data-swipe-tab={tab}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={(e) => finish(e, false)}
      onPointerCancel={(e) => finish(e, true)}
      onClickCapture={(e) => {
        if (swallowClick.current) {
          e.preventDefault();
          e.stopPropagation();
        }
      }}
    >
      {dragging && hintOp && (
        <div className={cn("pointer-events-none absolute inset-y-0 flex items-center rounded-xl px-5 text-sm font-bold", TONE[OP_META[hintOp].tone], activeDir === "right" ? "left-0 justify-start" : "right-0 justify-end")} style={{ width: "100%", opacity: reached ? 1 : 0.7 }} data-testid="swipe-hint" data-op={hintOp}>
          {hintOp === "add_managed" || hintOp === "unmanage" ? <Star className="mr-1.5 size-4" aria-hidden="true" /> : reached ? <Check className="mr-1.5 size-4" aria-hidden="true" /> : <X className="hidden" aria-hidden="true" />}
          {OP_META[hintOp].hint}
        </div>
      )}
      <div
        style={{
          transform: leaving ? `translateX(${leaving === "right" ? 110 : -110}%)` : offset ? `translateX(${offset}px)` : undefined,
          transition: dragging ? "none" : leaving ? "transform 200ms cubic-bezier(0.4, 0, 1, 1)" : "transform 180ms ease-out",
        }}
        data-leaving={leaving ?? undefined}
        className="relative"
      >
        {children}
      </div>

      <SwipeDialogs
        lottery={lottery}
        dialog={dialog}
        onClose={() => setDialog(null)}
        onRun={(op, extra) => {
          setDialog(null);
          void run(op, extra);
        }}
      />
    </div>
  );
}

/** 確認が必要なスワイプのダイアログ（発表前の当落・希望商品の選択・購入/受取の選択） */
function SwipeDialogs({ lottery, dialog, onClose, onRun }: { lottery: Lottery; dialog: PendingDialog | null; onClose: () => void; onRun: (op: SwipeOp, extra?: { itemId?: string; itemIds?: string[]; store?: StoreChoice | null }) => void }) {
  const { data, profile, actions } = useApp();
  const toast = useUndoToast();
  const [busy, setBusy] = useState(false);
  const mine = myApplication(data, lottery.id, profile.id);

  const record = async (to: "procedure_done" | "purchased") => {
    if (!mine || busy) return;
    setBusy(true);
    const r = await actions.setFulfillment(mine.id, to);
    setBusy(false);
    onClose();
    // 購入と受取が分かれている抽選は、ダイアログで確認してから確定する（通常のUndo猶予は設けない）
    toast.show(r.ok ? { message: to === "purchased" ? "受取済みとして記録しました" : "購入を記録しました" } : { message: r.error, tone: "error" });
  };

  return (
    <>
      <Dialog open={dialog?.kind === "confirm"} onOpenChange={(o) => !o && onClose()}>
        <DialogContent>
          <DialogTitle>発表前ですが結果を記録しますか？</DialogTitle>
          <DialogDescription>この抽選はまだ発表日前です。{dialog?.op === "result_won" ? "当選" : "落選"}として記録します。</DialogDescription>
          <div className="mt-4 flex justify-end gap-2">
            <DialogClose asChild>
              <Button variant="outline">キャンセル</Button>
            </DialogClose>
            <Button onClick={() => dialog?.op && onRun(dialog.op)} data-testid="swipe-confirm">
              記録する
            </Button>
          </div>
        </DialogContent>
      </Dialog>
      <Dialog open={dialog?.kind === "choose-item"} onOpenChange={(o) => !o && onClose()}>
        <DialogContent>
          <DialogTitle>応募する商品を選択</DialogTitle>
          <DialogDescription>希望の1つを選んで応募します。{profile.label}の応募として記録されます。</DialogDescription>
          <ul className="mt-3 space-y-1.5">
            {lottery.items.map((it) => (
              <li key={it.id}>
                <Button variant="outline" className="w-full justify-start" onClick={() => it.id && onRun("mark_applied", { itemId: it.id })}>
                  {formatItem(it, data.products.find((p) => p.id === it.productId))}
                </Button>
              </li>
            ))}
          </ul>
        </DialogContent>
      </Dialog>
      {dialog?.kind === "choose-items" && <ItemPickerDialog lottery={lottery} onClose={onClose} onSubmit={(ids) => onRun("mark_applied", { itemIds: ids })} />}
      {dialog?.kind === "choose-store" && <AppliedStoreDialog lottery={lottery} confirmLabel="応募済みにする" onClose={onClose} onSubmit={(store) => onRun("mark_applied", { store })} />}
      <Dialog open={dialog?.kind === "choose-fulfillment"} onOpenChange={(o) => !o && onClose()}>
        <DialogContent>
          <DialogTitle>何を記録しますか？</DialogTitle>
          <DialogDescription>この抽選は購入手続きと受取が分かれています。{profile.label}の分を記録します（この操作は確認後に確定し、スワイプでは元に戻せません）。</DialogDescription>
          <div className="mt-4 flex flex-col gap-2">
            {mine?.fulfillment === "none" && (
              <Button variant="outline" disabled={busy} onClick={() => void record("procedure_done")} data-testid="swipe-record-purchase">
                購入を記録
              </Button>
            )}
            <Button disabled={busy} onClick={() => void record("purchased")} data-testid="swipe-record-receive">
              受取を記録
            </Button>
            <DialogClose asChild>
              <Button variant="outline">キャンセル</Button>
            </DialogClose>
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}
