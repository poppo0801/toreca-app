/**
 * アプリ内のスクロール領域（AppShell の main。ページ全体ではなくここだけがスクロールする）。
 * AppShell の外（ログイン画面など）ではページ全体がスクロールするので、無ければ window を使う。
 */
export const appScroller = (): HTMLElement | null => (typeof document === "undefined" ? null : document.getElementById("app-scroll"));
export const scrollTopOf = (): number => appScroller()?.scrollTop ?? (typeof window === "undefined" ? 0 : window.scrollY);
export const scrollToTop = (top: number): void => {
  const el = appScroller();
  if (el) el.scrollTo({ top });
  else window.scrollTo({ top });
};
