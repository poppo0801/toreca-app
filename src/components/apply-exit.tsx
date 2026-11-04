"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";

/**
 * 応募完了カードを残しておく時間と、退場アニメーションの長さ。目で追える速さにする:
 *   応募済みの表示を保持（1秒）→ 右へスライドしながらフェードアウト（0.55秒。幅の6割ほど動いた時点で完全に透明）→ 消えてから一覧を詰める（0.35秒）
 */
export const EXIT_WAIT_MS = 1000;
export const EXIT_SLIDE_MS = 550;
export const EXIT_COLLAPSE_MS = 350;

/** hold=保存中（カードを残す）/ wait=応募済みを見せる / sliding=右へスライド＋フェード / collapsing=高さを詰める */
export type ExitPhase = "hold" | "wait" | "sliding" | "collapsing";

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
 * - 応募成功 → 1秒そのまま表示 → 右へスライド＋フェードアウト（高さは変えない）→ 消えたあとに一覧を詰める → 一覧から外れる
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
        const reduced = prefersReducedMotion();
        const leave = window.setTimeout(() => {
          if (keyRef.current !== key) return;
          setPhases((p) => (p[id] === "wait" ? { ...p, [id]: "sliding" } : p));
          const collapse = window.setTimeout(
            () => {
              if (keyRef.current !== key) return;
              setPhases((p) => (p[id] === "sliding" ? { ...p, [id]: "collapsing" } : p));
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
                reduced ? 0 : EXIT_COLLAPSE_MS,
              );
              timers.current.set(id, [done]);
            },
            reduced ? 0 : EXIT_SLIDE_MS,
          );
          timers.current.set(id, [collapse]);
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
