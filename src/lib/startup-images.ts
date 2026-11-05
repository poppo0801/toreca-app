/**
 * iPhone のホーム画面アプリの起動画面（apple-touch-startup-image）の一覧。画像は scripts/build-startup-images.mjs で生成する（public/startup/）。
 * iOS は機種の画面サイズ・密度・向き・（ライト/ダーク）の media 条件が一致した画像だけを使う。一致しない機種では何も起きない（従来どおり）。
 * 起動画面は「ホーム画面に追加した時点」で端末が保存することが多い。既にインストール済みの場合は、いったん削除して追加し直すと反映される。
 */
export const STARTUP_DEVICES: readonly (readonly [number, number, number])[] = [
  [440, 956, 3],
  [402, 874, 3],
  [430, 932, 3],
  [393, 852, 3],
  [428, 926, 3],
  [390, 844, 3],
  [375, 812, 3],
  [414, 896, 3],
  [414, 896, 2],
  [414, 736, 3],
  [375, 667, 2],
];

export function startupImages(): { url: string; media: string }[] {
  return STARTUP_DEVICES.flatMap(([w, h, ratio]) =>
    (["light", "dark"] as const).map((scheme) => ({
      url: `/startup/${w * ratio}x${h * ratio}-${scheme}.png`,
      media: `screen and (device-width: ${w}px) and (device-height: ${h}px) and (-webkit-device-pixel-ratio: ${ratio}) and (orientation: portrait) and (prefers-color-scheme: ${scheme})`,
    })),
  );
}
