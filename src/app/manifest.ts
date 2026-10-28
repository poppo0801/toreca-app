import type { MetadataRoute } from "next";
import { APP_DESCRIPTION, APP_NAME, APP_SUBTITLE } from "@/lib/brand";

/** PWA（iPhoneはホーム画面に追加すると Web Push を受け取れる） */
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: `${APP_NAME} ${APP_SUBTITLE}`,
    short_name: APP_NAME,
    description: APP_DESCRIPTION,
    start_url: "/lotteries",
    scope: "/",
    display: "standalone",
    orientation: "portrait",
    background_color: "#111113",
    theme_color: "#111113",
    lang: "ja",
    icons: [
      { src: "/icons/icon-192.png", sizes: "192x192", type: "image/png" },
      { src: "/icons/icon-512.png", sizes: "512x512", type: "image/png" },
      { src: "/icons/maskable-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
    ],
  };
}
