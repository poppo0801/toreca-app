import type { MetadataRoute } from "next";

/** PWA（iPhoneはホーム画面に追加すると Web Push を受け取れる） */
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "トレカ抽選管理",
    short_name: "トレカ抽選",
    description: "トレーディングカードの抽選応募・当落・購入を家族で管理",
    start_url: "/lotteries",
    scope: "/",
    display: "standalone",
    orientation: "portrait",
    background_color: "#0b0b0b",
    theme_color: "#0b0b0b",
    lang: "ja",
    icons: [
      { src: "/icons/icon-192.png", sizes: "192x192", type: "image/png" },
      { src: "/icons/icon-512.png", sizes: "512x512", type: "image/png" },
      { src: "/icons/maskable-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
    ],
  };
}
