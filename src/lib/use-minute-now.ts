"use client";

import { useEffect, useState } from "react";

/** 1分ごとに更新される現在時刻（画面を開いたまま期限を迎えた表示を更新するため） */
export function useMinuteNow(): Date {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const id = window.setInterval(() => setNow(new Date()), 60_000);
    return () => window.clearInterval(id);
  }, []);
  return now;
}
