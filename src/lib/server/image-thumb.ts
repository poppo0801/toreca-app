import sharp from "sharp";

/** 一覧・カードに出す商品画像の高さ(約96px)の3倍。高解像度の画面でもにじまない大きさ */
export const THUMB_HEIGHT = 288;

/**
 * 商品画像の一覧用サムネイル（WebP）。縦横比と透明を保つ。元画像は変更しない。
 * 作っても元より小さくならない画像（すでに小さい・軽い）は null（元画像をそのまま使う）。
 */
export async function makeThumb(original: Buffer): Promise<{ buf: Buffer; width: number; height: number } | null> {
  const out = await sharp(original, { limitInputPixels: 80_000_000 })
    .rotate()
    .resize({ height: THUMB_HEIGHT, withoutEnlargement: true })
    .webp({ quality: 82, alphaQuality: 90, effort: 4 })
    .toBuffer({ resolveWithObject: true });
  if (out.data.length >= original.length) return null;
  return { buf: out.data, width: out.info.width, height: out.info.height };
}
