"use client";

import { useEffect, useState } from "react";
import { loadExpansionMarksAction } from "@/app/(app)/market-memo/master-actions";
import type { ExpansionMark } from "@/lib/zukan/expansion";

let cache: ExpansionMark[] | null = null;
let inflight: Promise<ExpansionMark[]> | null = null;

/** 収録パックマスター（番号の候補・収録セットの自動補完）。参照データなのでアプリ全体で1回だけ読み込んで使い回す。読み込めなければ空（自由入力はそのまま使える） */
export function useExpansionMasters(): ExpansionMark[] {
  const [marks, setMarks] = useState<ExpansionMark[]>(cache ?? []);
  useEffect(() => {
    if (cache) return;
    let live = true;
    inflight ??= loadExpansionMarksAction()
      .then((r) => {
        if (r.ok) cache = r.marks;
        return r.ok ? r.marks : [];
      })
      .catch(() => [])
      .finally(() => {
        inflight = null;
      });
    void inflight.then((m) => {
      if (live && m.length) setMarks(m);
    });
    return () => {
      live = false;
    };
  }, []);
  return marks;
}
