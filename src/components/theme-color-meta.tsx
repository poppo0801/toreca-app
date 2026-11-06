"use client";

import { useEffect } from "react";
import { useTheme } from "next-themes";

/** ヘッダーの背景色（globals.css の --header と同じ値）。ステータスバーをこの色に合わせる */
export const THEME_COLORS = { light: "#ffffff", dark: "#17171b" } as const;

/**
 * ホーム画面アプリのステータスバーの色を、端末の設定ではなく「アプリのテーマ（ライト/ダーク）」に合わせる。
 * layout.tsx の themeColor は端末の外観(prefers-color-scheme)で決まるため、アプリだけライトにしていると
 * ステータスバーが暗いまま残る。Next が管理している meta は取り除かず（画面遷移で壊れる）、content だけを両方同じ色にする。
 */
export function ThemeColorMeta() {
  const { resolvedTheme } = useTheme();
  useEffect(() => {
    if (!resolvedTheme) return;
    const color = resolvedTheme === "dark" ? THEME_COLORS.dark : THEME_COLORS.light;
    for (const m of document.head.querySelectorAll<HTMLMetaElement>('meta[name="theme-color"]')) m.content = color;
  }, [resolvedTheme]);
  return null;
}
