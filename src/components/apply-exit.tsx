"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";

/** 応募完了カードを残しておく時間と、退場アニメーションの長さ */
export const EXIT_WAIT_MS = 2500;
export const EXIT_ANIM_MS = 300;

/** hold=保存中（カードを残す）/ wait=応募済みを2.5秒見せる / leaving=退場アニメーション */
export type ExitPhase = "hold" | "wait" | "leaving";

export interface ApplyExitApi {
  /** 応募の保存を始める直前に呼ぶ。保存中にカードが一覧から消えてちらつかないよう、先に残しておく */
  hold: (lotteryId: string) => void;
  /** 保存に失敗したら、残していたカードを通常の表示に戻す */
  release: (lotteryId: string) => void;
  /** 応募の保存に成功した直後に呼ぶ。条件が合えば、一定時間後にカードを退場させる */
  onApplied: (lotteryId: string, profileId: string) => void;
  /** 応募の解除に成功したら、退場をキャンセルする */
  onUnapplied: (lotteryId: string) => void;
}

const Ctx = createContext<ApplyExitApi | null>(null);
export const ApplyExitProvider = Ctx.Provider;
export const useApplyExit = () => useContext(Ctx);

const prefersReducedMotion = () => typeof window !== "undefined" && typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;

/**
 * 退場待ちのカードを管理する。
 * - 応募成功 → 2.5秒そのまま表示 → 右へスライド＋フェードアウト（約0.3秒、高さも縮む）→ 一覧から外れる
 * - 待機中に応募を解除したら退場をキャンセル
 * - プロフィール・タブ・フィルター・表示形式が変わったら、待たずにすべて破棄して最新の結果を表示（古いタイマーは残さない）
 */
export function useApplyExitController({ enabled, resetKey }: { enabled: boolean; resetKey: string }) {
  const [phases, setPhases] = useState<Record<string, ExitPhase>>({});
  const timers = useRef(new Map<string, number[]>());
  // 応募したプロフィールを記録し、別プロフィールに切り替わった後のタイマーが効かないようにする
  const keyRef = useRef(resetKey);

  const clearOne = useCallback((id: string) => {
    for (const t of timers.current.get(id) ?? []) window.clearTimeout(t);
    timers.current.delete(id);
  }, []);
  const clearAll = useCallback(() => {
    for (const id of [...timers.current.keys()]) clearOne(id);
    setPhases({});
  }, [clearOne]);

  useEffect(() => {
    keyRef.current = resetKey;
    clearAll();
  }, [resetKey, clearAll]);
  useEffect(() => () => {
    for (const list of timers.current.values()) for (const t of list) window.clearTimeout(t);
    timers.current.clear();
  }, []);

  const enabledRef = useRef(enabled);
  useEffect(() => {
    enabledRef.current = enabled;
  }, [enabled]);

  const api = useMemo<ApplyExitApi>(
    () => ({
      hold: (id) => {
        if (!enabledRef.current) return;
        clearOne(id);
        setPhases((p) => ({ ...p, [id]: "hold" }));
      },
      release: (id) => {
        clearOne(id);
        setPhases((p) => {
          if (!(id in p)) return p;
          const { [id]: _removed, ...rest } = p;
          void _removed;
          return rest;
        });
      },
      onApplied: (id) => {
        if (!enabledRef.current) return;
        const key = keyRef.current;
        clearOne(id); // 連続タップ: 前のタイマーを破棄して数え直す
        setPhases((p) => ({ ...p, [id]: "wait" }));
        const leave = window.setTimeout(() => {
          if (keyRef.current !== key) return;
          setPhases((p) => (p[id] === "wait" ? { ...p, [id]: "leaving" } : p));
          const done = window.setTimeout(
            () => {
              if (keyRef.current !== key) return;
              timers.current.delete(id);
              setPhases((p) => {
                const { [id]: _removed, ...rest } = p;
                void _removed;
                return rest;
              });
            },
            prefersReducedMotion() ? 0 : EXIT_ANIM_MS,
          );
          timers.current.set(id, [done]);
        }, EXIT_WAIT_MS);
        timers.current.set(id, [leave]);
      },
      onUnapplied: (id) => {
        clearOne(id);
        setPhases((p) => {
          if (!(id in p)) return p;
          const { [id]: _removed, ...rest } = p;
          void _removed;
          return rest;
        });
      },
    }),
    [clearOne],
  );

  const keepIds = useMemo(() => new Set(Object.keys(phases)), [phases]);
  return { phases, keepIds, api };
}
