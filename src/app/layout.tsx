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
    icon: [
      { url: "/icons/favicon-32.png", sizes: "32x32", type: "image/png" },
      { url: "/icons/favicon-48.png", sizes: "48x48", type: "image/png" },
      { url: "/icons/icon-192.png", sizes: "192x192", type: "image/png" },
    ],
    apple: "/icons/apple-touch-icon.png",
  },
  appleWebApp: { capable: true, title: APP_NAME, statusBarStyle: "black-translucent" },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
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
