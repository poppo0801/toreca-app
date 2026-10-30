import type { NextConfig } from "next";

const securityHeaders = [
  { key: "X-Frame-Options", value: "DENY" },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" },
  { key: "Strict-Transport-Security", value: "max-age=63072000; includeSubDomains" },
  { key: "X-Robots-Tag", value: "noindex, nofollow" },
];

const nextConfig: NextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  // Excel入出力(exceljs)はサーバーで動かす。バンドルせず外部パッケージとして読む
  serverExternalPackages: ["exceljs"],
  // 商品画像のアップロード(Server Action)は最大3MBまで受け付ける。既定の1MBでは、写真を選ぶと本文超過になる
  experimental: { serverActions: { bodySizeLimit: "4mb" } },
  async headers() {
    return [
      { source: "/:path*", headers: securityHeaders },
      // Service Worker は常に最新を取得させる（更新が反映されない事故を防ぐ）
      {
        source: "/sw.js",
        headers: [
          { key: "Cache-Control", value: "no-cache, no-store, must-revalidate" },
          { key: "Content-Type", value: "application/javascript; charset=utf-8" },
          { key: "Service-Worker-Allowed", value: "/" },
        ],
      },
      // APIの応答はキャッシュさせない（商品画像の配信だけは、内容ハッシュ入りURLで長期キャッシュさせるため除く。認証は配信側で行う）
      { source: "/api/:path((?!product-image/).*)", headers: [{ key: "Cache-Control", value: "no-store" }] },
    ];
  },
};

export default nextConfig;
