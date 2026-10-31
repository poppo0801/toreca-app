import type { Metadata, Viewport } from "next";
import { ThemeProvider } from "next-themes";
import { APP_DESCRIPTION, APP_NAME, APP_SUBTITLE } from "@/lib/brand";
import "./globals.css";

export const metadata: Metadata = {
  title: { default: `${APP_NAME} ${APP_SUBTITLE}`, template: `%s | ${APP_NAME}` },
  applicationName: APP_NAME,
  description: APP_DESCRIPTION,
  robots: { index: false, follow: false },
  icons: {
    // 原本 public/icons/toremane_icon.jpg から scripts/build-icons.mjs で生成（v2/ は旧アイコンのキャッシュを避けるための場所）
    icon: [
      { url: "/icons/v2/favicon-16.png", sizes: "16x16", type: "image/png" },
      { url: "/icons/v2/favicon-32.png", sizes: "32x32", type: "image/png" },
      { url: "/icons/v2/favicon-48.png", sizes: "48x48", type: "image/png" },
      { url: "/icons/v2/icon-192.png", sizes: "192x192", type: "image/png" },
    ],
    apple: { url: "/icons/v2/apple-touch-icon.png", sizes: "180x180", type: "image/png" },
  },
  appleWebApp: { capable: true, title: APP_NAME, statusBarStyle: "black-translucent" },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  // 入力欄(文字サイズ16px未満)をタップしたときの iOS の自動拡大を抑える。ピンチ拡大も効かなくなる（アクセシビリティ上の制約: docs/stage5j.md）
  maximumScale: 1,
  userScalable: false,
  // Safe Area(env(safe-area-inset-*))を有効にする。ヘッダー・下部ナビが各自で余白を取る
  viewportFit: "cover",
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#ffffff" },
    { media: "(prefers-color-scheme: dark)", color: "#161619" },
  ],
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="ja" suppressHydrationWarning>
      <body>
        <ThemeProvider attribute="class" defaultTheme="system" enableSystem disableTransitionOnChange>
          {children}
        </ThemeProvider>
      </body>
    </html>
  );
}
