"use client";

import { usePathname } from "next/navigation";

/**
 * 設定の下のページへ移るときだけ、右からスライドして入る短いアニメーション（約0.2秒。動きを減らす設定ではほぼ無効）。
 * template は移動のたびに作り直されるので、各ページで毎回再生される。設定の一覧自体は動かさない。
 */
export default function SettingsTemplate({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  return <div className={pathname === "/settings" ? undefined : "animate-[slide-in-right_0.2s_ease-out]"}>{children}</div>;
}
