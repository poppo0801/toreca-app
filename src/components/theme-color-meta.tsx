"use client";

import { useEffect } from "react";
import { useTheme } from "next-themes";

/** ヘッダーの背景色（globals.css の --header と同じ値）。ステータスバーをこの色に合わせる */
export const THEME_COLORS = { light: "#ffffff", dark: "#17171b" } as const;

const metas = () => Array.from(document.head.querySelectorAll<HTMLMetaElement>('meta[name="theme-color"]'));

/**
 * ホーム画面アプリのステータスバーの色を、端末の設定ではなく「アプリのテーマ（ライト/ダーク）」に合わせる。
 * layout.tsx の themeColor は端末の外観(prefers-color-scheme)で決まる。さらに Next は画面遷移のたびに head の meta を
 * 書き直すため、起動時に一度だけ書き換えても遷移で端末の外観の色に戻る。head の変化を監視して、そのつど合わせ直す。
 * meta は取り除かない（Next の管理する要素を消すと画面遷移が壊れる）。content だけを、両方同じ色にする。
 */
export function ThemeColorMeta() {
  const { resolvedTheme } = useTheme();
  useEffect(() => {
    if (!resolvedTheme) return;
    const color = resolvedTheme === "dark" ? THEME_COLORS.dark : THEME_COLORS.light;
    const apply = () => {
      for (const m of metas()) if (m.content !== color) m.content = color; // 同じ値なら書かない（監視の連鎖を防ぐ）
    };
    apply();
    const obs = new MutationObserver(apply);
    obs.observe(document.head, { childList: true, subtree: true, attributes: true, attributeFilter: ["content", "name", "media"] });
    return () => obs.disconnect();
  }, [resolvedTheme]);
  return null;
}
