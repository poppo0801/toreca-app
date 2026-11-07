"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";

/**
 * カードが今のタブから外れる操作（★・応募・スワイプ）の共通の退出アニメーション。
 *   操作の反応を見せる短い待機 → 横へスライドして画面外へ → 消えたあとに下のカードが上へ詰まる
 * 待機は操作ごとに指定できる（★は短く、スワイプは指で既に動かしているのでごく短い）。
 * スワイプ（slid）は、保存の完了を待たずに、スライドが終わった時点で下のカードを詰め始める（保存の通信の待ち時間で詰める動きの始動が遅れない）。
 * 一覧から外す（カードを消す）のは保存の成功が確認できてから。保存に失敗したら元に戻す。
 */
export const EXIT_WAIT_MS = 600; // 応募済みにした直後の見せ時間
export const EXIT_STAR_WAIT_MS = 320; // ★の反応を見せる時間
export const EXIT_SLIDE_MS = 320;
export const EXIT_COLLAPSE_MS = 280;
/** スワイプでカードが画面外へ出るまでの時間（swipe-card の transition と同じ）。この間は詰め始めない */
export const EXIT_SWIPE_SLIDE_MS = 200;

/** hold=保存中/待機（カードはそのまま）/ sliding=横へスライド / collapsing=高さを詰める */
export type ExitPhase = "hold" | "sliding" | "collapsing";
export type ExitDir = "right" | "left";

export interface BeginOptions {
  /** スライドの向き（既定は右。スワイプでは指の向き） */
  dir?: ExitDir;
  /** 保存の成功後、スライドを始めるまでの最短の時間 */
  waitMs?: number;
  /** カード自身がすでに画面外へ動いている（スワイプ）。スライドを省いて高さを詰める */
  slid?: boolean;
}

export interface ExitHandle {
  /** 保存に成功した。タブから外れていればアニメーションを続け、まだ表示対象なら何もせず戻す */
  ok: () => void;
  /** 保存に失敗した。カードを元の表示に戻す */
  fail: () => void;
}

export interface ApplyExitApi {
  /** 操作の開始（保存の前）に呼ぶ。保存中にカードが一覧から消えてちらつかないよう、先に残す */
  begin: (lotteryId: string, options?: BeginOptions) => ExitHandle;
  /** 応募の解除に成功したら、退出をキャンセルする */
  cancel: (lotteryId: string) => void;
  /** 退出の処理中か（保存後に表示対象のままだった場合は、処理が取り消されて false になる） */
  active: (lotteryId: string) => boolean;
  /**
   * 詳細パネルを開いている間、そのカードを一覧に残す（パネルはカードの一部のため、結果の記録などでカードがタブから外れても閉じない）。
   * 閉じたとき、タブから外れていれば通常の退出アニメーションで見送る
   */
  pin: (lotteryId: string, on: boolean) => void;
}

const Ctx = createContext<ApplyExitApi | null>(null);
export const ApplyExitProvider = Ctx.Provider;
export const useApplyExit = () => useContext(Ctx);

const prefersReducedMotion = () => typeof window !== "undefined" && typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;

interface Entry {
  dir: ExitDir;
  waitDone: boolean;
  settled: boolean;
  slid: boolean;
  /** スワイプ: 保存の完了を待たずに詰め始めた／詰め終わった */
  collapsing: boolean;
  collapsed: boolean;
  timers: number[];
}

/**
 * 退出待ちのカードを管理する。
 * - 保存の成功 と 待機の経過 がそろったら、(表示対象から外れていれば) スライド → 詰める → 一覧から外す
 * - 保存に失敗したら、待たずに元の表示へ戻す。プロフィール・タブ・フィルター・表示形式が変わったら、すべて破棄して最新の結果を表示する
 * - isShown: 保存後のデータで、そのカードが今のタブに残るか（残るなら退出しない）
 */
export function useApplyExitController({ enabled, resetKey, isShown }: { enabled: boolean; resetKey: string; isShown: (id: string) => boolean }) {
  const [phases, setPhases] = useState<Record<string, ExitPhase>>({});
  const [dirs, setDirs] = useState<Record<string, ExitDir>>({});
  const [pinned, setPinned] = useState<ReadonlySet<string>>(new Set());
  const entries = useRef(new Map<string, Entry>());
  const keyRef = useRef(resetKey);
  const shownRef = useRef(isShown);
  const enabledRef = useRef(enabled);
  useEffect(() => {
    shownRef.current = isShown;
    enabledRef.current = enabled;
  });

  const drop = useCallback((id: string) => {
    const e = entries.current.get(id);
    if (e) for (const t of e.timers) window.clearTimeout(t);
    entries.current.delete(id);
    setPhases((p) => {
      if (!(id in p)) return p;
      const { [id]: _removed, ...rest } = p;
      void _removed;
      return rest;
    });
  }, []);
  const clearAll = useCallback(() => {
    for (const id of [...entries.current.keys()]) {
      const e = entries.current.get(id);
      if (e) for (const t of e.timers) window.clearTimeout(t);
    }
    entries.current.clear();
    setPhases({});
  }, []);

  useEffect(() => {
    keyRef.current = resetKey;
    clearAll();
  }, [resetKey, clearAll]);
  useEffect(
    () => () => {
      for (const e of entries.current.values()) for (const t of e.timers) window.clearTimeout(t);
      entries.current.clear();
    },
    [],
  );

  const api = useMemo<ApplyExitApi>(() => {
    const advance = (id: string, entry: Entry, key: string) => {
      if (entries.current.get(id) !== entry || keyRef.current !== key) return;
      if (!entry.waitDone) return;
      const reduced = prefersReducedMotion();
      if (entry.slid && !entry.collapsing) {
        // スワイプ: カードはもう画面外。保存の完了を待たずに下のカードを詰め始める
        entry.collapsing = true;
        setPhases((p) => (p[id] ? { ...p, [id]: "collapsing" } : p));
        entry.timers.push(
          window.setTimeout(() => {
            if (entries.current.get(id) !== entry || keyRef.current !== key) return;
            entry.collapsed = true;
            advance(id, entry, key);
          }, reduced ? 0 : EXIT_COLLAPSE_MS),
        );
      }
      if (!entry.settled) return;
      if (entry.slid && !entry.collapsed) return; // 詰め終わったら、もう一度ここへ来る
      // 保存後のデータが画面に反映されるのを待って、まだ表示対象なら退出しない
      entry.timers.push(
        window.setTimeout(() => {
          if (entries.current.get(id) !== entry || keyRef.current !== key) return;
          if (shownRef.current(id)) return drop(id);
          if (entry.slid) return drop(id);
          const collapse = () => {
            setPhases((p) => (p[id] ? { ...p, [id]: "collapsing" } : p));
            entry.timers.push(window.setTimeout(() => entries.current.get(id) === entry && drop(id), reduced ? 0 : EXIT_COLLAPSE_MS));
          };
          if (reduced) return collapse();
          setPhases((p) => (p[id] ? { ...p, [id]: "sliding" } : p));
          entry.timers.push(window.setTimeout(collapse, EXIT_SLIDE_MS));
        }, entry.slid ? 0 : 60),
      );
    };
    return {
      begin: (id, options = {}) => {
        if (!enabledRef.current) return { ok: () => undefined, fail: () => undefined };
        drop(id); // 連続操作: 前の退出は破棄して数え直す
        const key = keyRef.current;
        const entry: Entry = { dir: options.dir ?? "right", waitDone: false, settled: false, slid: !!options.slid, collapsing: false, collapsed: false, timers: [] };
        entries.current.set(id, entry);
        setPhases((p) => ({ ...p, [id]: "hold" }));
        setDirs((d) => ({ ...d, [id]: entry.dir }));
        const wait = prefersReducedMotion() ? 0 : (options.waitMs ?? EXIT_WAIT_MS);
        entry.timers.push(
          window.setTimeout(() => {
            entry.waitDone = true;
            advance(id, entry, key);
          }, wait),
        );
        return {
          ok: () => {
            entry.settled = true;
            advance(id, entry, key);
          },
          fail: () => {
            if (entries.current.get(id) === entry) drop(id);
          },
        };
      },
      cancel: (id) => drop(id),
      active: (id) => entries.current.has(id),
      pin: (id, on) => {
        setPinned((p) => {
          if (p.has(id) === on) return p;
          const n = new Set(p);
          if (on) n.add(id);
          else n.delete(id);
          return n;
        });
        // 閉じたとき、まだ表示対象ならそのまま、外れていれば退出アニメーション（待機なし）
        if (!on) {
          const h = (api as ApplyExitApi).begin(id, { waitMs: 0 });
          h.ok();
        }
      },
    };
  }, [drop]);

  const keepIds = useMemo(() => new Set([...Object.keys(phases), ...pinned]), [phases, pinned]);
  return { phases, dirs, keepIds, api };
}
